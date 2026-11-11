// 当前文件：把渲染端与 Node 模组宿主接起来的 Capacitor 插件。
//
// 桌面端的渲染进程只有一个入口能问模组系统：`window.electron.mods`（preload.cjs 里那 22 个
// 方法）。安卓没有 preload，所以这里在原生的 Node 运行时装一条同样的通道：
//
//   渲染端  →  FoliaModsPlugin.call({ op, args })  →  Node（U 线程消息通道）
//   Node    →  FoliaModsPlugin.notifyListeners("modsEvent")  →  渲染端
//
// 插件本身不含业务逻辑，只是转发；所有判断都在 assets/folia-node/host.js 里，
// 与桌面端共用同一份 modSystem/*.cjs。

package top.izuna.foliamajor.mods;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@CapacitorPlugin(name = "FoliaMods")
public class FoliaModsPlugin extends Plugin implements FoliaNodeRuntime.MessageListener {

    private static final String TAG = "FoliaMods";

    /** 请求号 → 还在等的调用。Node 的应答靠它找回对应的 PluginCall。 */
    private static final ConcurrentHashMap<String, PluginCall> PENDING = new ConcurrentHashMap<>();

    private static final AtomicLong SEQ = new AtomicLong(1);

    /** 一个请求最多挂多久。下载 64MB 的包偶尔要慢一点，给足余量。 */
    private static final long REQUEST_TIMEOUT_MS = 180_000L;

    @Override
    public void load() {
        FoliaNodeRuntime.addListener(this);
        FoliaNodeRuntime.start(getContext(), null);
    }

    @Override
    protected void handleOnDestroy() {
        FoliaNodeRuntime.removeListener(this);
    }

    /* ------------------------------------------------------------ 主入口 */

    /**
     * 通用转发：{ op, args } → Node → 结果。
     *
     * 渲染端只用到这一个方法，其余 PluginMethod 都是它的便利包装，
     * 这样 `window.electron.mods` 的每个方法在安卓上都能对上号。
     */
    @PluginMethod
    public void call(PluginCall call) {
        String op = call.getString("op");
        if (op == null || op.isEmpty()) {
            call.reject("op is required");
            return;
        }
        JSObject args = call.getObject("args");
        forward(call, op, args == null ? new JSObject() : args);
    }

    /* -------------------------------------------------------- 便利方法 */

    @PluginMethod
    public void listMods(PluginCall call) {
        forward(call, "list", new JSObject());
    }

    @PluginMethod
    public void reloadMods(PluginCall call) {
        forward(call, "reload", new JSObject());
    }

    @PluginMethod
    public void setModEnabled(PluginCall call) {
        JSObject args = new JSObject();
        args.put("id", call.getString("id", ""));
        args.put("enabled", Boolean.TRUE.equals(call.getBoolean("enabled", Boolean.FALSE)));
        forward(call, "set-enabled", args);
    }

    @PluginMethod
    public void installModFromZip(PluginCall call) {
        String zipPath = call.getString("zipPath", "");
        /*
         * Node 跑在本进程里，但只能读应用私有目录 —— /sdcard、/data/local/tmp 这类
         * 外部路径一律读到空，安装器于是报 install-not-zip。安卓端用户挑文件走的是
         * 系统文件管理器 / 下载目录，所以先替它把包抄进私有目录，再交给 Node。
         */
        String staged = stageZipForNode(zipPath);
        JSObject args = new JSObject();
        args.put("zipPath", staged == null ? zipPath : staged);
        forward(call, "install-zip", args);
    }

    /**
     * 从 `<input type=file>` 拿到的 zip（base64）装模组。
     *
     * WebView 里选出来的 File 没有安卓路径可用（`File.path` 在 Electron 才有，
     * 这里也没有 webUtils），所以渲染层把字节读成 base64 递过来，由原生落盘成真实文件，
     * 再走和「按路径安装」完全一样的流程 —— 校验、监听事件、失败回话都不必重写。
     */
    @PluginMethod
    public void installModFromZipFile(PluginCall call) {
        JSObject result = new JSObject();
        try {
            String name = call.getString("name", "");
            String base64 = call.getString("base64", "");
            if (name == null || name.isEmpty() || base64 == null || base64.isEmpty()) {
                result.put("ok", false);
                result.put("error", "install-empty-file");
                call.resolve(result);
                return;
            }
            byte[] bytes;
            try {
                bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
            } catch (Throwable error) {
                result.put("ok", false);
                result.put("error", "install-corrupt-zip");
                call.resolve(result);
                return;
            }
            if (bytes.length == 0) {
                result.put("ok", false);
                result.put("error", "install-empty-file");
                call.resolve(result);
                return;
            }
            File dataDir = FoliaNodeRuntime.getUserDataDir(getContext());
            if (dataDir == null) {
                result.put("ok", false);
                result.put("error", "mods-directory-unavailable");
                call.resolve(result);
                return;
            }
            File staging = new File(dataDir, "mod-incoming");
            if (!staging.isDirectory() && !staging.mkdirs()) {
                result.put("ok", false);
                result.put("error", "mods-directory-unavailable");
                call.resolve(result);
                return;
            }
            // 只留文件名本身，挡住 `../../` 这类名字。
            String safeName = new File(name).getName();
            File target = new File(staging, safeName);
            OutputStream out = new java.io.FileOutputStream(target);
            try {
                out.write(bytes);
            } finally {
                out.close();
            }
            JSObject args = new JSObject();
            args.put("zipPath", target.getAbsolutePath());
            forward(call, "install-zip", args);
        } catch (Throwable error) {
            Log.w(TAG, "从文件安装模组失败", error);
            result.put("ok", false);
            result.put("error", "install-failed");
            call.resolve(result);
        }
    }

    /**
     * 模组的 `folium.net.fetch`：替它发一次网络请求。
     *
     * 桌面端这件事在主进程做（electron/modSystem/netFetch.cjs），所以不受渲染进程的 CORS
     * 限制；安卓上同一套实现已经在 Node 宿主里了（host.js 的 `net-fetch` → netFetch.cjs），
     * 权限检查、方法白名单、超时和体积上限都在那边，这里只负责转过去。
     */
    @PluginMethod
    public void invokeModNetFetch(PluginCall call) {
        JSObject args = new JSObject();
        args.put("modId", call.getString("modId", ""));
        args.put("url", call.getString("url", ""));
        JSObject init = call.getObject("init");
        args.put("init", init == null ? new JSObject() : init);
        forward(call, "net-fetch", args);
    }

    /**
     * 删除一个模组（模组面板里的「卸载」）。
     *
     * 只允许删模组根目录下的直接子目录，并且要求该目录里确实有 mod.json ——
     * 这样既挡掉 `../` 之类的越权路径，也不会误删用户手放的其它东西。
     * 删完之后让 Node 重新扫描一次，把最新清单回给界面。
     */
    @PluginMethod
    public void deleteMod(PluginCall call) {
        JSObject result = new JSObject();
        String modId = call.getString("modId", "");
        if (modId == null || modId.isEmpty()) {
            result.put("ok", false);
            result.put("error", "mod-not-found");
            call.resolve(result);
            return;
        }
        try {
            File dataDir = FoliaNodeRuntime.getUserDataDir(getContext());
            if (dataDir == null) {
                result.put("ok", false);
                result.put("error", "mods-directory-unavailable");
                call.resolve(result);
                return;
            }
            File modsRoot = new File(dataDir, "mods");
            File target = new File(modsRoot, modId);
            // 必须是根目录的直接子目录（canonicalPath 前缀比对，`..` 逃不出去）。
            String rootCanonical = modsRoot.getCanonicalPath();
            String targetCanonical = target.getCanonicalPath();
            boolean inside = targetCanonical.startsWith(rootCanonical + File.separator)
                    && !targetCanonical.substring(rootCanonical.length() + 1).contains(File.separator);
            if (!inside) {
                result.put("ok", false);
                result.put("error", "mod-not-found");
                call.resolve(result);
                return;
            }
            if (!target.isDirectory()) {
                result.put("ok", false);
                result.put("error", "mod-not-found");
                call.resolve(result);
                return;
            }
            // 只删看起来确实是模组的目录。
            if (!new File(target, "mod.json").isFile()) {
                result.put("ok", false);
                result.put("error", "mod-not-found");
                call.resolve(result);
                return;
            }
            deleteRecursively(target);
            Log.i(TAG, "已删除模组：" + modId);

            // 顺手清掉它的数据与缓存（模组卸载后这些已经没人用了）。
            File dataDirOfMod = new File(dataDir, "mods-data");
            File cacheDirOfMod = new File(dataDir, "mods-cache");
            File modData = new File(dataDirOfMod, modId);
            File modCache = new File(cacheDirOfMod, modId);
            if (modData.isDirectory()) deleteRecursively(modData);
            if (modCache.isDirectory()) deleteRecursively(modCache);

            result.put("ok", true);
            call.resolve(result);
        } catch (Throwable error) {
            Log.w(TAG, "删除模组失败：" + modId, error);
            result.put("ok", false);
            result.put("error", "delete-failed");
            call.resolve(result);
        }
    }

    /** 递归删除；失败不抛，尽量删干净。 */
    private static void deleteRecursively(File target) {
        File[] children = target.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) deleteRecursively(child);
                else if (!child.delete()) Log.w(TAG, "删不掉文件：" + child);
            }
        }
        if (!target.delete()) Log.w(TAG, "删不掉目录：" + target);
    }

    /**
     * 把包复制到 Node 读得到的目录；已经在私有目录里的直接原样返回。
     * 复制失败返回 null，交给调用方用原路径（Node 那边会给出明确的错误）。
     */
    private String stageZipForNode(String zipPath) {
        if (zipPath == null || zipPath.isEmpty()) return null;
        try {
            File source = new File(zipPath);
            if (!source.isFile()) return null;
            File dataDir = FoliaNodeRuntime.getUserDataDir(getContext());
            if (dataDir == null) return null;
            // 已在私有目录下：Node 自己能读，不复制。
            String canonical = source.getCanonicalPath();
            if (canonical.startsWith(dataDir.getCanonicalPath() + File.separator)) return canonical;
            File staging = new File(dataDir, "mod-incoming");
            if (!staging.isDirectory() && !staging.mkdirs()) return null;
            File target = new File(staging, source.getName());
            try (InputStream in = new java.io.FileInputStream(source);
                 OutputStream out = new java.io.FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            }
            return target.getAbsolutePath();
        } catch (Throwable error) {
            Log.w(TAG, "暂存安装包失败：" + zipPath, error);
            return null;
        }
    }

    /**
     * 打开模组目录（模组面板里那颗按钮）。
     *
     * 模组根目录现在落在应用的外部 files 目录（见 FoliaNodeRuntime.resolveUserDataDir），
     * 用户能用文件管理器直接看、直接塞 zip，所以这里可以把它真的叫出来 ——
     * 而不是像以前那样一律回 unsupported-on-android。
     *
     * 走 ACTION_VIEW + 目录的 content URI：系统文件管理器普遍支持浏览
     * `content://<包名>.fileprovider/...` 形式的目录。没有可用的处理方时如实回失败。
     */
    @PluginMethod
    public void openModsDirectory(PluginCall call) {
        JSObject result = new JSObject();
        try {
            File dir = new File(FoliaNodeRuntime.getUserDataDir(getContext()), "mods");
            if (!dir.isDirectory() && !dir.mkdirs()) {
                result.put("ok", false);
                result.put("error", "mods-directory-unavailable");
                call.resolve(result);
                return;
            }

            /*
             * 打开模组目录。
             *
             * 走过的弯路（都别再回去）：
             *   · MIME `resource/folder` —— 不是标准值，系统把它解析给了应用安装器；
             *   · `ACTION_VIEW` + FileProvider 的 content URI —— documentsui 只认自己
             *     DocumentsProvider 派生出来的 URI，别的 provider 它直接忽略，于是停在「下载」；
             *   · `ACTION_OPEN_DOCUMENT_TREE` + `file://` 的 EXTRA_INITIAL_URI —— 同样被忽略。
             *
             * 关键点：系统自带的 `com.android.externalstorage.documents` 这个 provider
             * 用 `primary:<相对路径>` 作为 document id，**它才是 documentsui 认的那种 URI**。
             * 直接用它构造 document URI，就能让文件管理器落在这一层目录上。
             */
            String path = dir.getAbsolutePath();
            android.net.Uri external = null;
            try {
                // /storage/emulated/0/Android/data/... → primary:Android/data/...
                String absolute = dir.getCanonicalPath();
                int marker = absolute.indexOf("/Android/");
                if (marker > 0) {
                    String documentId = "primary:" + absolute.substring(marker + 1);
                    external = android.net.Uri.parse(
                            "content://com.android.externalstorage.documents/document/"
                                    + android.net.Uri.encode(documentId));
                }
            } catch (Throwable error) {
                Log.w(TAG, "构造 externalstorage 目录 URI 失败", error);
            }

            android.content.pm.PackageManager pm = getContext().getPackageManager();
            String[][] candidates = {
                { "com.google.android.documentsui", "com.android.documentsui.files.FilesActivity" },
                { "com.android.documentsui", "com.android.documentsui.files.FilesActivity" },
            };
            for (String[] candidate : candidates) {
                android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW)
                        .setClassName(candidate[0], candidate[1])
                        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                                | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                if (external != null) {
                    intent.setDataAndType(external, android.provider.DocumentsContract.Document.MIME_TYPE_DIR);
                    intent.putExtra("android.provider.extra.INITIAL_URI", external);
                }
                if (intent.resolveActivity(pm) == null) continue;
                try {
                    getContext().startActivity(intent);
                    result.put("ok", true);
                    result.put("path", path);
                    call.resolve(result);
                    return;
                } catch (Throwable ignored) {
                    // 换下一个候选。
                }
            }

            /*
             * 没有能浏览文件的应用：交给 SAF 选择器，至少让用户能自己点进去。
             */
            android.content.Intent openTree = new android.content.Intent(
                    android.content.Intent.ACTION_OPEN_DOCUMENT_TREE)
                    .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
                            | android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            if (external != null) {
                openTree.putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI, external);
            }
            if (openTree.resolveActivity(pm) != null) {
                try {
                    getContext().startActivity(openTree);
                    result.put("ok", true);
                    result.put("path", path);
                    call.resolve(result);
                    return;
                } catch (Throwable ignored) {
                    // 落到失败分支。
                }
            }

            result.put("ok", false);
            result.put("error", "no-file-manager");
            result.put("path", path);
            call.resolve(result);
        } catch (Throwable error) {
            Log.w(TAG, "打开模组目录失败", error);
            result.put("ok", false);
            result.put("error", "open-failed");
            call.resolve(result);
        }
    }

    @PluginMethod
    public void invokeModRpc(PluginCall call) {
        JSObject args = new JSObject();
        args.put("modId", call.getString("modId", ""));
        args.put("name", call.getString("name", ""));
        args.put("args", call.getArray("args"));
        forward(call, "rpc", args);
    }

    @PluginMethod
    public void invokeModStorage(PluginCall call) {
        JSObject args = new JSObject();
        args.put("modId", call.getString("modId", ""));
        args.put("op", call.getString("operation", ""));
        args.put("key", call.getString("key", ""));
        if (call.getData().has("value")) {
            args.put("value", call.getData().opt("value"));
        }
        forward(call, "storage", args);
    }

    @PluginMethod
    public void getFfmpegStatus(PluginCall call) {
        forward(call, "ffmpeg-status", new JSObject());
    }

    @PluginMethod
    public void getModCallStats(PluginCall call) {
        JSObject args = new JSObject();
        args.put("modId", call.getString("modId", ""));
        forward(call, "call-stats", args);
    }

    @PluginMethod
    public void getModStorageUsage(PluginCall call) {
        JSObject args = new JSObject();
        args.put("modId", call.getString("modId", ""));
        forward(call, "storage-usage", args);
    }

    @PluginMethod
    public void clearModCache(PluginCall call) {
        JSObject args = new JSObject();
        args.put("modId", call.getString("modId", ""));
        forward(call, "clear-cache", args);
    }

    /**
     * 诊断用：把原生最近一次采到的设备指标原样交给渲染端。
     *
     * 真正的消费方是 Node 宿主（模组通过 `app.getAppMetrics()` 拿），这条只是为了
     * 能在控制台里核对 CPU / 温度读数，不参与模组功能。
     */
    @PluginMethod
    public void getDeviceMetrics(PluginCall call) {
        forward(call, "device-metrics", new JSObject());
    }

    /** Node 起来没有。渲染端在启动早期用它区分「还没好」和「真的没有」。 */
    @PluginMethod
    public void getNodeState(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ready", FoliaNodeRuntime.isReady());
        result.put("failure", FoliaNodeRuntime.getFailure());
        call.resolve(result);
    }

    /* ------------------------------------------------------------ 转发 */

    private void forward(PluginCall call, String op, JSObject args) {
        String requestId = String.valueOf(SEQ.getAndIncrement());
        JSONObject message = new JSONObject();
        try {
            message.put("id", requestId);
            message.put("op", op);
            message.put("args", new JSONObject(args.toString()));
        } catch (JSONException error) {
            call.reject("bad request: " + error.getMessage());
            return;
        }

        PENDING.put(requestId, call);
        final String finalId = requestId;
        // 超时兜底：Node 那边真出事了不能让渲染端永远等下去。
        getBridge().getWebView().postDelayed(() -> {
            PluginCall pending = PENDING.remove(finalId);
            if (pending != null) {
                pending.reject("node-timeout:" + op);
            }
        }, REQUEST_TIMEOUT_MS);

        if (!FoliaNodeRuntime.isReady()) {
            // Node 还在启动：按同样形状回一句，让渲染端自己重试，而不是卡住。
            PluginCall pending = PENDING.remove(requestId);
            if (pending != null) {
                String failure = FoliaNodeRuntime.getFailure();
                pending.reject(failure == null ? "node-not-ready" : "node-failed:" + failure);
            }
            return;
        }

        FoliaNodeRuntime.sendToNode("host", message.toString());
    }

    /* --------------------------------------------------- Node → 渲染端 */

    @Override
    public void onNodeMessage(String channel, String payload) {
        if (!"host".equals(channel)) {
            // 日志、状态变化等推送：原样交给渲染端，由它决定怎么用。
            JSObject event = new JSObject();
            event.put("payload", payload);
            notifyListeners("modsEvent", event);
            return;
        }
        PluginCall call = resolvePending(payload);
        if (call == null) {
            return;
        }
        try {
            JSONObject answer = new JSONObject(payload);
            if (answer.optBoolean("ok", false)) {
                // 应答里的 ok/result/error 原样透传：桌面端 invokeModRpc 的形状是 { ok, result }，
                // 而安装是 { ok, id, mods }，形状一致才不会在渲染端分叉。
                call.resolve(toJs(answer));
            } else {
                call.reject(answer.optString("error", "node-error"));
            }
        } catch (JSONException error) {
            Log.w(TAG, "应答不是合法 JSON：" + payload);
            call.reject("node-bad-reply");
        }
    }

    /** 从应答里取出请求号，找回对应的调用。 */
    private static PluginCall resolvePending(String payload) {
        try {
            JSONObject answer = new JSONObject(payload);
            String requestId = answer.optString("id", "");
            if (requestId.isEmpty()) {
                return null;
            }
            return PENDING.remove(requestId);
        } catch (JSONException error) {
            return null;
        }
    }

    /** JSONObject → JSObject（Capacitor 只认 JSObject 里的原始类型与 Map/List）。 */
    private static JSObject toJs(JSONObject source) {
        JSObject target = new JSObject();
        List<String> names = new ArrayList<>();
        for (java.util.Iterator<String> it = source.keys(); it.hasNext(); ) {
            names.add(it.next());
        }
        for (String name : names) {
            Object value = source.opt(name);
            if (value instanceof JSONObject) {
                target.put(name, toJs((JSONObject) value));
            } else if (value instanceof org.json.JSONArray) {
                target.put(name, toJsArray((org.json.JSONArray) value));
            } else if (value == JSONObject.NULL) {
                target.put(name, JSONObject.NULL);
            } else {
                target.put(name, value);
            }
        }
        return target;
    }

    private static org.json.JSONArray toJsArray(org.json.JSONArray source) {
        org.json.JSONArray target = new org.json.JSONArray();
        for (int index = 0; index < source.length(); index += 1) {
            Object value = source.opt(index);
            if (value instanceof JSONObject) {
                target.put(toJs((JSONObject) value));
            } else if (value instanceof org.json.JSONArray) {
                target.put(toJsArray((org.json.JSONArray) value));
            } else if (value == JSONObject.NULL) {
                target.put(JSONObject.NULL);
            } else {
                target.put(value);
            }
        }
        return target;
    }
}
