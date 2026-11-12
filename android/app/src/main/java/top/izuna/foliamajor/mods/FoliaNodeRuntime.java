// 当前文件：Folia 安卓端的 Node 运行时桥（nodejs-mobile 移植）。
//
// 为什么安卓要有 Node：Folium 模组系统分两半 —— 渲染端的 client 入口，和主进程的 main 入口。
// 桌面端由 Electron 主进程提供后者；安卓没有主进程，所以模组带 Node 入口（`main`）的那些
// （例如 mod-market 的 catalog 抓取与下载校验）根本跑不起来。这里补上这一半：
// 进程内跑一个真的 Node（nodejs-mobile，Node 18.20.4），让模组的 main 入口能 require
// fs/path/crypto、能用 fetch。
//
// 三层结构：
//   · libnode.so —— nodejs-mobile 预编译的 Node，arm64-v8a（cpp/libnode/）。
//   · libfolia-node-native.so —— 本文件 + node-bridge.cpp：起 Node 线程、注册原生模块、
//     并提供一条 Java↔Node 的消息通道。
//   · assets/folia-node/ —— 随包带走的 JS 宿主脚本（模组加载器），由 Node 跑。
//
// 与 Mineradio 那套的差别：那套让 Node 起一个 HTTP 服务给 WebView 用；这里 Node 只做模组宿主，
// 不对外开端口 —— 渲染端与它之间的通道是本文件的消息通道（走 Capacitor 插件）。

package top.izuna.foliamajor.mods;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 进程内的 Node 运行时。
 *
 * 生命周期：App 起来时 {@link #start} 一次，Node 在自己的线程里跑，进程活着就一直活着。
 * 模组的 main 入口在这个 Node 里加载、激活；渲染端通过 {@link FoliaModsPlugin} 问它。
 */
public final class FoliaNodeRuntime {

    private static final String TAG = "FoliaNode";

    /** 随包带走的 JS 宿主脚本目录（assets/folia-node/）。 */
    private static final String HOST_ASSETS = "folia-node";

    /** 复制到 filesDir 后，Node 里的工作目录。 */
    private static final String HOST_DIR = "folia-node";

    /** 模组们自己的东西：userData/mods、userData/mods-data、userData/mods-cache。 */
    private static final String USER_DATA_DIR = "folia-userdata";

    /** 设备指标的采集间隔。模组的性能卡片刷新在秒级，1 秒足够、也不会让 /proc 读得太频繁。 */
    private static final long METRICS_INTERVAL_MS = 1000;

    private static final Object METRICS_LOCK = new Object();
    private static boolean metricsStarted = false;
    /** 采集要用 Context（电池两项走系统广播），start 时留下。 */
    private static Context appContextRef = null;

    private static final Object LOCK = new Object();
    private static boolean started = false;
    private static boolean ready = false;
    private static String failure = null;

    /*
     * 先 libnode 再桥接库，顺序不能反。
     *
     * libfolia-node-native.so 链接了 libnode.so，而 libnode 自己又依赖 libc++_shared.so；
     * 直接 loadLibrary("folia-node-native") 时，系统的依赖解析在部分机型上找不到
     * libnode（它不是普通 JNI 库，是按 IMPORTED_LOCATION 打进包里的），
     * 于是 nativeStart 变成 "No implementation found"。
     * 显式先把 node 装进来，依赖就已经在进程里了。
     */
    static {
        System.loadLibrary("node");
        System.loadLibrary("folia-node-native");
    }

    /** Node 线程发回来的消息（模组日志、rpc 回话、状态变化）。 */
    private static final CopyOnWriteArrayList<MessageListener> listeners = new CopyOnWriteArrayList<>();

    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** 一条从 Node 那边过来的消息。 */
    public interface MessageListener {
        /** @param channel 通道名，见 node-bridge.cpp 里注册的通道。 @param payload JSON 文本。 */
        void onNodeMessage(String channel, String payload);
    }

    private FoliaNodeRuntime() {
    }

    /**
     * 起 Node。重复调用只生效一次。
     *
     * @param context 应用上下文
     * @param onReady Node 起来并加载完宿主脚本后回调（在主线程）
     */
    public static void start(Context context, Runnable onReady) {
        synchronized (LOCK) {
            if (started) {
                if (ready && onReady != null) mainHandler.post(onReady);
                return;
            }
            started = true;
        }

        final Context appContext = context.getApplicationContext();
        appContextRef = appContext;
        final File filesDir = appContext.getFilesDir();

        // Node 的家目录：放在 filesDir 下，HomeActivity 用同一个。
        final File hostDir = new File(filesDir, HOST_DIR);
        final File userDataDir = resolveUserDataDir(appContext);

        try {
            copyAssets(appContext, HOST_ASSETS, hostDir);
        } catch (IOException error) {
            fail("复制宿主脚本失败", error);
            return;
        }

        /*
         * 内置模组落成真实目录，必须赶在 Node 宿主扫描之前 —— 扫描只看模组根目录。
         */
        installBuiltinMods(appContext, userDataDir);

        // Android 上 /tmp 不可写（os.tmpdir() 默认给 /tmp），Node 自己会踩到。
        // 把它指到 cacheDir，与 Mineradio 那套（start.js 里 monkey-patch os.tmpdir）同一处理由。
        final File cacheDir = appContext.getCacheDir();
        System.setProperty("TMPDIR", cacheDir.getAbsolutePath());

        /*
         * 告诉 Node 宿主这个构建带不带 ffmpeg。
         *
         * Node 进程是进程内的，setenv 要在 nativeStart 之前生效；POSIX 下
         * System.setProperty 不会进环境变量，所以显式用 android.system.Os.setenv。
         * 能力来自 build.gradle 里那条 ffmpeg-kit-full 依赖：能加载到 FFmpegKit 类就说明带了。
         */
        applyFfmpegEnvironment();

        Thread nodeThread = new Thread(() -> {
            try {
                nativeStart(
                        new File(hostDir, "host.js").getAbsolutePath(),
                        hostDir.getAbsolutePath(),
                        userDataDir.getAbsolutePath(),
                        cacheDir.getAbsolutePath());
            } catch (Throwable error) {
                fail("Node 线程异常退出", error);
            }
        }, "folia-node");
        nodeThread.setDaemon(false);
        nodeThread.start();

        // Node 起来后会调 notifyReady。
        pendingReadyCallbacks.add(onReady);
    }

    /**
     * 把 ffmpeg 能力写进本进程的环境变量，供 Node 宿主读取。
     *
     * 能力判断很轻：能反射到 FFmpegKit 就说明这个 APK 带了 ffmpeg-kit-full。
     * Node 的 process.env 是启动时从环境里抓的，所以必须在 nativeStart 之前设。
     * 设置失败不影响模组系统本身 —— 只是状态显示为「没有 ffmpeg」。
     */
    private static void applyFfmpegEnvironment() {
        boolean available;
        String version = null;
        try {
            Class<?> kit = Class.forName("com.arthenica.ffmpegkit.FFmpegKitConfig");
            available = kit != null;
            // 版本串只用于显示，取不到就留空。
            version = "8.1.9";
        } catch (Throwable missing) {
            available = false;
        }
        setEnv("FOLIA_FFMPEG_AVAILABLE", available ? "1" : "0");
        if (version != null) setEnv("FOLIA_FFMPEG_VERSION", version);
        Log.i(TAG, "ffmpeg 能力：" + (available ? "内置 ffmpeg-kit " + version : "未内置"));
    }

    /** 设环境变量（android.system.Os 从 API 21 起可用，失败只记日志）。 */
    private static void setEnv(String key, String value) {
        try {
            android.system.Os.setenv(key, value, true);
        } catch (Throwable error) {
            Log.w(TAG, "设置环境变量 " + key + " 失败", error);
        }
    }

    /** 起不来时统一走这里：记下原因、打日志，并把还在等的 onReady 丢掉。 */
    private static void fail(String message, Throwable error) {
        String reason = error == null ? message : message + ": " + error.getMessage();
        synchronized (LOCK) {
            ready = false;
            failure = reason;
        }
        Log.e(TAG, reason, error);
        pendingReadyCallbacks.clear();
    }

    private static final CopyOnWriteArrayList<Runnable> pendingReadyCallbacks = new CopyOnWriteArrayList<>();

    /** Node 侧调用：宿主脚本已经加载完。 */
    private static void notifyReady() {
        synchronized (LOCK) {
            ready = true;
            failure = null;
        }
        for (Runnable callback : pendingReadyCallbacks) {
            if (callback != null) mainHandler.post(callback);
        }
        pendingReadyCallbacks.clear();
        Log.i(TAG, "Node 运行时已就绪");
        startDeviceMetricsPump();
    }

    /**
     * 定期把设备指标推给 Node 宿主（它那边的 `app.getAppMetrics()` 和温度都靠这份缓存）。
     *
     * 桌面端这两个数字由 Electron 直接给；安卓没有，只能从内核读，而读绝对是异步的、
     * Node 侧取用又是同步的 —— 所以用「持续推、随时取最新」而不是「按需拉」。
     * CPU 占用本来就是两次采样的差分，第一次只会是 0，这也是提前开跑的原因。
     */
    private static void startDeviceMetricsPump() {
        synchronized (METRICS_LOCK) {
            if (metricsStarted) return;
            metricsStarted = true;
        }
        final Context context = appContextRef;
        if (context == null) return;
        final Runnable tick = new Runnable() {
            @Override
            public void run() {
                try {
                    if (isReady()) {
                        sendToNode("device-metrics", DeviceMetrics.snapshot(context).toString());
                    }
                } catch (Throwable error) {
                    Log.w(TAG, "推送设备指标失败", error);
                }
                mainHandler.postDelayed(this, METRICS_INTERVAL_MS);
            }
        };
        // 先立刻推一份（CPU 占用会是 0，但温度和内存是真实值），让界面马上有数。
        mainHandler.post(tick);
    }

    /** Node 侧调用：起不来了。 */
    private static void notifyFailure(String reason) {
        synchronized (LOCK) {
            ready = false;
            failure = reason;
        }
        Log.e(TAG, "Node 运行时失败：" + reason);
    }

    /** Node 起来了没有。 */
    public static boolean isReady() {
        synchronized (LOCK) {
            return ready;
        }
    }

    /** 起不来的原因；null 表示没失败。 */
    public static String getFailure() {
        synchronized (LOCK) {
            return failure;
        }
    }

    /** 模组的 userData 根目录（mods / mods-data / mods-cache 都在它下面）。 */
    public static File getUserDataDir(Context context) {
        return resolveUserDataDir(context);
    }

    /**
     * 解出 userData 根目录：**优先外部 files 目录**，让用户能用文件管理器看到并直接改模组。
     *
     * 为什么是 `getExternalFilesDir`：它是应用自己的外部目录
     * （`/sdcard/Android/data/<包名>/files/...`），写入不需要任何运行时权限，
     * 卸载时随应用一起清掉，也不用担心 `getExternalFilesDir` 在个别机型上返回 null。
     *
     * 为什么不直接用 `Environment.getExternalStorageDirectory()`：那要 MANAGE_EXTERNAL_STORAGE，
     * 而且和系统媒体库混在一起。用户要的是「能读到」，不是「塞满公共目录」。
     *
     * 外部目录不可用（少数机型未挂载 / 权限异常）时退回内部 filesDir：宁可用户看不到，
     * 也不能让模组系统整个起不来。
     */
    private static File resolveUserDataDir(Context context) {
        try {
            File external = context.getExternalFilesDir(null);
            if (external != null) {
                File dir = new File(external, USER_DATA_DIR);
                if (dir.isDirectory() || dir.mkdirs()) return dir;
            }
        } catch (Throwable error) {
            Log.w(TAG, "外部目录不可用，退回内部目录", error);
        }
        return new File(context.getFilesDir(), USER_DATA_DIR);
    }

    /**
     * 把一条消息从 Node 送到 Java 侧。
     *
     * 由 native-bridge.cpp 在 Node 的线程上调用；这里转到主线程再交给监听者，
     * 免得监听者（在 Capacitor 插件里）碰到线程问题。
     */
    static void dispatchFromNode(String channel, String payload) {
        mainHandler.post(() -> {
            for (MessageListener listener : listeners) {
                try {
                    listener.onNodeMessage(channel, payload);
                } catch (Throwable error) {
                    Log.w(TAG, "一个 Node 消息监听者抛了：" + error);
                }
            }
        });
    }

    /** 订阅 Node 的消息。 */
    public static void addListener(MessageListener listener) {
        listeners.add(listener);
    }

    /** 取消订阅。 */
    public static void removeListener(MessageListener listener) {
        listeners.remove(listener);
    }

    /**
     * 从 Java 往 Node 发一条消息。
     *
     * @param channel 通道名（node-bridge.cpp 里 Node 侧 registerChannel 注册过的）
     * @param payload JSON 文本
     */
    public static void sendToNode(String channel, String payload) {
        nativeSendToNode(channel, payload);
    }

    /* ------------------------------------------------------------- native */

    private static native void nativeStart(String entryPath, String homeDir, String userDataDir, String cacheDir);

    private static native void nativeSendToNode(String channel, String payload);

    private static native String nativeGetDataDir();

    /* -------------------------------------------------------------- assets */

    /** 随包内置模组在 assets 里的位置。 */
    private static final String BUILTIN_MODS_ASSET = "public/mods/builtin";

    /**
     * 启动时把内置模组「解压」到模组根目录。
     *
     * 以前它们是 `/mods/builtin/...` 的同源静态地址，由 ModRouteProcessor 直通 assets，
     * 绕过模组清单 —— 结果就是「读取不出来」：模组面板里看不到、不能卸载、不能改，
     * 用户也没法用文件管理器看。现在改成在启动时把每个内置模组落成
     * `mods/<id>/` 的真实目录，走和用户自装模组完全一样的扫描、校验与加载路径。
     *
     * **只在目标不存在时写**：用户可能已经自己改过 / 升级过同名模组，
     * 每次启动都覆盖会把他的改动冲掉。缺失的才补，存在的一律不动。
     */
    private static void installBuiltinMods(Context context, File userDataDir) {
        try {
            File modsRoot = new File(userDataDir, "mods");
            if (!modsRoot.isDirectory() && !modsRoot.mkdirs()) {
                Log.w(TAG, "建不了模组目录：" + modsRoot);
                return;
            }
            String[] ids = context.getAssets().list(BUILTIN_MODS_ASSET);
            if (ids == null || ids.length == 0) return;
            int installed = 0;
            for (String id : ids) {
                File target = new File(modsRoot, id);
                // 已经有这一份（用户自己装的或上次落的），不覆盖。
                if (new File(target, "mod.json").isFile()) continue;
                try {
                    copyAssetFolder(context, BUILTIN_MODS_ASSET + "/" + id, target);
                    installed += 1;
                } catch (IOException error) {
                    // 一个内置模组落不下来不该拖垮整个模组系统。
                    Log.w(TAG, "内置模组 " + id + " 解压失败", error);
                }
            }
            if (installed > 0) Log.i(TAG, "已解压 " + installed + " 个内置模组到 " + modsRoot);
        } catch (Throwable error) {
            Log.w(TAG, "解压内置模组失败", error);
        }
    }

    /** 把 assets/folia-node/ 复制到 filesDir/folia-node/（已存在且更新则覆盖）。 */
    private static void copyAssets(Context context, String assetPath, File target) throws IOException {
        if (!target.exists() && !target.mkdirs()) {
            throw new IOException("建不了目录：" + target);
        }
        String[] children = context.getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            throw new IOException("assets 里没有 " + assetPath);
        }
        for (String child : children) {
            copyAsset(context, assetPath + "/" + child, new File(target, child));
        }
    }

    private static void copyAsset(Context context, String assetPath, File target) throws IOException {
        // 目录
        try (InputStream probe = context.getAssets().open(assetPath)) {
            probe.read();
        } catch (IOException notAFile) {
            copyAssetFolder(context, assetPath, target);
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("建不了目录：" + parent);
        }
        try (InputStream input = context.getAssets().open(assetPath);
             OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            output.flush();
        }
    }

    private static void copyAssetFolder(Context context, String assetPath, File target) throws IOException {
        String[] children = context.getAssets().list(assetPath);
        if (children == null || children.length == 0) {
            return;
        }
        if (!target.exists() && !target.mkdirs()) {
            throw new IOException("建不了目录：" + target);
        }
        for (String child : children) {
            copyAsset(context, assetPath + "/" + child, new File(target, child));
        }
    }
}
