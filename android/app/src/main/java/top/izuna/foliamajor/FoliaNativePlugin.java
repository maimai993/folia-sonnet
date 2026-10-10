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
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.CookieManager;

import androidx.activity.result.ActivityResult;

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

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.URL;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

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
    private static volatile FoliaNativePlugin instance;

    /** 文件/文件夹选择器只用一份：连点两次会开两个系统界面，回来的回调就串了。 */
    private boolean isAudioPickerOpen = false;
    private LocalAudioServer localAudioServer;

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build();

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        super.handleOnDestroy();
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
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build();
            }

            String requestUrl = url;
            try (Response response = requestClient.newCall(builder.build()).execute()) {
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
            }
        } catch (IOException | IllegalArgumentException error) {
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

    @PluginMethod
    public void exitApp(PluginCall call) {
        Activity activity = getActivity();
        call.resolve();
        if (activity != null) activity.runOnUiThread(activity::finish);
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

        // 拷贝是重活：一次导入几十上百个文件，放在调用线程上会把界面卡死，
        // 所以整个搬进后台线程，完成后再回到 UI 线程 resolve。
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
                        try (InputStream source = resolver.openInputStream(uri);
                             OutputStream sink = new FileOutputStream(target)) {
                            if (source == null) continue;
                            byte[] buffer = new byte[128 * 1024];
                            int read;
                            while ((read = source.read(buffer)) != -1) {
                                sink.write(buffer, 0, read);
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
            if (activity != null) activity.runOnUiThread(() -> call.resolve(result));
            else call.resolve(result);
          } catch (Exception error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            if (activity != null) activity.runOnUiThread(() -> call.reject(message, error));
            else call.reject(message, error);
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
        try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            String proxied = localAudioServer.registerRemoteAudio(url);
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
