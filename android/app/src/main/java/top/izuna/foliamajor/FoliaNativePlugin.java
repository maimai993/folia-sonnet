package top.izuna.foliamajor;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Log;
import android.util.Base64;
import android.webkit.CookieManager;
import android.widget.Toast;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 本地登录的原生底座。
 *
 * 内置在 App 里的那份接口代码（src/nativeBridge/api/*.js，从浏览器扩展搬过来的）需要两件
 * WebView 给不了的东西：读改写各家音乐的 Cookie，以及不受 CORS 限制的跨域请求。
 * 这里把它们分别接到 Android CookieManager 与 OkHttp 上，于是登录、扫码、取曲库全流程
 * 都在设备本地完成 —— 不再需要用户自己搭任何后端。
 *
 * 另外顺手提供一个 Android 上绕不开的小东西：返回键与退出（exitApp）。
 *
 * 本地音乐也在这里：安卓 WebView 没有 File System Access API（showDirectoryPicker），
 * 曲库只能由原生侧给 —— MediaStore 扫描设备音乐库，或用系统文件管理器挑文件/文件夹，
 * 再通过 LocalAudioServer 把音频以 http 喂回 WebView。
 */
@CapacitorPlugin(
    name = "FoliaNative",
    permissions = {
        @Permission(
            alias = "audio",
            strings = { Manifest.permission.READ_MEDIA_AUDIO }
        ),
        @Permission(
            alias = "audioLegacy",
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE }
        )
    }
)
public class FoliaNativePlugin extends Plugin {
    private static final String TAG = "FoliaNative";
    private static volatile FoliaNativePlugin instance;

    /** 外部送进来的音频（externalAudio 事件名）。 */
    private static final String EXTERNAL_AUDIO_EVENT = "externalAudio";

    /** 更新包下载进度事件名。 */
    private static final String UPDATE_PROGRESS_EVENT = "updateDownloadProgress";

    /**
     * 安全区变化事件名。
     *
     * 网页那边的 env(safe-area-inset-*) 在安卓上不可信（只报挖孔、不报系统栏，无刘海全 0），
     * 真实数值由原生算出来（见 PhoneFitCutout.resolveInsets）发过去。
     */
    private static final String PHONE_INSETS_EVENT = "phoneInsets";

    /** 最近一次算出来的安全区；Web 层首屏用 getPhoneInsets 拉，之后靠事件推。 */
    private static volatile JSObject lastPhoneInsets = null;

    /** 更新包落在缓存目录下的这一层。 */
    private static final String UPDATE_DIRECTORY = "updates";

    /** 进度事件节流间隔。 */
    private static final long UPDATE_PROGRESS_INTERVAL_MS = 100;

    /** 文件/文件夹选择器只用一份：连点两次会开两个系统界面，回来的回调就串了。 */
    private boolean isAudioPickerOpen = false;
    private LocalAudioServer localAudioServer;

    /** 外部 intent 带来、还没开拷的 uri（冷启动时 Web 层可能比intent 晚一步）。 */
    private static final List<String> pendingExternalUris = new ArrayList<>();
    /** 拷完、但 Web 层还没领走的外部音频（没有监听者时就停在这里等它来取）。 */
    private static final List<JSObject> pendingExternalTracks = new ArrayList<>();

    /** 同一时刻只跑一个更新下载：连点两次会写出两个文件，后一次覆盖前一次。 */
    private final Object updateDownloadLock = new Object();
    private volatile boolean isUpdateDownloading = false;

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build();

    /*
     * AI 云缓存的原生侧副本。
     *
     * 请求本来就是走 httpRequest 出原生 OkHttp 的，但那一次是**网页发起**的：界面退到后台
     * 之后 WebView 的 JS 会被节流甚至冻住，发起的那一步就卡在那儿，或者发起之后回调回来
     * 时 JS 已经不在跑 —— 表现就是「切了歌，云缓存一次都没问」。
     *
     * 这里让原生自己把请求做完并留一份答案 OkHttp 跑在自己的线程池上，不受 WebView 冻结
     * 影响；网页什么时候回来问都能拿到，不必再发一次。
     *
     * 只留命中的：没命中也冻上几分钟，只会把「云端刚刚有了」这件事挡在外面。
     */
    private static final int AI_CACHE_MAX_ENTRIES = 64;
    private static final long AI_CACHE_TTL_MS = 6 * 60 * 1000L;
    private static final Map<String, AiCacheCell> aiCache = new LinkedHashMap<String, AiCacheCell>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, AiCacheCell> eldest) {
            return size() > AI_CACHE_MAX_ENTRIES;
        }
    };

    private static final class AiCacheCell {
        final String body;
        final long at;

        AiCacheCell(String body, long at) {
            this.body = body;
            this.at = at;
        }
    }

    private static String readAiCacheBody(String key, long now) {
        synchronized (aiCache) {
            AiCacheCell cell = aiCache.get(key);
            if (cell == null) return null;
            if (now - cell.at > AI_CACHE_TTL_MS) {
                aiCache.remove(key);
                return null;
            }
            return cell.body;
        }
    }

    private static void writeAiCacheBody(String key, String body, long now) {
        synchronized (aiCache) {
            aiCache.put(key, new AiCacheCell(body, now));
        }
    }

    /**
     * 读一条 AI 云缓存：命中原生副本就直接回，否则发一次请求并把命中的答案留下来。
     *
     * 回的是**服务端响应体原文**（字符串），不由原生去解析 JSON —— Capacitor 的嵌套对象
     * 转换在个别版本上会把内层对象丢成 null，字符串零歧义。
     */
    @PluginMethod
    public void aiCloudCacheGet(PluginCall call) {
        String key = call.getString("key", "");
        String url = call.getString("url", "");
        if (key == null || key.isEmpty() || url == null || url.isEmpty()) {
            call.reject("Missing cache key or url");
            return;
        }

        String cached = readAiCacheBody(key, System.currentTimeMillis());
        if (cached != null) {
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("body", cached);
            result.put("cached", true);
            call.resolve(result);
            return;
        }

        try {
            Request request = new Request.Builder()
                .url(url)
                .get()
                .header("Accept", "application/json")
                .build();
            // 与 httpRequest 同理：等待交给 OkHttp 的线程池，别占着桥线程。
            call.setKeepAlive(true);
            client.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call httpCall, IOException error) {
                    call.reject(error.getMessage(), error);
                }

                @Override
                public void onResponse(Call httpCall, Response response) {
                    try (Response body = response) {
                        ResponseBody responseBody = body.body();
                        String text = responseBody == null ? "" : responseBody.string();
                        boolean ok = body.isSuccessful();
                        if (ok && !text.isEmpty() && text.contains("\"hit\":true")) {
                            writeAiCacheBody(key, text, System.currentTimeMillis());
                        }
                        JSObject result = new JSObject();
                        result.put("ok", ok);
                        result.put("body", text);
                        result.put("cached", false);
                        call.resolve(result);
                    } catch (IOException | IllegalArgumentException error) {
                        call.reject(error.getMessage(), error);
                    }
                }
            });
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage(), error);
        }
    }

    @Override
    public void load() {
        instance = this;
        // 意图可能比 Web 层更早到（Activity.onCreate 交过来时 Bridge 还没建好），先攒在静态
        // 列表里；插件上线后立即拿去拷。
        startExternalAudioImport();
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /**
     * 把当前安全区（CSS px）发给网页。
     *
     * 从 PhoneFitCutout 的铺满流程与 inset 监听里调用，所以启动、转屏、系统栏临时划出
     * 都会重算一遍。没有实例或没有监听者时只更新缓存 —— 网页首屏会用 getPhoneInsets 拉。
     */
    static void publishPhoneInsets(Activity activity) {
        if (activity == null) return;
        JSONObject resolved = PhoneFitCutout.resolveInsets(activity);
        JSObject payload = new JSObject();
        try {
            payload.put("top", resolved.optInt("top", 0));
            payload.put("right", resolved.optInt("right", 0));
            payload.put("bottom", resolved.optInt("bottom", 0));
            payload.put("left", resolved.optInt("left", 0));
        } catch (Exception error) {
            Log.w(TAG, "Failed to build phone insets payload", error);
            return;
        }
        lastPhoneInsets = payload;
        FoliaNativePlugin plugin = instance;
        if (plugin == null || !plugin.hasListeners(PHONE_INSETS_EVENT)) return;
        final FoliaNativePlugin target = plugin;
        activity.runOnUiThread(() -> target.notifyListeners(PHONE_INSETS_EVENT, payload));
    }

    /**
     * 可视化歌词页面专用：隐藏系统栏（状态栏 + 导航栏）。
     *
     * 传 false 恢复显示。**默认是显示**，也就是说只有 Web 层明确说「现在是歌词页」时
     * 才会隐藏 —— 首页 / 搜索 / 设置这些页面状态栏一直在，时间电量通知图标看得见。
     *
     * 原生不知道「哪个页面算歌词页」，所以判定交给 Web 层，这里只执行结论。
     * 切换后会连带重压一次挖孔适配（系统栏一显一隐，inset 会被重写成 padding）。
     */
    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean immersive = Boolean.TRUE.equals(call.getBoolean("immersive", false));
        Activity activity = getActivity();
        if (activity instanceof MainActivity) {
            MainActivity.setImmersiveMode(activity, immersive);
        }
        call.resolve();
    }

    /*
     * 系统栏的**常驻**策略：平板与手机横屏把状态栏收起来（见 MainActivity.setSystemBarsPolicy）。
     *
     * 与 setImmersive 是「或」的关系、互不覆盖：歌词页本来就要全沉浸，这一条只是让它在
     * 别的页面也把状态栏收起来。判定在 Web 层（设备类型 + 朝向只有它知道），这里只执行。
     */
    @PluginMethod
    public void setSystemBarsPolicy(PluginCall call) {
        boolean alwaysHidden = Boolean.TRUE.equals(call.getBoolean("alwaysHidden", false));
        Activity activity = getActivity();
        if (activity instanceof MainActivity) {
            MainActivity.setSystemBarsPolicy(activity, alwaysHidden);
        }
        call.resolve();
    }

    /**
     * 最近一次算出来的安全区（CSS px），**给叠层那一层取用**。
     *
     * 叠层（画在桌面 / 锁屏之上那层悬浮窗）是**另一个 WebView / document**：里面没有
     * Capacitor 桥，拿不到这个插件，网页自己只能读到 `env(safe-area-inset-*)` 那份 ——
     * 而安卓上那份不可信（只报挖孔、不报系统栏，见 PhoneFitCutout.resolveInsets）。
     * 叠层又是 `setFitInsetsTypes(0)` 的满屏窗口，状态栏与手势条照样盖在它上面，
     * 于是它画出来的歌词描述照样会被压住，只是这次没人给它让路。
     *
     * 所以数值从这里取一份，跟着叠层的状态包一起推下去（见 WallpaperOverlay.buildPayload）。
     * 没算出来时返回 null，页面那边按「还没量到」处理，行为和不推一样。
     */
    public static JSObject peekPhoneInsets() {
        return lastPhoneInsets;
    }

    /** 网页首屏拉取安全区：事件只能覆盖「变了之后」，第一次的值得靠这一下。 */
    @PluginMethod
    public void getPhoneInsets(PluginCall call) {
        Activity activity = getActivity();
        if (lastPhoneInsets == null && activity != null) {
            publishPhoneInsets(activity);
        }
        JSObject payload = lastPhoneInsets;
        call.resolve(payload == null ? new JSObject() : payload);
    }

    /**
     * 返回键：先给 WebView 一个机会（弹层、设置页自己关掉自己），没人接管才退出。
     *
     * 返回 true 表示网页侧有监听者、事件已经派发出去，Activity 不要自己 finish。
     */
    static boolean emitBackPressed() {
        FoliaNativePlugin plugin = instance;
        if (plugin == null || !plugin.hasListeners("backButton")) return false;
        Activity activity = plugin.getActivity();
        if (activity == null) return false;
        JSObject payload = new JSObject();
        activity.runOnUiThread(() -> plugin.notifyListeners("backButton", payload));
        return true;
    }

    /**
     * 前后台：告诉网页现在还看不看得见。
     *
     * 网页拿这个信号去停掉整套渲染（见 src/utils/backgroundRenderGate.ts）。退后台后画面
     * 没人看，可 WebView 里的动画循环照样按 60fps 跑，和音频解码抢同一颗核 —— 抢输了就
     * 是后台播放的撕裂声。
     *
     * 这里是 Activity 的 onStop / onStart 在调，不是 onPause / onResume：下拉通知栏、
     * 切多任务只到 onPause，那时画面还露着一半，不该停。
     *
     * 没有监听者时直接返回，和返回键那条链路一样 —— 事件没人接，发了也没意义。
     */
    static void emitAppBackground(boolean background) {
        FoliaNativePlugin plugin = instance;
        if (plugin == null || !plugin.hasListeners("appBackground")) return;
        Activity activity = plugin.getActivity();
        if (activity == null) return;
        JSObject payload = new JSObject();
        payload.put("background", background);
        activity.runOnUiThread(() -> plugin.notifyListeners("appBackground", payload));
    }

    /**
     * 外部应用「用 Folia 打开 / 分享到 Folia」送来的音频。
     *
     * 这里**立刻就把文件拷进私有目录**，不等用户确认：intent 附带的 content:// 读授权只在
     * 这次 Activity 存活期间有效，等用户看完「导入到哪个歌单」再回头读，部分 ROM 上已经作废
     * （openInputStream 静默返回一个空流）。拷进私有目录后播放只认 App 自己的副本，
     * 与 provider 和权限彻底脱钩 —— 和「挑文件导入」那条路完全同一套。
     *
     * 用户最终回答 import 与否之前，这些曲目先通过上述两个出口之一交给 Web 层：
     * · App 已经在前台（有监听者）：拷完发 externalAudio 事件；
     * · 冷启动：那时一个监听者都还没有，拷完停在 pendingExternalTracks，
     *   由 Web 层起来后调 takeExternalAudioUris 取走。
     */
    static void noteExternalAudioUris(List<Uri> uris) {
        if (uris == null || uris.isEmpty()) return;
        synchronized (pendingExternalUris) {
            for (Uri uri : uris) {
                if (uri == null) continue;
                String raw = uri.toString();
                if (!pendingExternalUris.contains(raw)) pendingExternalUris.add(raw);
            }
        }
        FoliaNativePlugin plugin = instance;
        if (plugin != null) plugin.startExternalAudioImport();
    }

    /** 把待处理的外部音频拷进私有目录；拷完交给下面的 deliverExternalAudio。 */
    private void startExternalAudioImport() {
        final List<Uri> uris = new ArrayList<>();
        synchronized (pendingExternalUris) {
            for (String raw : pendingExternalUris) {
                try {
                    uris.add(Uri.parse(raw));
                } catch (Exception ignored) {
                    // 解析不了的 uri 直接放弃，别让它把整批拖住。
                }
            }
            pendingExternalUris.clear();
        }
        if (uris.isEmpty()) return;

        final Activity activity = getActivity();
        importAudioFiles(uris, Activity.RESULT_OK, new AudioImportSink() {
            @Override
            public void complete(JSObject result) {
                // optJSONArray / optJSONObject 声明的返回类型是 org.json 的那两个（JSArray / JSObject
                // 只是它们的子类），取出来只能按父类型接，再转回 Capacitor 这一对。
                JSONArray tracks = result.optJSONArray("tracks");
                synchronized (pendingExternalTracks) {
                    for (int index = 0; tracks != null && index < tracks.length(); index += 1) {
                        JSONObject track = tracks.optJSONObject(index);
                        if (track == null) continue;
                        if (track instanceof JSObject) {
                            pendingExternalTracks.add((JSObject) track);
                            continue;
                        }
                        // 兜一条：上游哪天给的是普通的 org.json 对象，复制成 Capacitor 的那一种。
                        try {
                            pendingExternalTracks.add(JSObject.fromJSONObject(track));
                        } catch (JSONException ignored) {
                            Log.w(TAG, "External audio track is not a JSON object");
                        }
                    }
                }
                deliverExternalAudio(activity, result.optInt("port", 0));
            }

            @Override
            public void fail(String message, Exception error) {
                Log.w(TAG, "External audio import failed: " + message, error);
            }
        });
    }

    /**
     * 把拷好的外部音频交给 Web 层。
     *
     * 有监听者就发事件（顺手把 pending 清掉，免得之后 take 又把它们取一遍就重复入库）；
     * 没有就留在 pendingExternalTracks 里，等 Web 层起来自己来取。
     */
    private void deliverExternalAudio(Activity activity, int port) {
        if (!hasListeners(EXTERNAL_AUDIO_EVENT)) return;
        JSArray tracks = new JSArray();
        synchronized (pendingExternalTracks) {
            for (JSObject track : pendingExternalTracks) tracks.put(track);
            pendingExternalTracks.clear();
        }
        if (tracks.length() == 0) return;
        JSObject payload = new JSObject();
        payload.put("tracks", tracks);
        if (port > 0) payload.put("port", port);
        Runnable emit = () -> notifyListeners(EXTERNAL_AUDIO_EVENT, payload);
        if (activity != null) activity.runOnUiThread(emit);
        else emit.run();
    }

    @PluginMethod
    public void cookiesGetAll(PluginCall call) {
        String url = call.getString("url", "");
        String domain = call.getString("domain", "");
        if (url == null || url.isEmpty()) {
            if (domain == null || domain.isEmpty()) {
                url = "https://localhost/";
            } else {
                url = domain.startsWith("http") ? domain : "https://" + domain;
            }
        }

        JSArray cookies = new JSArray();
        for (JSObject cookie : parseCookieHeader(CookieManager.getInstance().getCookie(url), domain)) {
            cookies.put(cookie);
        }
        JSObject result = new JSObject();
        result.put("cookies", cookies);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesGet(PluginCall call) {
        String url = call.getString("url", "https://localhost/");
        String name = call.getString("name", "");
        if (name == null || name.isEmpty()) {
            call.reject("Missing cookie name");
            return;
        }
        for (JSObject cookie : parseCookieHeader(CookieManager.getInstance().getCookie(url), "")) {
            if (name.equals(cookie.optString("name"))) {
                JSObject result = new JSObject();
                result.put("cookie", cookie);
                call.resolve(result);
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("cookie", null);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesSet(PluginCall call) {
        String url = call.getString("url", "");
        String name = call.getString("name", "");
        String value = call.getString("value", "");
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required");
            return;
        }

        StringBuilder cookie = new StringBuilder();
        cookie.append(name).append('=').append(value == null ? "" : value);
        String domain = call.getString("domain", "");
        String path = call.getString("path", "/");
        if (domain != null && !domain.isEmpty()) cookie.append("; domain=").append(domain);
        if (path != null && !path.isEmpty()) cookie.append("; path=").append(path);
        if (Boolean.TRUE.equals(call.getBoolean("secure", false))) cookie.append("; Secure");
        Double expirationDate = call.getDouble("expirationDate");
        if (expirationDate != null) {
            cookie.append("; Max-Age=").append((int) Math.max(0, expirationDate - System.currentTimeMillis() / 1000.0));
        }

        CookieManager.getInstance().setCookie(url, cookie.toString());
        CookieManager.getInstance().flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesRemove(PluginCall call) {
        String url = call.getString("url", "");
        String name = call.getString("name", "");
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required");
            return;
        }
        CookieManager.getInstance().setCookie(url, name + "=; Max-Age=0; path=/");
        CookieManager.getInstance().flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    /**
     * 批量删除 cookie：entries 是 [{url, name}, ...]。
     *
     * 逐条删除每条都要过一次桥并在原生侧 flush 一次，切换登录通道要清几十条，
     * 累加起来会超过调用方的截止时间，结果只清掉一半 —— 剩下一半旧凭据会把新登录
     * 拼成一个用不了的会话。所以这里在原生侧一次做完。
     */
    @PluginMethod
    public void cookiesRemoveBatch(PluginCall call) {
        JSArray entries = call.getArray("entries");
        if (entries == null || entries.length() == 0) {
            JSObject empty = new JSObject();
            empty.put("ok", true);
            empty.put("removed", 0);
            call.resolve(empty);
            return;
        }
        CookieManager manager = CookieManager.getInstance();
        int removed = 0;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index);
            if (entry == null) continue;
            String url = entry.optString("url", "");
            String name = entry.optString("name", "");
            if (url == null || url.isEmpty() || name == null || name.isEmpty()) continue;
            manager.setCookie(url, name + "=; Max-Age=0; path=/");
            removed++;
        }
        if (removed > 0) manager.flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("removed", removed);
        call.resolve(result);
    }

    /** OkHttp 要求这些方法必须带 body（见 httpRequest 里的说明）。 */
    private static boolean requiresRequestBody(String method) {
        return "POST".equalsIgnoreCase(method)
            || "PUT".equalsIgnoreCase(method)
            || "PATCH".equalsIgnoreCase(method);
    }

    @PluginMethod
    public void httpRequest(PluginCall call) {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        String bodyText = call.getString("bodyText", "");
        String bodyBase64 = call.getString("bodyBase64", "");
        String redirect = call.getString("redirect", "follow");
        if (url == null || url.isEmpty()) {
            call.reject("Missing request url");
            return;
        }

        try {
            Request.Builder builder = new Request.Builder().url(url);
            JSObject headers = call.getObject("headers");
            if (headers != null) {
                Iterator<String> headerNames = headers.keys();
                while (headerNames.hasNext()) {
                    String headerName = headerNames.next();
                    Object headerValue = headers.opt(headerName);
                    if (headerValue != null) {
                        builder.header(headerName, String.valueOf(headerValue));
                    }
                }
            }
            // OkHttp 这里没有 cookie jar，所以要把 WebView 的 cookie 库自己带上，
            // 除非调用方已经显式塞了 Cookie 头。
            if (headers == null || headers.optString("cookie") == null) {
                String storedCookies = CookieManager.getInstance().getCookie(url);
                if (storedCookies != null && !storedCookies.isEmpty()) {
                    builder.header("Cookie", storedCookies);
                }
            }

            RequestBody body = null;
            if (bodyBase64 != null && !bodyBase64.isEmpty()) {
                body = RequestBody.create(MediaType.parse("application/octet-stream"), Base64.decode(bodyBase64, Base64.DEFAULT));
            } else if (bodyText != null && !bodyText.isEmpty()) {
                MediaType mediaType = MediaType.parse(headers == null ? null : headers.optString("content-type", null));
                body = RequestBody.create(mediaType, bodyText);
            }
            String requestMethod = method == null ? "GET" : method;
            /*
             * OkHttp 不给 POST/PUT/PATCH 发空 body：`HttpMethod.requiresRequestBody` 会直接抛
             * `method POST must have a request body.` —— 整条请求根本出不去。
             *
             * 而上游 KuGouMusicApi 跑在 Node 上用 axios，POST 不带 body 是合法的，
             * 那些「参数全走 query」的推荐接口（每日推荐、历史推荐）就是这么写的。
             * 这里补一个长度为 0 的 body：线上看到的就是 Content-Length: 0，
             * 与上游完全一致 —— 于是 JS 侧不必为了迁就原生把签名里参与计算的
             * body 串改成别的（签名必须和实际发出去的东西对得上，改了就验签失败、
             * 表现为「接口通了但没有歌」）。
             */
            if (body == null && requiresRequestBody(requestMethod)) {
                body = RequestBody.create(null, new byte[0]);
            }
            if (body != null && "GET".equalsIgnoreCase(requestMethod)) {
                // 有接口的播放地址是「GET + JSON body」，OkHttp 公开的 method() 不接受这种组合，
                // 只能先选好 GET 再用它自己的 setter 把校验过的 body 塞进去。
                builder.method("GET", null);
                try {
                    Method setBody = Request.Builder.class.getMethod("setBody$okhttp", RequestBody.class);
                    setBody.invoke(builder, body);
                } catch (ReflectiveOperationException error) {
                    call.reject("GET request body is unsupported by this runtime", error);
                    return;
                }
            } else {
                builder.method(requestMethod, body);
            }

            OkHttpClient requestClient = client;
            if ("manual".equals(redirect)) {
                requestClient = client.newBuilder()
                    .followRedirects(false)
                    .followSslRedirects(false)
                    .build();
            }
            // AI 请求可能远超默认的 45s 读超时，调用方可以按需放宽。
            Integer timeoutMs = call.getInt("timeoutMs");
            if (timeoutMs != null && timeoutMs > 0) {
                requestClient = requestClient.newBuilder()
                    .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build();
            }

            // 回调里要用，必须是 final：上面这两段按条件重建过 client。
            final OkHttpClient executeClient = requestClient;
            String requestUrl = url;
            /*
             * 必须用 enqueue 而不是 execute。
             *
             * execute() 是在**插件所在的桥线程**上同步阻塞的：一个请求从发出到拿到响应
             * （最坏要等满读超时）会一直占着那个线程。桥线程就那么几条，占满之后其它
             * 插件方法全部排队 —— 表现为登录飞牛之后 cookies.getAll / cookies.get 成片
             * 超时（日志里几十条 "timed out after 4000ms" 挤在同一秒），而那些 cookie
             * 调用本身只是毫秒级的事。跟着遭殃的是所有走桥的平台：登录态读不到 cookie
             * 就判成超时，二维码也取不出来。退出飞牛重启即恢复，正是运行时争用的样子。
             *
             * enqueue 把等待交给 OkHttp 自己的线程池，桥线程立刻空出来。
             */
            call.setKeepAlive(true);
            executeClient.newCall(builder.build()).enqueue(new Callback() {
                @Override
                public void onFailure(Call httpCall, IOException error) {
                    call.reject(error.getMessage(), error);
                }

                @Override
                public void onResponse(Call httpCall, Response response) {
                    try (Response body = response) {
                        // 重复出现的响应头（Set-Cookie）要给 JS 一个数组，用对象会把重复的折叠掉。
                        JSArray responseHeaders = new JSArray();
                        for (String name : response.headers().names()) {
                            for (String value : response.headers().values(name)) {
                                JSObject headerEntry = new JSObject();
                                headerEntry.put("name", name);
                                headerEntry.put("value", value);
                                responseHeaders.put(headerEntry);
                            }
                        }
                        storeResponseCookies(requestUrl, response);
                        ResponseBody responseBody = response.body();
                        byte[] bytes = responseBody == null ? new byte[0] : responseBody.bytes();
                        JSObject result = new JSObject();
                        result.put("status", response.code());
                        result.put("headers", responseHeaders);
                        result.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                        call.resolve(result);
                    } catch (IOException | IllegalArgumentException error) {
                        call.reject(error.getMessage(), error);
                    }
                }
            });
        } catch (IllegalArgumentException error) {
            // 拼 URL / 建请求这一步才会抛（响应相关的 IOException 在回调里各自处理）。
            call.reject(error.getMessage(), error);
        }
    }

    /**
     * 把响应里的 Set-Cookie 存回 WebView 的 cookie 库。
     *
     * 登录能不能保持住全靠这一步：登录接口下发的 MUSIC_U / qqmusic_key 之类的凭据，
     * 之后每次请求都要由 {@link #httpRequest} 从这里读出来带上。
     */
    private void storeResponseCookies(String requestUrl, Response response) {
        List<String> setCookies = response.headers().values("Set-Cookie");
        if (setCookies.isEmpty()) return;
        CookieManager manager = CookieManager.getInstance();
        boolean changed = false;
        for (String rawCookie : setCookies) {
            String cookie = normalizeCookieForUrl(requestUrl, rawCookie);
            if (cookie == null || cookie.isEmpty()) continue;
            manager.setCookie(requestUrl, cookie);
            changed = true;
        }
        if (changed) manager.flush();
    }

    // 真实响应几乎都带 Path/Domain，但个别平台会整个省略 Path；CookieManager 遇到没有
    // Path 的 Set-Cookie 会直接忽略，这里补一个默认的，免得登录态存不下来。
    private static String normalizeCookieForUrl(String requestUrl, String rawCookie) {
        if (rawCookie == null || rawCookie.isEmpty()) return null;
        boolean hasPath = false;
        for (String attribute : rawCookie.split(";")) {
            if (attribute.trim().toLowerCase().startsWith("path=")) {
                hasPath = true;
                break;
            }
        }
        if (hasPath) return rawCookie;
        return rawCookie + "; Path=/";
    }

    /**
     * 真正的退出：销毁 Activity。
     *
     * 只有「确定要结束这次会话」才走它（例如设置里的退出项）。**返回键不归这里管** ——
     * 返回键走 {@link #moveToBackground}，见那边的说明。
     */
    @PluginMethod
    public void exitApp(PluginCall call) {
        Activity activity = getActivity();
        call.resolve();
        if (activity != null) activity.runOnUiThread(activity::finish);
    }

    /**
     * 把整个任务挪到后台（等价于按 Home 键），Activity 与播放状态都留着。
     *
     * 为什么返回键要它而不是 `finish()`：这是个播放器，按返回时歌还在放。finish() 销毁
     * Activity，进程只剩前台服务吊着，下次进来一切从头（页面、播放页、搜索结果全丢），
     * 用户看到的正是「返回键直接把 App 杀了」。moveTaskToBack 才是「退到桌面继续听」：
     * Activity 留在栈里，点图标原样回来，前台服务与通知照旧。
     *
     * 它同时会走 onStop → `appBackground` → 网页停掉整套渲染，和锁屏 / 切多任务那条路一致。
     */
    @PluginMethod
    public void moveToBackground(PluginCall call) {
        Activity activity = getActivity();
        call.resolve();
        if (activity != null) {
            activity.runOnUiThread(() -> activity.moveTaskToBack(true));
        }
    }

    // ---- 应用内更新（下载到私有缓存目录，再交给系统安装器）----

    /**
     * 下载更新包，进度用 `updateDownloadProgress` 事件往外推。
     *
     * 走 OkHttp 流式写文件而不是把整个包读进内存：APK 动辄上百 MB，WebView 里攒 Blob
     * 再转 base64 写过 Filesystem 插件，途中要同时持有字节数组和膨胀后的 base64 串，
     * 低端机上直接 OOM。这里是边读边写，内存占用恒定在一个缓冲区。
     */
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = call.getString("fileName", "");
        if (url == null || url.isEmpty()) {
            call.reject("Missing update download url");
            return;
        }
        String safeName = sanitizeUpdateFileName(fileName);

        synchronized (updateDownloadLock) {
            if (isUpdateDownloading) {
                call.reject("An update download is already running");
                return;
            }
            isUpdateDownloading = true;
        }

        long receivedBytes = 0;
        File target = null;
        try {
            File directory = new File(getContext().getCacheDir(), UPDATE_DIRECTORY);
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IOException("Unable to create update directory");
            }
            target = new File(directory, safeName);
            if (target.exists() && !target.delete()) {
                throw new IOException("Unable to remove a stale update file");
            }

            Request request = new Request.Builder().url(url).build();
            try (Response response = client.newCall(request).execute()) {
                if (!response.isSuccessful()) {
                    throw new IOException("Update download failed with HTTP " + response.code());
                }
                ResponseBody body = response.body();
                if (body == null) {
                    throw new IOException("Update download returned an empty body");
                }
                long totalBytes = body.contentLength();
                long lastEmitAt = 0;
                try (InputStream source = body.byteStream();
                     OutputStream sink = new FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = source.read(buffer)) != -1) {
                        sink.write(buffer, 0, read);
                        receivedBytes += read;
                        // 每 100ms 推一次就够了：WebView 那边是拿它刷新进度条的，
                        // 逐块转发会把桥打满，进度条反而卡。
                        long now = SystemClock.elapsedRealtime();
                        if (receivedBytes == totalBytes || now - lastEmitAt >= UPDATE_PROGRESS_INTERVAL_MS) {
                            lastEmitAt = now;
                            emitUpdateProgress(receivedBytes, totalBytes, false);
                        }
                    }
                }
                emitUpdateProgress(receivedBytes, totalBytes, true);
            }

            JSObject result = new JSObject();
            result.put("path", target == null ? "" : target.getAbsolutePath());
            result.put("bytes", receivedBytes);
            call.resolve(result);
        } catch (IOException | IllegalArgumentException error) {
            call.reject(error.getMessage(), error);
        } finally {
            synchronized (updateDownloadLock) {
                isUpdateDownloading = false;
            }
        }
    }

    /** 把下载好的包交给系统安装器。 */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        String path = call.getString("path", "");
        if (path == null || path.isEmpty()) {
            call.reject("Missing update file path");
            return;
        }
        File file = new File(path);
        if (!file.exists()) {
            call.reject("Update file is missing");
            return;
        }

        // Android O 起「允许来自此来源的应用」是按包授权的运行时开关，没开就装不上 ——
        // 直接跳系统那个页面，比装到一半失败再报错好。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(settingsIntent);
            } catch (Exception error) {
                call.reject("Unable to open the install permission settings", error);
                return;
            }
            JSObject result = new JSObject();
            result.put("status", "permission-required");
            call.resolve(result);
            return;
        }

        Uri apkUri;
        try {
            apkUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file
            );
        } catch (IllegalArgumentException error) {
            // 路径没落在 file_paths.xml 声明的目录里就会走到这里，属于改错配置的编程错误。
            call.reject("Update file is not shareable via FileProvider", error);
            return;
        }

        Intent installIntent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(apkUri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(installIntent);
        } catch (Exception error) {
            call.reject("No app can handle the installer intent", error);
            return;
        }
        JSObject result = new JSObject();
        result.put("status", "installing");
        call.resolve(result);
    }

    /** 只允许 `名字.apk`，其余字符一律换成 `_`，避免文件名里带路径分隔符写到别处去。 */
    private static String sanitizeUpdateFileName(String rawName) {
        String trimmed = rawName == null ? "" : rawName.trim();
        if (trimmed.isEmpty()) return "folia-update.apk";
        String flattened = trimmed.replaceAll("[^A-Za-z0-9._-]", "_");
        return flattened.endsWith(".apk") ? flattened : flattened + ".apk";
    }

    /** 进度事件：bytes 是可用的原始值，percent 是给 UI 直接用的 0-100（总量未知时为 -1）。 */
    private void emitUpdateProgress(long receivedBytes, long totalBytes, boolean done) {
        JSObject payload = new JSObject();
        payload.put("receivedBytes", receivedBytes);
        payload.put("totalBytes", totalBytes > 0 ? totalBytes : 0);
        payload.put("percent", totalBytes > 0
                ? Math.min(100, (int) Math.floor(receivedBytes * 100d / totalBytes))
                : -1);
        payload.put("done", done);
        Activity activity = getActivity();
        Runnable emit = () -> notifyListeners(UPDATE_PROGRESS_EVENT, payload);
        if (activity != null) activity.runOnUiThread(emit);
        else emit.run();
    }

    // ---- 本地音乐（安卓没有 File System Access API，曲库只能由原生侧给）----

    @PluginMethod
    public void scanLocalAudio(PluginCall call) {
        String alias = audioPermissionAlias();
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias, call, "audioPermissionCallback");
            return;
        }
        resolveLocalAudioScan(call);
    }

    /**
     * Android 13 起读音频用 READ_MEDIA_AUDIO，之前的版本用 READ_EXTERNAL_STORAGE。
     *
     * 这两个权限不能放在同一个别名里：被申请的那一个拿到授权后，另一个在系统看来仍是
     * 拒绝，而 Capacitor 对同一别名取「全部授权才算授权」，结果永远停在 PROMPT，
     * 扫描会被误判成「权限被拒」。所以按系统版本分开取别名。
     */
    private String audioPermissionAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "audioLegacy";
    }

    @PermissionCallback
    private void audioPermissionCallback(PluginCall call) {
        if (getPermissionState(audioPermissionAlias()) == PermissionState.GRANTED) {
            resolveLocalAudioScan(call);
        } else {
            call.reject("Audio permission denied");
        }
    }

    @PluginMethod
    public void pickAudioFiles(PluginCall call) {
        if (isAudioPickerOpen) {
            call.reject("Audio picker is already open");
            return;
        }
        // 用 Capacitor 自己的活动回调机制（@ActivityCallback + startActivityForResult），
        // 而不是在 load() 里直接 registerForActivityResult：后者依赖活动生命周期时序，
        // 在部分设备上会拿不到可用的启动器，表现就是「点了导入毫无反应」。
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("audio/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        isAudioPickerOpen = true;
        startActivityForResult(call, intent, "handlePickedAudio");
    }

    /** 选择整个文件夹；原生侧递归扫描其中的音频，用户可以一次导入整张专辑/目录。 */
    @PluginMethod
    public void pickAudioFolder(PluginCall call) {
        if (isAudioPickerOpen) {
            call.reject("Audio picker is already open");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        isAudioPickerOpen = true;
        startActivityForResult(call, intent, "handlePickedAudioFolder");
    }

    /**
     * 取走「外部应用送进来、 Web 层还没领」的音频（冷启动那一路）。
     *
     * 从别的应用打开文件时 App 常常是冷启动的：那时浏览器侧还没加载完、一个监听者都没有，
     * 拷好的曲目只能先停在 pendingExternalTracks；页面起来后调一次这个方法把它们取走。
     * 取完即清空 —— 下一步用户回答的是「是否导入」，不是「要不要再拷一次」。
     */
    @PluginMethod
    public void takeExternalAudioUris(PluginCall call) {
        JSArray tracks = new JSArray();
        synchronized (pendingExternalTracks) {
            for (JSObject track : pendingExternalTracks) tracks.put(track);
            pendingExternalTracks.clear();
        }
        JSObject result = new JSObject();
        result.put("tracks", tracks);
        int port = 0;
        try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            port = localAudioServer.start();
        } catch (Exception ignored) {
            // 起不来时 Web 层会自己用 localAudioServerPort 再来一次；这里不给端口即可。
        }
        if (port > 0) result.put("port", port);
        call.resolve(result);
    }

    /** 供 WebView 重建导入音频的流地址（端口每次启动都可能不同，不能把 URL 存死）。 */
    @PluginMethod
    public void localAudioServerPort(PluginCall call) {
        try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            int port = localAudioServer.start();
            JSObject result = new JSObject();
            result.put("port", port);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @ActivityCallback
    private void handlePickedAudio(PluginCall call, ActivityResult activityResult) {
        isAudioPickerOpen = false;
        if (call == null) return;

        // -1 = RESULT_OK，0 = RESULT_CANCELED。区分「用户取消」和「选完了却没数据」，
        // 否则两种情况的返回值一模一样，只能靠猜。
        int resultCode = activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode();
        List<Uri> uris = new ArrayList<>();
        Intent data = activityResult == null ? null : activityResult.getData();
        if (data != null) {
            ClipData clipData = data.getClipData();
            if (clipData != null) {
                for (int index = 0; index < clipData.getItemCount(); index += 1) {
                    Uri uri = clipData.getItemAt(index).getUri();
                    if (uri != null) uris.add(uri);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }

        completePickedAudioImport(call, uris, resultCode);
    }

    @ActivityCallback
    private void handlePickedAudioFolder(PluginCall call, ActivityResult activityResult) {
        isAudioPickerOpen = false;
        if (call == null) return;
        int resultCode = activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode();
        List<Uri> uris = new ArrayList<>();
        Intent data = activityResult == null ? null : activityResult.getData();
        Uri treeUri = data == null ? null : data.getData();
        if (treeUri != null) {
            try {
                // 拿到长期授权：重启之后还能读这个目录，重新导入时不必再让用户选一次。
                getContext().getContentResolver().takePersistableUriPermission(
                    treeUri,
                    data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception ignored) {
                // Some providers do not offer persistable grants; the current grant is still usable.
            }
            collectAudioDocuments(treeUri, DocumentsContract.getTreeDocumentId(treeUri), uris);
        }
        completePickedAudioImport(call, uris, resultCode);
    }

    private void collectAudioDocuments(Uri treeUri, String parentDocumentId, List<Uri> output) {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId);
        String[] projection = new String[]{
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor cursor = getContext().getContentResolver().query(childrenUri, projection, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String documentId = cursor.getString(0);
                String displayName = cursor.getString(1);
                String mimeType = cursor.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType)) {
                    collectAudioDocuments(treeUri, documentId, output);
                    continue;
                }
                if (isAudioDocument(displayName, mimeType)) {
                    output.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId));
                }
            }
        } catch (Exception ignored) {
            // A provider can deny one subtree without invalidating the rest of the selection.
        }
    }

    private static boolean isAudioDocument(String displayName, String mimeType) {
        if (mimeType != null && mimeType.startsWith("audio/")) return true;
        String lower = displayName == null ? "" : displayName.toLowerCase(Locale.ROOT);
        return lower.endsWith(".mp3") || lower.endsWith(".flac") || lower.endsWith(".wav")
            || lower.endsWith(".m4a") || lower.endsWith(".aac") || lower.endsWith(".ogg")
            || lower.endsWith(".opus") || lower.endsWith(".ape") || lower.endsWith(".wma");
    }

    /**
     * 拷完之后的出口：挑文件那条路要给 PluginCall，外部打开那条路要给 Web 层的事件，
     * 中间这一份流水（复制 + 去重 + 记 failure）两边共用。
     */
    private interface AudioImportSink {
        void complete(JSObject result);
        void fail(String message, Exception error);
    }

    private void completePickedAudioImport(PluginCall call, List<Uri> uris, int resultCode) {
        if (uris.isEmpty()) {
            JSObject result = new JSObject();
            result.put("tracks", new JSArray());
            result.put("cancelled", resultCode != Activity.RESULT_OK);
            result.put("picked", 0);
            result.put("resultCode", resultCode);
            if (resultCode == Activity.RESULT_OK) {
                result.put("error", "Picker returned RESULT_OK without a readable document uri");
            }
            call.resolve(result);
            return;
        }

        final Activity activity = getActivity();
        importAudioFiles(uris, resultCode, new AudioImportSink() {
            @Override
            public void complete(JSObject result) {
                if (activity != null) activity.runOnUiThread(() -> call.resolve(result));
                else call.resolve(result);
            }

            @Override
            public void fail(String message, Exception error) {
                if (activity != null) activity.runOnUiThread(() -> call.reject(message, error));
                else call.reject(message, error);
            }
        });
    }

    /**
     * 把一组 uri 拷进 App 私有目录：本地曲库所有能播的音频都得先从这里过一遍。
     *
     * 两条入口共用：系统文件管理器挑中的（completePickedAudioImport）与外部应用
     * 「用 Folia 打开 / 分享过来」的（noteExternalAudioUris）。
     */
    private void importAudioFiles(List<Uri> uris, int resultCode, AudioImportSink sink) {
        // 拷贝是重活：一次导入几十上百个文件，放在调用线程上会把界面卡死，
        // 所以整个搬进后台线程，完成后再回到 UI 线程交给出口。
        final Activity activity = getActivity();
        new Thread(() -> {
          try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            int port = localAudioServer.start();
            File directory = localAudioServer.importedAudioDirectory();
            ContentResolver resolver = getContext().getContentResolver();
            JSArray tracks = new JSArray();
            JSArray failures = new JSArray();
            int copied = 0;

            for (Uri uri : uris) {
                try {
                    String displayName = queryDisplayName(resolver, uri);
                    long fileSize = queryFileSize(resolver, uri);
                    if (displayName == null || displayName.isEmpty()) displayName = "track-" + System.currentTimeMillis();
                    String safeName = "imported-" + stableFileId(displayName, fileSize, directory);
                    File target = new File(directory, safeName);
                    boolean alreadyThere = target.isFile() && target.length() > 0
                        && (fileSize <= 0 || target.length() == fileSize);
                    if (!alreadyThere) {
                        // 这里不能再叫 sink：外层方法的回调参数就叫 sink（AudioImportSink）。
                        try (InputStream source = resolver.openInputStream(uri);
                             OutputStream copyOut = new FileOutputStream(target)) {
                            if (source == null) continue;
                            byte[] buffer = new byte[128 * 1024];
                            int read;
                            while ((read = source.read(buffer)) != -1) {
                                copyOut.write(buffer, 0, read);
                            }
                        }
                    }
                    /*
                     * 拷出来是 0 字节（provider 授权失效、openInputStream 静默失败等）绝对不能进库：
                     * <audio> 播它会报一句莫名的 MEDIA_ELEMENT_ERROR: Format error，用户只会看到
                     * "本地播放有 bug"。这里删掉空文件、记进 failures，让上层能看见。
                     */
                    if (target.length() <= 0) {
                        target.delete();
                        JSObject failure = new JSObject();
                        failure.put("uri", String.valueOf(uri));
                        failure.put("message", "Copied file is empty: " + displayName);
                        failures.put(failure);
                        continue;
                    }

                    JSObject track = new JSObject();
                    track.put("id", safeName);
                    track.put("fileName", displayName);
                    track.put("fileSize", target.length());
                    track.put("mimeType", LocalAudioServer.guessMimeType(safeName));
                    track.put("url", "http://127.0.0.1:" + port + "/audio/" + safeName);
                    tracks.put(track);
                    copied += 1;
                } catch (Exception error) {
                    // 单个文件读不了不该让整批失败，但必须把原因带回去，
                    // 否则界面只会「什么都没发生」。
                    JSObject failure = new JSObject();
                    failure.put("uri", String.valueOf(uri));
                    failure.put("message", error.getMessage() == null ? error.toString() : error.getMessage());
                    failures.put(failure);
                }
            }

            JSObject result = new JSObject();
            result.put("tracks", tracks);
            result.put("port", port);
            result.put("picked", uris.size());
            result.put("copied", copied);
            result.put("failures", failures);
            result.put("resultCode", resultCode);
            if (activity != null) activity.runOnUiThread(() -> sink.complete(result));
            else sink.complete(result);
          } catch (Exception error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            if (activity != null) activity.runOnUiThread(() -> sink.fail(message, error));
            else sink.fail(message, error);
          }
        }, "folia-audio-import").start();
    }

    /** 文件名 + 大小定出一个稳定的 id：重复导入同一个文件不会在私有目录里堆出第二份副本。 */
    private static String stableFileId(String displayName, long fileSize, File directory) {
        String candidate = displayName.replaceAll("[^A-Za-z0-9._-]", "_");
        if (candidate.length() > 60) {
            candidate = candidate.substring(candidate.length() - 60);
        }
        int dot = candidate.lastIndexOf('.');
        String base = dot > 0 ? candidate.substring(0, dot) : candidate;
        String extension = dot > 0 ? candidate.substring(dot) : "";
        String stamp = Integer.toHexString((displayName + ':' + fileSize).hashCode());
        return base + "-" + stamp + extension;
    }

    private static String queryDisplayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last == null ? null : last.substring(last.lastIndexOf('/') + 1);
    }

    private static long queryFileSize(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getLong(0);
        } catch (Exception ignored) {
        }
        return -1;
    }

    /**
     * 设备音乐库扫描：这是文件选择器之外的入口，读的是系统已经收录的音频，
     * 不需要用户自己去文件管理器里翻。
     *
     * 媒体库一首都没扫到时：
     * · 没有所有文件访问 → 回包里带 needsAllFilesAccess，让 Web 层引导用户去开；
     * · 已经开了 → 直接按目录走文件系统兜底扫描（有的 ROM 收录不全，音乐躺在
     *   Download/Music 之外的角落里，MediaStore 永远看不到）。
     */
    private void resolveLocalAudioScan(PluginCall call) {
        try {
            if (localAudioServer == null) {
                localAudioServer = new LocalAudioServer(getContext());
            }
            int port = localAudioServer.start();
            JSArray tracks = new JSArray();
            String[] projection = new String[]{
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.MIME_TYPE
            };
            // IS_MUSIC != 0：把录音、通知音、语音消息这些"也是音频但不是歌"的东西滤掉。
            try (Cursor cursor = getContext().getContentResolver().query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                projection,
                MediaStore.Audio.Media.IS_MUSIC + " != 0",
                null,
                MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC"
            )) {
                if (cursor != null) {
                    int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                    int nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
                    int titleColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                    int artistColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                    int albumColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                    int durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                    int sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
                    int mimeColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE);
                    while (cursor.moveToNext()) {
                        long id = cursor.getLong(idColumn);
                        JSObject track = new JSObject();
                        track.put("id", String.valueOf(id));
                        track.put("fileName", cursor.getString(nameColumn));
                        track.put("title", cursor.getString(titleColumn));
                        track.put("artist", cursor.getString(artistColumn));
                        track.put("album", cursor.getString(albumColumn));
                        track.put("duration", cursor.getLong(durationColumn));
                        track.put("fileSize", cursor.getLong(sizeColumn));
                        track.put("mimeType", cursor.getString(mimeColumn));
                        track.put("url", "http://127.0.0.1:" + port + "/audio/" + id);
                        tracks.put(track);
                    }
                }
            }
            JSObject result = new JSObject();
            if (tracks.length() == 0 && isAllFilesAccessGranted()) {
                collectAudioFilesFromStorage(tracks, port);
            } else if (tracks.length() == 0) {
                result.put("needsAllFilesAccess", true);
            }
            result.put("tracks", tracks);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    /**
     * 「所有文件访问」是受限权限，弹窗要不来，只能跳系统设置让用户手动开。
     * 开完回到应用（onActivityResult 由 Capacitor 的 ActivityCallback 接住）再把结果带回 JS。
     */
    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (isAllFilesAccessGranted()) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity unavailable; cannot request all-files access.");
            return;
        }
        Intent intent = new Intent(
            Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.fromParts("package", activity.getPackageName(), null)
        );
        try {
            startActivityForResult(call, intent, "handleAllFilesAccessResult");
        } catch (Exception firstError) {
            // 有的 ROM 不认带包名的深链，退到通用的"所有文件访问"列表页。
            try {
                startActivityForResult(
                    call,
                    new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
                    "handleAllFilesAccessResult"
                );
            } catch (Exception secondError) {
                call.reject("No all-files access settings page on this device: "
                    + secondError.getMessage(), secondError);
            }
        }
    }

    @ActivityCallback
    private void handleAllFilesAccessResult(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        JSObject result = new JSObject();
        result.put("granted", isAllFilesAccessGranted());
        call.resolve(result);
    }

    private static boolean isAllFilesAccessGranted() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager();
    }

    /**
     * 文件系统兜底扫描：媒体库一首都没有、但用户给了所有文件访问时，直接翻外存目录。
     *
     * 只递归 Music / Download（外加它们的子目录），跳过隐藏目录与 Android/ 私有区，
     * 最多收 2000 首 —— 全盘翻既慢又会把系统目录翻出成千上万垃圾。
     * ref 是 `file-<绝对路径>`，播放地址按它拼，音频由 LocalAudioServer 的 file- 路由直接从原文件流出来，不复制。
     */
    private void collectAudioFilesFromStorage(JSArray tracks, int port) {
        File root = Environment.getExternalStorageDirectory();
        if (root == null || !root.isDirectory()) return;
        File music = new File(root, "Music");
        File download = new File(root, "Download");
        java.util.ArrayDeque<File> queue = new java.util.ArrayDeque<>();
        if (music.isDirectory()) queue.add(music);
        if (download.isDirectory()) queue.add(download);
        int collected = 0;
        int visited = 0;
        while (!queue.isEmpty() && collected < 2000 && visited < 20000) {
            File directory = queue.poll();
            File[] children = directory.listFiles();
            if (children == null) continue;
            for (File child : children) {
                visited += 1;
                String name = child.getName();
                if (child.isDirectory()) {
                    if (name.startsWith(".") || name.equals("Android")) continue;
                    queue.add(child);
                    continue;
                }
                if (!LocalAudioServer.isAudioFileName(name)) continue;
                String ref = "file-" + child.getAbsolutePath();
                JSObject track = new JSObject();
                track.put("id", ref);
                track.put("fileName", name);
                track.put("title", name.replaceFirst("\\.[^.]+$", ""));
                track.put("fileSize", child.length());
                track.put("mimeType", LocalAudioServer.guessMimeType(name));
                track.put("url", "http://127.0.0.1:" + port + "/audio/" + Uri.encode(ref));
                tracks.put(track);
                collected += 1;
                if (collected >= 2000) break;
            }
        }
    }

    /**
     * 删除「挑选文件 / 文件夹导入」时复制进私有目录的音频副本。
     *
     * 只删 App 自己的副本，绝不碰用户的原文件；MediaStore 扫描得到的歌不在这里删，
     * 它们只是引用，用户的原文件必须保留。
     */
    @PluginMethod
    public void deleteImportedAudio(PluginCall call) {
        JSArray refs = call.getArray("refs", new JSArray());
        JSArray deleted = new JSArray();
        JSArray failed = new JSArray();
        try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            File directory = localAudioServer.importedAudioDirectory();
            for (int index = 0; index < refs.length(); index += 1) {
                String ref = refs.getString(index);
                File target = resolveImportedFile(directory, ref);
                if (target == null) {
                    failed.put(ref);
                    continue;
                }
                // 已经不在了也算成功，重复删除不该被当成错误。
                if (!target.exists() || target.delete()) {
                    deleted.put(ref);
                } else {
                    failed.put(ref);
                }
            }
            JSObject result = new JSObject();
            result.put("deleted", deleted);
            result.put("failed", failed);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    /**
     * 把一个远端音频地址换成「本地服务代转发」的地址。
     *
     * Web 侧拿到的 CDN 直链（波点走 Kuwo）没有 CORS 头，而 <audio> 带
     * crossOrigin="anonymous"，于是字节根本进不来、报一句毫无特征的 Format error。
     * 这里换成 http://127.0.0.1:<port>/remote-audio/<token>，由原生代转并回包带 ACAO。
     * 失败（非白名单主机 / 服务起不来）时 resolve 成原地址，让播放照旧尝试一次直连，
     * 别因为代理本身出问题就把整首歌判死。
     */
    @PluginMethod
    public void registerRemoteAudio(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("url", url == null ? "" : url);
            empty.put("proxied", false);
            call.resolve(empty);
            return;
        }
        // 自建服务（飞牛）的音频流要带 `Cookie: music-token=...`，而且地址是用户自己填的、
        // 不在白名单里 —— 两者都只能由调用方显式声明。
        Map<String, String> headers = new HashMap<>();
        JSObject headerObject = call.getObject("headers");
        if (headerObject != null) {
            Iterator<String> headerNames = headerObject.keys();
            while (headerNames.hasNext()) {
                String headerName = headerNames.next();
                Object headerValue = headerObject.opt(headerName);
                if (headerValue != null) headers.put(headerName, String.valueOf(headerValue));
            }
        }
        boolean allowAnyHost = Boolean.TRUE.equals(call.getBoolean("allowAnyHost", false));
        try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            String proxied = localAudioServer.registerRemoteAudio(url, headers, allowAnyHost);
            JSObject result = new JSObject();
            result.put("url", proxied);
            result.put("proxied", true);
            call.resolve(result);
        } catch (Exception error) {
            JSObject result = new JSObject();
            result.put("url", url);
            result.put("proxied", false);
            result.put("error", String.valueOf(error.getMessage()));
            call.resolve(result);
        }
    }

    /**
     * 把一个 ref 指向的音频**复制一份进 App 私有目录**，返回 `imported-xxx` 形式的新 ref。
     *
     * 为什么需要它：MediaStore 那一路（扫描设备音乐库得到的歌）是按 id **现读用户原文件**的，
     * 这一环只要出问题 —— 文件被搬走、媒体库还没刷新、某个 ROM 不给读 ——
     * 播放就只剩一句「无法访问文件，请重新导入」，而用户的原文件根本没动过，
     * 让他重新导入整个文件夹毫无道理。复制进私有目录之后，播放只认 App 自己的副本，
     * 跟 MediaStore 收不收录、权限还在不在彻底脱钩，和「挑选导入」那条路一样稳。
     *
     * **只在真的播不出来时才调**（见 localMusicService.getAudioFromLocalSong），
     * 不是扫描时整库复制 —— 那会把几百首歌、几个 G 平白占一遍。
     */
    @PluginMethod
    public void copyLocalAudio(PluginCall call) {
        final String ref = call.getString("ref");
        if (ref == null || ref.isEmpty()) {
            call.reject("Missing audio ref");
            return;
        }
        final String fileName = call.getString("fileName");
        final long fileSize = call.getLong("fileSize", 0L);
        final Activity activity = getActivity();
        new Thread(() -> {
            JSObject result = new JSObject();
            try {
                if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
                localAudioServer.start();
                File directory = localAudioServer.importedAudioDirectory();
                String copied = materializeAudioCopy(directory, ref, fileName, fileSize);
                if (copied == null) {
                    File target = new File(directory, ref);
                    String why = ref.startsWith("imported-") && !target.isFile()
                        ? "private copy is gone and the original was not found in the media store"
                        : "source is unreachable";
                    Log.w(TAG, "copyLocalAudio failed for " + ref + ": " + why);
                    result.put("copied", false);
                    result.put("error", why + ": " + ref);
                } else {
                    result.put("copied", true);
                    result.put("ref", copied);
                }
            } catch (Exception error) {
                Log.w(TAG, "copyLocalAudio failed for " + ref, error);
                result.put("copied", false);
                result.put("error", error.getMessage() == null ? error.toString() : error.getMessage());
            }
            if (activity != null) activity.runOnUiThread(() -> call.resolve(result));
            else call.resolve(result);
        }, "folia-audio-copy").start();
    }

    /**
     * 按文件名 + 大小回媒体库里找原文件。
     *
     * 兜的是「私有副本没了、而这首歌本来是挑文件夹导入的」这种情况：
     * 挑选导入时只记了副本名，原文件的 Uri 没留下来，副本一旦丢了就没有任何退路 ——
     * 只能让用户重新导入整个文件夹。而原文件多半还躺在外部存储里、也被媒体库收录着，
     * 按「文件名 + 大小」把它找回来重新拷一遍，比让用户重导一遍合理得多。
     */
    private String copyFromMediaStoreByName(File directory, String fileName, long fileSize) {
        if (fileName == null || fileName.isEmpty()) return null;
        ContentResolver resolver = getContext().getContentResolver();
        String selection = fileSize > 0
            ? MediaStore.Audio.Media.DISPLAY_NAME + "=? AND " + MediaStore.Audio.Media.SIZE + "=?"
            : MediaStore.Audio.Media.DISPLAY_NAME + "=?";
        String[] args = fileSize > 0
            ? new String[]{ fileName, String.valueOf(fileSize) }
            : new String[]{ fileName };
        try (Cursor cursor = resolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                new String[]{ MediaStore.Audio.Media._ID },
                selection, args, null)) {
            if (cursor == null || !cursor.moveToFirst()) return null;
            long id = cursor.getLong(0);
            return materializeAudioCopy(directory, String.valueOf(id), fileName, fileSize);
        } catch (Exception error) {
            Log.w(TAG, "media store lookup failed for " + fileName, error);
            return null;
        }
    }

    /** 返回新 ref（imported-xxx）；源取不到、或拷出来是空的，都返回 null。 */
    private String materializeAudioCopy(File directory, String ref, String fileName, long fileSize)
            throws IOException {
        if (ref.startsWith("imported-")) {
            // 副本还在就没什么可做的；没了才回媒体库按文件名把原文件找回来重拷。
            File existing = new File(directory, ref);
            if (existing.isFile() && existing.length() > 0) return null;
            return copyFromMediaStoreByName(directory, fileName, fileSize);
        }

        ContentResolver resolver = getContext().getContentResolver();
        Uri sourceUri = null;
        File sourceFile = null;
        String displayName = null;

        if (ref.startsWith("file-")) {
            sourceFile = new File(ref.substring("file-".length()));
            if (!sourceFile.isFile()) return null;
            displayName = sourceFile.getName();
            fileSize = sourceFile.length();
        } else {
            long mediaId;
            try {
                mediaId = Long.parseLong(ref.trim());
            } catch (NumberFormatException error) {
                return null;
            }
            sourceUri = android.content.ContentUris.withAppendedId(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId);
            try (Cursor cursor = resolver.query(sourceUri, new String[]{
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.SIZE,
            }, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst()) return null;
                displayName = cursor.getString(0);
                fileSize = cursor.getLong(1);
            }
        }
        if (displayName == null || displayName.isEmpty()) displayName = "track-" + System.currentTimeMillis();

        File target = new File(directory, "imported-" + stableFileId(displayName, fileSize, directory));
        if (target.isFile() && target.length() > 0) return target.getName();

        InputStream source = sourceUri != null
            ? resolver.openInputStream(sourceUri)
            : new java.io.FileInputStream(sourceFile);
        if (source == null) return null;
        try (InputStream in = source; OutputStream sink = new FileOutputStream(target)) {
            byte[] buffer = new byte[128 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                sink.write(buffer, 0, read);
            }
        }
        // 拷出来是 0 字节（授权失效 / provider 静默失败）等于没拷：删掉，别留个坏文件。
        if (target.length() <= 0) {
            target.delete();
            return null;
        }
        return target.getName();
    }

    /** 只认自己拷进去的那些文件名，挡掉 ../ 这类越界的 ref。 */
    private static File resolveImportedFile(File directory, String ref) {
        if (ref == null || !ref.startsWith("imported-")) return null;
        if (ref.contains("/") || ref.contains("\\") || ref.contains("..")) return null;
        return new File(directory, ref);
    }

    /**
     * 「播放时保持屏幕常亮」。
     *
     * 实现就是给 Activity 的窗口挂 / 摘 `FLAG_KEEP_SCREEN_ON`：它只作用于**这个窗口在前台
     * 的时候**，不持有任何 WakeLock，所以应用退到后台后系统照常熄屏 —— 不存在"忘了放就
     * 一直耗电"这回事，也正因为这样才选它而不是 PowerManager 的锁。
     *
     * 值由 Web 侧算好再传（开关 && 正在播放）：原生这边不该知道"什么算在播"。
     */
    /**
     * 弹一条系统小气泡（Toast）。
     *
     * 为什么需要它：应用退到后台后界面根本没人看 —— Web 层的提示条要等回到前台才显示，
     * 那时用户只记得「放着放着就没声了」。播放出错偏偏是后台最要命的一类（没登录、试听
     * 限制、网络断了），得当场说出来。Toast 由系统画在我们的窗口之外，后台也照常冒出来。
     *
     * 只用系统默认样式的**纯文本** Toast：Android 11 起后台不允许弹自定义 view 的 Toast，
     * 纯文本这条路一直是通的。也不用通知渠道 —— 那是要授权、还会在通知栏留痕的重武器，
     * 一句「已跳到下一首」不该有那么大动静。
     *
     * 走主线程的 Handler 而不是 Activity.runOnUiThread：Activity 这时多半已经 stop 甚至为
     * 空，而 Toast 用的是 Application 上下文，只要有进程就能弹。
     */
    @PluginMethod
    public void showToast(PluginCall call) {
        final String text = call.getString("text", "");
        final boolean longDuration = Boolean.TRUE.equals(call.getBoolean("long", false));
        final String message = text == null ? "" : text;
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            try {
                Toast.makeText(getContext(), message,
                        longDuration ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT).show();
            } catch (Throwable ignored) {
                // 上下文已经没了（进程正在收尾）：一句提示不值得再抛出点什么。
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void setScreenAwake(PluginCall call) {
        boolean awake = Boolean.TRUE.equals(call.getBoolean("awake", false));
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                try {
                    if (awake) {
                        activity.getWindow().addFlags(
                                android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    } else {
                        activity.getWindow().clearFlags(
                                android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                } catch (Throwable ignored) {
                    // Activity 正在 finishing：窗口已经没了。
                }
            });
        }
        call.resolve();
    }

    /*
     * 音频焦点策略：后台要不要允许与其它音源同时播放。
     *
     * 值**落盘**（见 FoliaAudioFocus 的说明）：WebView 是在它自己要请求音频焦点时才来
     * 向 Application 要 AudioManager 的，冷启动后第一次播放就发生在这之前 —— 那时
     * Web 层还没跑到，只有磁盘上的值能决定给出去的是哪一种 AudioManager。
     */
    @PluginMethod
    public void setAudioFocusPolicy(PluginCall call) {
        boolean mixWithOthers = Boolean.TRUE.equals(call.getBoolean("mixWithOthers", false));
        top.izuna.foliamajor.audio.FoliaAudioFocus.setMixWithOthers(getContext(), mixWithOthers);
        call.resolve();
    }

    @PluginMethod
    public void getPhoneFitLayout(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", PhoneLayoutOrientation.isEnabled(getContext()));
        result.put("orientation", PhoneLayoutOrientation.getOrientation(getContext()));
        call.resolve(result);
    }

    /** 挖孔现场，供诊断用（屏幕高度 / decor 高度 / 残留 padding / 挖孔矩形）。 */
    @PluginMethod
    public void getDisplayCutout(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(PhoneFitCutout.describe(getActivity())));
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    /** 手机布局开关顺带锁方向：开＝锁竖屏（或横屏），关＝跟随系统。 */
    @PluginMethod
    public void setPhoneFitLayout(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        String orientation = call.getString("orientation", PhoneLayoutOrientation.getOrientation(getContext()));
        PhoneLayoutOrientation.update(getContext(), enabled, orientation);
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> PhoneLayoutOrientation.apply(activity));
        }
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        result.put("orientation", PhoneLayoutOrientation.getOrientation(getContext()));
        call.resolve(result);
    }

    private List<JSObject> parseCookieHeader(String header, String domain) {
        List<JSObject> cookies = new ArrayList<>();
        if (header == null || header.isEmpty()) return cookies;
        String[] pairs = header.split(";");
        for (String pair : pairs) {
            int separator = pair.indexOf('=');
            if (separator <= 0) continue;
            String name = pair.substring(0, separator).trim();
            String value = pair.substring(separator + 1).trim();
            if (name.isEmpty()) continue;
            JSObject cookie = new JSObject();
            cookie.put("name", name);
            cookie.put("value", value);
            cookie.put("domain", domain == null ? "" : domain);
            cookie.put("path", "/");
            cookie.put("secure", true);
            cookie.put("httpOnly", false);
            cookies.add(cookie);
        }
        return cookies;
    }
}
