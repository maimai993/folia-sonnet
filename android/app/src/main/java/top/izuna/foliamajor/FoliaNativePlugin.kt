package top.izuna.foliamajor
import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ContentResolver
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import android.util.Base64
import android.webkit.CookieManager
import android.widget.Toast

import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.lang.reflect.Method
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.ArrayList
import java.util.HashMap
import java.util.LinkedHashMap
import java.util.Locale
import java.util.concurrent.TimeUnit

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
// okhttp 4 是 Kotlin 写的：`MediaType.parse` / `RequestBody.create` 在 Kotlin 侧是 error 级
// 弃用（只在 Java 侧留了同名静态桥）。Kotlin 里要用伴生对象上的扩展函数。
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody

/**
 * 本地登录的原生底座。
 *
 * 内置在 App 里的那份接口代码（src/nativeBridge/api/ 下的 JS，从浏览器扩展搬过来的）需要两件
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
    permissions = [
        Permission(
            alias = "audio",
            strings = [Manifest.permission.READ_MEDIA_AUDIO]
        ),
        Permission(
            alias = "audioLegacy",
            strings = [Manifest.permission.READ_EXTERNAL_STORAGE]
        )
    ]
)
class FoliaNativePlugin : Plugin() {

    companion object {
        const val TAG = "FoliaNative"

        @Volatile
        private var instance: FoliaNativePlugin? = null

        /** 外部送进来的音频（externalAudio 事件名）。 */
        const val EXTERNAL_AUDIO_EVENT = "externalAudio"

        /** 更新包下载进度事件名。 */
        const val UPDATE_PROGRESS_EVENT = "updateDownloadProgress"

        /**
         * 安全区变化事件名。
         *
         * 网页那边的 env(safe-area-inset-*) 在安卓上不可信（只报挖孔、不报系统栏，无刘海全 0），
         * 真实数值由原生算出来（见 PhoneFitCutout.resolveInsets）发过去。
         */
        const val PHONE_INSETS_EVENT = "phoneInsets"

        /** 最近一次算出来的安全区；Web 层首屏用 getPhoneInsets 拉，之后靠事件推。 */
        @Volatile
        private var lastPhoneInsets: JSObject? = null

        /** 更新包落在缓存目录下的这一层。 */
        const val UPDATE_DIRECTORY = "updates"

        /** 进度事件节流间隔。 */
        const val UPDATE_PROGRESS_INTERVAL_MS = 100L

        /** 外部 intent 带来、还没开拷的 uri（冷启动时 Web 层可能比intent 晚一步）。 */
        private val pendingExternalUris: MutableList<String> = ArrayList()

        /** 拷完、但 Web 层还没领走的外部音频（没有监听者时就停在这里等它来取）。 */
        private val pendingExternalTracks: MutableList<JSObject> = ArrayList()

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
        private const val AI_CACHE_MAX_ENTRIES = 64
        private const val AI_CACHE_TTL_MS = 6 * 60 * 1000L
        private val aiCache: MutableMap<String, AiCacheCell> = object : LinkedHashMap<String, AiCacheCell>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, AiCacheCell>): Boolean {
                return size > AI_CACHE_MAX_ENTRIES
            }
        }

        private class AiCacheCell(val body: String, val at: Long)

        private fun readAiCacheBody(key: String, now: Long): String? {
            synchronized(aiCache) {
                val cell = aiCache[key]
                if (cell == null) return null
                if (now - cell.at > AI_CACHE_TTL_MS) {
                    aiCache.remove(key)
                    return null
                }
                return cell.body
            }
        }

        private fun writeAiCacheBody(key: String, body: String, now: Long) {
            synchronized(aiCache) {
                aiCache[key] = AiCacheCell(body, now)
            }
        }

        /** OkHttp 要求这些方法必须带 body（见 httpRequest 里的说明）。 */
        private fun requiresRequestBody(method: String?): Boolean {
            return "POST".equals(method, ignoreCase = true)
                || "PUT".equals(method, ignoreCase = true)
                || "PATCH".equals(method, ignoreCase = true)
        }

        /**
         * 按名字取一个请求头，**不区分大小写**。
         *
         * HTTP 头的名字本来就大小写不敏感（`Content-Type` 与 `content-type` 是同一个头），
         * 而 JSONObject 的键是敏感的 —— 只按小写问一次，来自别处的 `Content-Type` 就取不到。
         * JS 侧现在是 `new Headers(...)` 给的（都是小写），所以看起来没问题；但桥是公开的，
         * 手写一个头名字就能让它悄悄落空。缺了就返回 null（不是空串）：调用方一律按 null 判。
         */
        private fun optHeader(headers: JSObject?, name: String): String? {
            if (headers == null) return null
            val direct = headers.opt(name)
            if (direct != null) {
                // Kotlin 里 `String.valueOf` 不指到 java.lang.String（Kotlin 的 String 没有它），
                // 用 `Objects.toString` 兜 null 之外的一切值，语义与 Java 那份一致。
                val value = java.lang.String.valueOf(direct)
                return if (value.isEmpty()) null else value
            }
            val keys = headers.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (key != null && key.equals(name, ignoreCase = true)) {
                    val value = headers.opt(key)
                    if (value == null) return null
                    val text = java.lang.String.valueOf(value)
                    return if (text.isEmpty()) null else text
                }
            }
            return null
        }

        private val HEADER_HEX = "0123456789ABCDEF".toCharArray()

        /**
         * 把请求头的值压回 HTTP 允许的范围（0x20–0x7E 的可见 ASCII）。
         *
         * OkHttp 建请求时会逐个检查头的值，范围外的字符直接抛
         * `Unexpected char 0x4e1c at 414 in Cookie value` —— 真实踩到过：酷狗登录会把中文昵称
         * 写进 `KuGoo` / `NickName` 这两个 cookie（`buildKuGooCookieValue` 原样拼进去），
         * 之后 {@link #httpRequest} 每次都从 CookieManager 把它们带出去，于是**每一个**酷狗请求
         * 在建头这一步就炸，连发出去的机会都没有。页面侧看到的就是登录第一步
         * `operation=login_qr_key` 立刻失败、错误码还标成 `network`。
         *
         * 范围外的字符按 UTF-8 做百分号编码：本来就是 ASCII 的部分一个字节都不动，
         * token、签名、分隔符（`;` `=` `&`）照旧，只有那些本就不该出现在头里的字符换个写法。
         * 读回来的方向不用管 —— JS 的 `decodeKGCookieValue` 本来就做 `decodeURIComponent`。
         *
         * 只在这里（发送前）改、不写回 cookie 库：库里留原样，界面上显示昵称的那些路径
         * 拿到的还是「东」而不是 `%E4%B8%9C`。已经存了坏值的老机器也因此一并自愈。
         */
        private fun sanitizeHeaderValue(value: String?): String? {
            if (value == null || value.isEmpty()) return value
            var out: StringBuilder? = null
            var i = 0
            while (i < value.length) {
                val codePoint = value.codePointAt(i)
                val width = Character.charCount(codePoint)
                if (codePoint >= 0x20 && codePoint <= 0x7E) {
                    if (out != null) out.append(codePoint.toChar())
                } else {
                    if (out == null) {
                        out = StringBuilder(value.length + 16)
                        out.append(value, 0, i)
                    }
                    // 代理对（emoji 之类）要整块编码，拆成两个 char 各编一半是错的。
                    val bytes = String(Character.toChars(codePoint)).toByteArray(StandardCharsets.UTF_8)
                    for (raw in bytes) {
                        out.append('%')
                            .append(HEADER_HEX[(raw.toInt() shr 4) and 0xF])
                            .append(HEADER_HEX[raw.toInt() and 0xF])
                    }
                }
                i += width
            }
            return if (out == null) value else out.toString()
        }

        // 真实响应几乎都带 Path/Domain，但个别平台会整个省略 Path；CookieManager 遇到没有
        // Path 的 Set-Cookie 会直接忽略，这里补一个默认的，免得登录态存不下来。
        private fun normalizeCookieForUrl(requestUrl: String, rawCookie: String?): String? {
            if (rawCookie == null || rawCookie.isEmpty()) return null
            var hasPath = false
            for (attribute in rawCookie.split(";")) {
                if (attribute.trim().lowercase(Locale.getDefault()).startsWith("path=")) {
                    hasPath = true
                    break
                }
            }
            return if (hasPath) rawCookie else rawCookie + "; Path=/"
        }

        /** 只允许 `名字.apk`，其余字符一律换成 `_`，避免文件名里带路径分隔符写到别处去。 */
        private fun sanitizeUpdateFileName(rawName: String?): String {
            val trimmed = if (rawName == null) "" else rawName.trim()
            if (trimmed.isEmpty()) return "folia-update.apk"
            val flattened = trimmed.replace(Regex("[^A-Za-z0-9._-]"), "_")
            return if (flattened.endsWith(".apk")) flattened else flattened + ".apk"
        }

        private fun isAudioDocument(displayName: String?, mimeType: String?): Boolean {
            if (mimeType != null && mimeType.startsWith("audio/")) return true
            val lower = if (displayName == null) "" else displayName.lowercase(Locale.ROOT)
            return lower.endsWith(".mp3") || lower.endsWith(".flac") || lower.endsWith(".wav")
                || lower.endsWith(".m4a") || lower.endsWith(".aac") || lower.endsWith(".ogg")
                || lower.endsWith(".opus") || lower.endsWith(".ape") || lower.endsWith(".wma")
        }

        private fun isAllFilesAccessGranted(): Boolean {
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()
        }

        /** 文件名 + 大小定出一个稳定的 id：重复导入同一个文件不会在私有目录里堆出第二份副本。 */
        private fun stableFileId(displayName: String, fileSize: Long, directory: File): String {
            var candidate = displayName.replace(Regex("[^A-Za-z0-9._-]"), "_")
            if (candidate.length > 60) {
                candidate = candidate.substring(candidate.length - 60)
            }
            val dot = candidate.lastIndexOf('.')
            val base = if (dot > 0) candidate.substring(0, dot) else candidate
            val extension = if (dot > 0) candidate.substring(dot) else ""
            val stamp = Integer.toHexString((displayName + ':' + fileSize).hashCode())
            return base + "-" + stamp + extension
        }

        private fun queryDisplayName(resolver: ContentResolver, uri: Uri): String? {
            try {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null).use { cursor ->
                    if (cursor != null && cursor.moveToFirst()) return cursor.getString(0)
                }
            } catch (ignored: Exception) {
            }
            val last = uri.lastPathSegment
            return if (last == null) null else last.substring(last.lastIndexOf('/') + 1)
        }

        private fun queryFileSize(resolver: ContentResolver, uri: Uri): Long {
            try {
                resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null).use { cursor ->
                    if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getLong(0)
                }
            } catch (ignored: Exception) {
            }
            return -1
        }

        /** 只认自己拷进去的那些文件名，挡掉 ../ 这类越界的 ref。 */
        private fun resolveImportedFile(directory: File, ref: String?): File? {
            if (ref == null || !ref.startsWith("imported-")) return null
            if (ref.contains("/") || ref.contains("\\") || ref.contains("..")) return null
            return File(directory, ref)
        }

        /**
         * 把当前安全区（CSS px）发给网页。
         *
         * 从 PhoneFitCutout 的铺满流程与 inset 监听里调用，所以启动、转屏、系统栏临时划出
         * 都会重算一遍。没有实例或没有监听者时只更新缓存 —— 网页首屏会用 getPhoneInsets 拉。
         */
        @JvmStatic
        fun publishPhoneInsets(activity: Activity?) {
            if (activity == null) return
            val resolved = PhoneFitCutout.resolveInsets(activity)
            val payload = JSObject()
            try {
                payload.put("top", resolved.optInt("top", 0))
                payload.put("right", resolved.optInt("right", 0))
                payload.put("bottom", resolved.optInt("bottom", 0))
                payload.put("left", resolved.optInt("left", 0))
            } catch (error: Exception) {
                Log.w(TAG, "Failed to build phone insets payload", error)
                return
            }
            lastPhoneInsets = payload
            val plugin = instance
            if (plugin == null || !plugin.hasListeners(PHONE_INSETS_EVENT)) return
            val target = plugin
            activity.runOnUiThread { target.notifyListeners(PHONE_INSETS_EVENT, payload) }
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
        @JvmStatic
        fun peekPhoneInsets(): JSObject? {
            return lastPhoneInsets
        }

        /**
         * 返回键：先给 WebView 一个机会（弹层、设置页自己关掉自己），没人接管才退出。
         *
         * 返回 true 表示网页侧有监听者、事件已经派发出去，Activity 不要自己 finish。
         */
        @JvmStatic
        fun emitBackPressed(): Boolean {
            val plugin = instance
            if (plugin == null || !plugin.hasListeners("backButton")) return false
            val activity = plugin.getActivity()
            if (activity == null) return false
            val payload = JSObject()
            activity.runOnUiThread { plugin.notifyListeners("backButton", payload) }
            return true
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
        @JvmStatic
        fun emitAppBackground(background: Boolean) {
            val plugin = instance
            if (plugin == null || !plugin.hasListeners("appBackground")) return
            val activity = plugin.getActivity()
            if (activity == null) return
            val payload = JSObject()
            payload.put("background", background)
            activity.runOnUiThread { plugin.notifyListeners("appBackground", payload) }
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
        @JvmStatic
        fun noteExternalAudioUris(uris: List<Uri>?) {
            if (uris == null || uris.isEmpty()) return
            synchronized(pendingExternalUris) {
                for (uri in uris) {
                    if (uri == null) continue
                    val raw = uri.toString()
                    if (!pendingExternalUris.contains(raw)) pendingExternalUris.add(raw)
                }
            }
            val plugin = instance
            if (plugin != null) plugin.startExternalAudioImport()
        }
    }

    /** 文件/文件夹选择器只用一份：连点两次会开两个系统界面，回来的回调就串了。 */
    private var isAudioPickerOpen = false
    private var localAudioServer: LocalAudioServer? = null

    /** 同一时刻只跑一个更新下载：连点两次会写出两个文件，后一次覆盖前一次。 */
    private val updateDownloadLock = Any()

    @Volatile
    private var isUpdateDownloading = false

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build()

    /**
     * AI 请求专用的客户端：**连接共用 `client`，只放宽读超时**。
     *
     * `client` 那 45 秒是给普通接口的（云缓存、歌词、平台接口都是秒级往返）。AI 生成不是：
     * 一次主题 + 动画决策的往返 60 秒以上是常态，45 秒一到 `onFailure` 直接 reject，
     * 而那时 JS 多半已经切走了 —— 表现就是「后台切歌 AI 主题一次都不生成」。
     * 这条链路专门从 `httpRequest` 挪过来就是为了修那个问题，超时卡在这里等于换个地方复发。
     *
     * 用 `newBuilder()` 派生而不是另建一个：连接池、DNS 缓存、拦截器全部共用，
     * 不会因为多一个客户端多开一套线程与连接。
     */
    private val aiClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(150, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    /**
     * 读一条 AI 云缓存：命中原生副本就直接回，否则发一次请求并把命中的答案留下来。
     *
     * 回的是**服务端响应体原文**（字符串），不由原生去解析 JSON —— Capacitor 的嵌套对象
     * 转换在个别版本上会把内层对象丢成 null，字符串零歧义。
     */
    @PluginMethod
    fun aiCloudCacheGet(call: PluginCall) {
        val key = call.getString("key", "")
        val url = call.getString("url", "")
        if (key == null || key.isEmpty() || url == null || url.isEmpty()) {
            call.reject("Missing cache key or url")
            return
        }

        val cached = readAiCacheBody(key, System.currentTimeMillis())
        if (cached != null) {
            val result = JSObject()
            result.put("ok", true)
            result.put("body", cached)
            result.put("cached", true)
            call.resolve(result)
            return
        }

        try {
            val request = Request.Builder()
                .url(url)
                .get()
                .header("Accept", "application/json")
                .build()
            // 与 httpRequest 同理：等待交给 OkHttp 的线程池，别占着桥线程。
            call.setKeepAlive(true)
            client.newCall(request).enqueue(object : Callback {
                override fun onFailure(httpCall: Call, error: IOException) {
                    call.reject(error.message, error)
                }

                override fun onResponse(httpCall: Call, response: Response) {
                    try {
                        response.use { body ->
                            val responseBody = body.body
                            val text = if (responseBody == null) "" else responseBody.string()
                            val ok = body.isSuccessful
                            if (ok && !text.isEmpty() && text.contains("\"hit\":true")) {
                                writeAiCacheBody(key, text, System.currentTimeMillis())
                            }
                            val result = JSObject()
                            result.put("ok", ok)
                            result.put("body", text)
                            result.put("cached", false)
                            call.resolve(result)
                        }
                    } catch (error: IOException) {
                        call.reject(error.message, error)
                    } catch (error: IllegalArgumentException) {
                        call.reject(error.message, error)
                    }
                }
            })
        } catch (error: IllegalArgumentException) {
            call.reject(error.message, error)
        }
    }

    /**
     * 原生替网页发一次 AI 请求，把**响应体原文**交回去。
     *
     * 为什么不能只用 `httpRequest`：那条路是**网页发起**的，退到后台之后
     * WebView 的 JS 会被系统挂起 —— 请求的发起、以及回调回来那一刻的执行都卡在那儿，
     * 于是「后台切歌，AI 主题一次都不生成/不拉缓存」（用户原话）。
     * `aiCloudCacheGet` 已经按这个思路做过缓存那条支路；这里补上生成那条：
     * OkHttp 在自己的线程池里把整趟做完，网页什么时候回来问都能拿到结果。
     *
     * 请求的构造（URL / 头 / body）完全由网页算好传下来 —— 各家服务商的协议、
     * 密钥、提示词都在 JS 那一份里维护，原生不复制一遍，免得两边漂移。
     * 这里只负责「发出去、拿回文本」。
     */
    @PluginMethod
    fun aiRequest(call: PluginCall) {
        val url = call.getString("url", "")
        val bodyText = call.getString("body", "")
        if (url == null || url.isEmpty()) {
            call.reject("Missing request url")
            return
        }
        try {
            val builder = Request.Builder().url(url)
            val headers = call.getObject("headers")
            if (headers != null) {
                val headerNames = headers.keys()
                while (headerNames.hasNext()) {
                    // keys() 的迭代器把元素标成可空（JSObject 键理论上是 null），
                    // OkHttp 的 header() 要非空 —— 空键直接跳过。
                    val headerName = headerNames.next() ?: continue
                    val headerValue = headers.opt(headerName)
                    if (headerValue != null) {
                        // 同 optHeader：`String.valueOf` 在 Kotlin 侧不指到 java.lang.String；
                        // sanitize 可能整体清空，清空就别带这个头。
                        val safeHeader = sanitizeHeaderValue(java.lang.String.valueOf(headerValue))
                        if (safeHeader != null) builder.header(headerName, safeHeader)
                    }
                }
            }
            val method = call.getString("method", "POST") ?: "POST"
            var body: RequestBody? = null
            if (bodyText != null && bodyText.isNotEmpty()) {
                val contentType = if (headers == null) null else optHeader(headers, "content-type")
                val mediaType = (if (contentType == null || contentType.isEmpty())
                    "application/json;charset=UTF-8" else contentType).toMediaTypeOrNull()
                body = bodyText.toRequestBody(mediaType)
            }
            if (body == null && requiresRequestBody(method)) {
                body = ByteArray(0).toRequestBody(null)
            }
            builder.method(method, body)
            // AI 的往返本来就慢，读超时由 aiClient 放宽到 150 秒；等待交给 OkHttp 线程池，不占桥线程。
            call.setKeepAlive(true)
            aiClient.newCall(builder.build()).enqueue(object : Callback {
                override fun onFailure(httpCall: Call, error: IOException) {
                    call.reject(error.message, error)
                }

                override fun onResponse(httpCall: Call, response: Response) {
                    try {
                        response.use { result ->
                            val responseBody = result.body
                            val text = if (responseBody == null) "" else responseBody.string()
                            val out = JSObject()
                            out.put("ok", result.isSuccessful)
                            out.put("status", result.code)
                            out.put("body", text)
                            call.resolve(out)
                        }
                    } catch (error: IOException) {
                        call.reject(error.message, error)
                    }
                }
            })
        } catch (error: IllegalArgumentException) {
            call.reject(error.message, error)
        }
    }

    override fun load() {
        instance = this
        // 意图可能比 Web 层更早到（Activity.onCreate 交过来时 Bridge 还没建好），先攒在静态
        // 列表里；插件上线后立即拿去拷。
        startExternalAudioImport()
    }

    override fun handleOnDestroy() {
        if (instance === this) instance = null
        super.handleOnDestroy()
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
    fun setImmersive(call: PluginCall) {
        val immersive = java.lang.Boolean.TRUE.equals(call.getBoolean("immersive", false))
        val activity = getActivity()
        if (activity is MainActivity) {
            MainActivity.setImmersiveMode(activity, immersive)
        }
        call.resolve()
    }

    /*
     * 系统栏的**常驻**策略：平板与手机横屏把状态栏收起来（见 MainActivity.setSystemBarsPolicy）。
     *
     * 与 setImmersive 是「或」的关系、互不覆盖：歌词页本来就要全沉浸，这一条只是让它在
     * 别的页面也把状态栏收起来。判定在 Web 层（设备类型 + 朝向只有它知道），这里只执行。
     */
    @PluginMethod
    fun setSystemBarsPolicy(call: PluginCall) {
        val alwaysHidden = java.lang.Boolean.TRUE.equals(call.getBoolean("alwaysHidden", false))
        val activity = getActivity()
        if (activity is MainActivity) {
            MainActivity.setSystemBarsPolicy(activity, alwaysHidden)
        }
        call.resolve()
    }

    /** 网页首屏拉取安全区：事件只能覆盖「变了之后」，第一次的值得靠这一下。 */
    @PluginMethod
    fun getPhoneInsets(call: PluginCall) {
        val activity = getActivity()
        if (lastPhoneInsets == null && activity != null) {
            publishPhoneInsets(activity)
        }
        val payload = lastPhoneInsets
        call.resolve(if (payload == null) JSObject() else payload)
    }

    /**
     * 把拷好的外部音频交给 Web 层。
     *
     * 有监听者就发事件（顺手把 pending 清掉，免得之后 take 又把它们取一遍就重复入库）；
     * 没有就留在 pendingExternalTracks 里，等 Web 层起来自己来取。
     */
    private fun deliverExternalAudio(activity: Activity?, port: Int) {
        if (!hasListeners(EXTERNAL_AUDIO_EVENT)) return
        val tracks = JSArray()
        synchronized(pendingExternalTracks) {
            for (track in pendingExternalTracks) tracks.put(track)
            pendingExternalTracks.clear()
        }
        if (tracks.length() == 0) return
        val payload = JSObject()
        payload.put("tracks", tracks)
        if (port > 0) payload.put("port", port)
        val emit = Runnable { notifyListeners(EXTERNAL_AUDIO_EVENT, payload) }
        if (activity != null) activity.runOnUiThread(emit)
        else emit.run()
    }

    /** 把待处理的外部音频拷进私有目录；拷完交给下面的 deliverExternalAudio。 */
    private fun startExternalAudioImport() {
        val uris = ArrayList<Uri>()
        synchronized(pendingExternalUris) {
            for (raw in pendingExternalUris) {
                try {
                    uris.add(Uri.parse(raw))
                } catch (ignored: Exception) {
                    // 解析不了的 uri 直接放弃，别让它把整批拖住。
                }
            }
            pendingExternalUris.clear()
        }
        if (uris.isEmpty()) return

        val activity = getActivity()
        importAudioFiles(uris, Activity.RESULT_OK, object : AudioImportSink {
            override fun complete(result: JSObject) {
                // optJSONArray / optJSONObject 声明的返回类型是 org.json 的那两个（JSArray / JSObject
                // 只是它们的子类），取出来只能按父类型接，再转回 Capacitor 这一对。
                val tracks = result.optJSONArray("tracks")
                synchronized(pendingExternalTracks) {
                    for (index in 0 until (tracks?.length() ?: 0)) {
                        val track = tracks!!.optJSONObject(index)
                        if (track == null) continue
                        if (track is JSObject) {
                            pendingExternalTracks.add(track)
                            continue
                        }
                        // 兜一条：上游哪天给的是普通的 org.json 对象，复制成 Capacitor 的那一种。
                        try {
                            pendingExternalTracks.add(JSObject.fromJSONObject(track))
                        } catch (ignored: JSONException) {
                            Log.w(TAG, "External audio track is not a JSON object")
                        }
                    }
                }
                deliverExternalAudio(activity, result.optInt("port", 0))
            }

            override fun fail(message: String, error: Exception) {
                Log.w(TAG, "External audio import failed: " + message, error)
            }
        })
    }

    @PluginMethod
    fun cookiesGetAll(call: PluginCall) {
        var url = call.getString("url", "")
        val domain = call.getString("domain", "")
        if (url == null || url.isEmpty()) {
            url = if (domain == null || domain.isEmpty()) {
                "https://localhost/"
            } else {
                if (domain.startsWith("http")) domain else "https://" + domain
            }
        }

        val cookies = JSArray()
        for (cookie in parseCookieHeader(CookieManager.getInstance().getCookie(url), domain)) {
            cookies.put(cookie)
        }
        val result = JSObject()
        result.put("cookies", cookies)
        call.resolve(result)
    }

    @PluginMethod
    fun cookiesGet(call: PluginCall) {
        val url = call.getString("url", "https://localhost/")
        val name = call.getString("name", "")
        if (name == null || name.isEmpty()) {
            call.reject("Missing cookie name")
            return
        }
        for (cookie in parseCookieHeader(CookieManager.getInstance().getCookie(url), "")) {
            if (name == cookie.optString("name")) {
                val result = JSObject()
                result.put("cookie", cookie)
                call.resolve(result)
                return
            }
        }
        val result = JSObject()
        result.put("cookie", null)
        call.resolve(result)
    }

    @PluginMethod
    fun cookiesSet(call: PluginCall) {
        val url = call.getString("url", "")
        val name = call.getString("name", "")
        val value = call.getString("value", "")
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required")
            return
        }

        val cookie = StringBuilder()
        cookie.append(name).append('=').append(if (value == null) "" else value)
        val domain = call.getString("domain", "")
        val path = call.getString("path", "/")
        if (domain != null && !domain.isEmpty()) cookie.append("; domain=").append(domain)
        if (path != null && !path.isEmpty()) cookie.append("; path=").append(path)
        if (java.lang.Boolean.TRUE.equals(call.getBoolean("secure", false))) cookie.append("; Secure")
        val expirationDate = call.getDouble("expirationDate")
        if (expirationDate != null) {
            cookie.append("; Max-Age=").append(Math.max(0.0, expirationDate - System.currentTimeMillis() / 1000.0).toInt())
        }

        CookieManager.getInstance().setCookie(url, cookie.toString())
        CookieManager.getInstance().flush()
        val result = JSObject()
        result.put("ok", true)
        call.resolve(result)
    }

    @PluginMethod
    fun cookiesRemove(call: PluginCall) {
        val url = call.getString("url", "")
        val name = call.getString("name", "")
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required")
            return
        }
        CookieManager.getInstance().setCookie(url, name + "=; Max-Age=0; path=/")
        CookieManager.getInstance().flush()
        val result = JSObject()
        result.put("ok", true)
        call.resolve(result)
    }

    /**
     * 批量删除 cookie：entries 是 [{url, name}, ...]。
     *
     * 逐条删除每条都要过一次桥并在原生侧 flush 一次，切换登录通道要清几十条，
     * 累加起来会超过调用方的截止时间，结果只清掉一半 —— 剩下一半旧凭据会把新登录
     * 拼成一个用不了的会话。所以这里在原生侧一次做完。
     */
    @PluginMethod
    fun cookiesRemoveBatch(call: PluginCall) {
        val entries = call.getArray("entries")
        if (entries == null || entries.length() == 0) {
            val empty = JSObject()
            empty.put("ok", true)
            empty.put("removed", 0)
            call.resolve(empty)
            return
        }
        val manager = CookieManager.getInstance()
        var removed = 0
        for (index in 0 until entries.length()) {
            val entry = entries.optJSONObject(index)
            if (entry == null) continue
            val url = entry.optString("url", "")
            val name = entry.optString("name", "")
            if (url == null || url.isEmpty() || name == null || name.isEmpty()) continue
            manager.setCookie(url, name + "=; Max-Age=0; path=/")
            removed++
        }
        if (removed > 0) manager.flush()
        val result = JSObject()
        result.put("ok", true)
        result.put("removed", removed)
        call.resolve(result)
    }

    @PluginMethod
    fun httpRequest(call: PluginCall) {
        val url = call.getString("url", "")
        val method = call.getString("method", "GET")
        val bodyText = call.getString("bodyText", "")
        val bodyBase64 = call.getString("bodyBase64", "")
        val redirect = call.getString("redirect", "follow")
        if (url == null || url.isEmpty()) {
            call.reject("Missing request url")
            return
        }

        try {
            val builder = Request.Builder().url(url)
            val headers = call.getObject("headers")
            if (headers != null) {
                val headerNames = headers.keys()
                while (headerNames.hasNext()) {
                    // keys() 的元素标可空，OkHttp 要非空；空键跳过。
                    val headerName = headerNames.next() ?: continue
                    val headerValue = headers.opt(headerName)
                    if (headerValue != null) {
                        // 头的值必须是可见 ASCII，否则 OkHttp 当场抛（见 sanitizeHeaderValue 的说明）。
                        // 同前：`String.valueOf` 在 Kotlin 侧不指到 java.lang.String；清空则不带。
                        val safeHeader = sanitizeHeaderValue(java.lang.String.valueOf(headerValue))
                        if (safeHeader != null) builder.header(headerName, safeHeader)
                    }
                }
            }
            // OkHttp 这里没有 cookie jar，所以要把 WebView 的 cookie 库自己带上，
            // 除非调用方已经显式塞了 Cookie 头。
            if (headers == null || optHeader(headers, "cookie") == null) {
                val storedCookies = CookieManager.getInstance().getCookie(url)
                if (storedCookies != null && !storedCookies.isEmpty()) {
                    // sanitize 可能整体清空（极端脏值），那就干脆不带这个头。
                    val safeCookie = sanitizeHeaderValue(storedCookies)
                    if (safeCookie != null) builder.header("Cookie", safeCookie)
                }
            }

            var body: RequestBody? = null
            if (bodyBase64 != null && !bodyBase64.isEmpty()) {
                body = Base64.decode(bodyBase64, Base64.DEFAULT).toRequestBody("application/octet-stream".toMediaTypeOrNull())
            } else if (bodyText != null && !bodyText.isEmpty()) {
                /*
                 * Content-Type 取不到时**不许传 null 给 MediaType.parse**：OkHttp 4 是 Kotlin 写的，
                 * 那个方法的参数是「非空接收者」，传 null 当场 NPE（`-parameter <this>` 那个报错就是它），
                 * 整条请求连发出去的机会都没有。
                 *
                 * 退回 `text/plain;charset=UTF-8` —— 这正是 fetch 对「字符串 body + 没指定类型」
                 * 的处理（浏览器就是这么发的）。少了这一层，那些 POST 一段裸字符串的接口在桌面上
                 * 好好的、到安卓上直接把插件方法抛穿。
                 */
                val contentType = if (headers == null) null else optHeader(headers, "content-type")
                val mediaType = (
                    if (contentType == null || contentType.isEmpty())
                        "text/plain;charset=UTF-8"
                    else
                        contentType).toMediaTypeOrNull()
                body = bodyText.toRequestBody(mediaType)
            }
            val requestMethod = if (method == null) "GET" else method
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
                body = ByteArray(0).toRequestBody(null)
            }
            if (body != null && "GET".equals(requestMethod, ignoreCase = true)) {
                // 有接口的播放地址是「GET + JSON body」，OkHttp 公开的 method() 不接受这种组合，
                // 只能先选好 GET 再用它自己的 setter 把校验过的 body 塞进去。
                builder.method("GET", null)
                try {
                    val setBody = Request.Builder::class.java.getMethod("setBody\$okhttp", RequestBody::class.java)
                    setBody.invoke(builder, body)
                } catch (error: ReflectiveOperationException) {
                    call.reject("GET request body is unsupported by this runtime", error)
                    return
                }
            } else {
                builder.method(requestMethod, body)
            }

            var requestClient = client
            if ("manual" == redirect) {
                requestClient = requestClient.newBuilder()
                    .followRedirects(false)
                    .followSslRedirects(false)
                    .build()
            }
            // AI 请求可能远超默认的 45s 读超时，调用方可以按需放宽。
            val timeoutMs = call.getInt("timeoutMs")
            if (timeoutMs != null && timeoutMs > 0) {
                requestClient = requestClient.newBuilder()
                    .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                    .writeTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                    .build()
            }

            // 回调里要用，必须是 final：上面这两段按条件重建过 client。
            val executeClient = requestClient
            val requestUrl = url
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
            call.setKeepAlive(true)
            executeClient.newCall(builder.build()).enqueue(object : Callback {
                override fun onFailure(httpCall: Call, error: IOException) {
                    call.reject(error.message, error)
                }

                override fun onResponse(httpCall: Call, response: Response) {
                    try {
                        response.use { body ->
                            // 重复出现的响应头（Set-Cookie）要给 JS 一个数组，用对象会把重复的折叠掉。
                            val responseHeaders = JSArray()
                            for (name in response.headers.names()) {
                                for (value in response.headers.values(name)) {
                                    val headerEntry = JSObject()
                                    headerEntry.put("name", name)
                                    headerEntry.put("value", value)
                                    responseHeaders.put(headerEntry)
                                }
                            }
                            storeResponseCookies(requestUrl, response)
                            val responseBody = response.body
                            val bytes = if (responseBody == null) ByteArray(0) else responseBody.bytes()
                            val result = JSObject()
                            result.put("status", response.code)
                            result.put("headers", responseHeaders)
                            result.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                            call.resolve(result)
                        }
                    } catch (error: IOException) {
                        call.reject(error.message, error)
                    } catch (error: IllegalArgumentException) {
                        call.reject(error.message, error)
                    }
                }
            })
        } catch (error: IllegalArgumentException) {
            // 拼 URL / 建请求这一步才会抛（响应相关的 IOException 在回调里各自处理）。
            call.reject(error.message, error)
        }
    }

    /**
     * 把响应里的 Set-Cookie 存回 WebView 的 cookie 库。
     *
     * 登录能不能保持住全靠这一步：登录接口下发的 MUSIC_U / qqmusic_key 之类的凭据，
     * 之后每次请求都要由 {@link #httpRequest} 从这里读出来带上。
     */
    private fun storeResponseCookies(requestUrl: String, response: Response) {
        val setCookies = response.headers.values("Set-Cookie")
        if (setCookies.isEmpty()) return
        val manager = CookieManager.getInstance()
        var changed = false
        for (rawCookie in setCookies) {
            val cookie = normalizeCookieForUrl(requestUrl, rawCookie)
            if (cookie == null || cookie.isEmpty()) continue
            manager.setCookie(requestUrl, cookie)
            changed = true
        }
        if (changed) manager.flush()
    }

    /**
     * 真正的退出：销毁 Activity。
     *
     * 只有「确定要结束这次会话」才走它（例如设置里的退出项）。**返回键不归这里管** ——
     * 返回键走 {@link #moveToBackground}，见那边的说明。
     */
    @PluginMethod
    fun exitApp(call: PluginCall) {
        val activity = getActivity()
        call.resolve()
        if (activity != null) activity.runOnUiThread(activity::finish)
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
    fun moveToBackground(call: PluginCall) {
        val activity = getActivity()
        call.resolve()
        if (activity != null) {
            activity.runOnUiThread { activity.moveTaskToBack(true) }
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
    fun downloadUpdate(call: PluginCall) {
        val url = call.getString("url", "")
        val fileName = call.getString("fileName", "")
        if (url == null || url.isEmpty()) {
            call.reject("Missing update download url")
            return
        }
        val safeName = sanitizeUpdateFileName(fileName)

        synchronized(updateDownloadLock) {
            if (isUpdateDownloading) {
                call.reject("An update download is already running")
                return
            }
            isUpdateDownloading = true
        }

        var receivedBytes = 0L
        var target: File? = null
        try {
            val directory = File(getContext().cacheDir, UPDATE_DIRECTORY)
            if (!directory.exists() && !directory.mkdirs()) {
                throw IOException("Unable to create update directory")
            }
            target = File(directory, safeName)
            if (target.exists() && !target.delete()) {
                throw IOException("Unable to remove a stale update file")
            }

            val request = Request.Builder().url(url).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IOException("Update download failed with HTTP " + response.code)
                }
                val body = response.body
                if (body == null) {
                    throw IOException("Update download returned an empty body")
                }
                val totalBytes = body.contentLength()
                var lastEmitAt = 0L
                FileOutputStream(target!!).use { sink ->
                    body.byteStream().use { source ->
                        val buffer = ByteArray(64 * 1024)
                        var read = source.read(buffer)
                        while (read != -1) {
                            sink.write(buffer, 0, read)
                            receivedBytes += read
                            // 每 100ms 推一次就够了：WebView 那边是拿它刷新进度条的，
                            // 逐块转发会把桥打满，进度条反而卡。
                            val now = SystemClock.elapsedRealtime()
                            if (receivedBytes == totalBytes || now - lastEmitAt >= UPDATE_PROGRESS_INTERVAL_MS) {
                                lastEmitAt = now
                                emitUpdateProgress(receivedBytes, totalBytes, false)
                            }
                            read = source.read(buffer)
                        }
                    }
                }
                emitUpdateProgress(receivedBytes, totalBytes, true)
            }

            val result = JSObject()
            result.put("path", if (target == null) "" else target.absolutePath)
            result.put("bytes", receivedBytes)
            call.resolve(result)
        } catch (error: IOException) {
            call.reject(error.message, error)
        } catch (error: IllegalArgumentException) {
            call.reject(error.message, error)
        } finally {
            synchronized(updateDownloadLock) {
                isUpdateDownloading = false
            }
        }
    }

    /** 把下载好的包交给系统安装器。 */
    @PluginMethod
    fun installUpdate(call: PluginCall) {
        val path = call.getString("path", "")
        if (path == null || path.isEmpty()) {
            call.reject("Missing update file path")
            return
        }
        val file = File(path)
        if (!file.exists()) {
            call.reject("Update file is missing")
            return
        }

        // Android O 起「允许来自此来源的应用」是按包授权的运行时开关，没开就装不上 ——
        // 直接跳系统那个页面，比装到一半失败再报错好。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !getContext().packageManager.canRequestPackageInstalls()
        ) {
            val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:" + getContext().packageName))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                getContext().startActivity(settingsIntent)
            } catch (error: Exception) {
                call.reject("Unable to open the install permission settings", error)
                return
            }
            val result = JSObject()
            result.put("status", "permission-required")
            call.resolve(result)
            return
        }

        val apkUri: Uri
        try {
            apkUri = FileProvider.getUriForFile(
                getContext(),
                getContext().packageName + ".fileprovider",
                file
            )
        } catch (error: IllegalArgumentException) {
            // 路径没落在 file_paths.xml 声明的目录里就会走到这里，属于改错配置的编程错误。
            call.reject("Update file is not shareable via FileProvider", error)
            return
        }

        val installIntent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(apkUri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            getContext().startActivity(installIntent)
        } catch (error: Exception) {
            call.reject("No app can handle the installer intent", error)
            return
        }
        val result = JSObject()
        result.put("status", "installing")
        call.resolve(result)
    }

    /** 进度事件：bytes 是可用的原始值，percent 是给 UI 直接用的 0-100（总量未知时为 -1）。 */
    private fun emitUpdateProgress(receivedBytes: Long, totalBytes: Long, done: Boolean) {
        val payload = JSObject()
        payload.put("receivedBytes", receivedBytes)
        payload.put("totalBytes", if (totalBytes > 0) totalBytes else 0L)
        payload.put("percent", if (totalBytes > 0)
            Math.min(100, Math.floor(receivedBytes * 100.0 / totalBytes).toInt())
        else
            -1)
        payload.put("done", done)
        val activity = getActivity()
        val emit = Runnable { notifyListeners(UPDATE_PROGRESS_EVENT, payload) }
        if (activity != null) activity.runOnUiThread(emit)
        else emit.run()
    }

    // ---- 本地音乐（安卓没有 File System Access API，曲库只能由原生侧给）----

    @PluginMethod
    fun scanLocalAudio(call: PluginCall) {
        val alias = audioPermissionAlias()
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias, call, "audioPermissionCallback")
            return
        }
        resolveLocalAudioScan(call)
    }

    /**
     * Android 13 起读音频用 READ_MEDIA_AUDIO，之前的版本用 READ_EXTERNAL_STORAGE。
     *
     * 这两个权限不能放在同一个别名里：被申请的那一个拿到授权后，另一个在系统看来仍是
     * 拒绝，而 Capacitor 对同一别名取「全部授权才算授权」，结果永远停在 PROMPT，
     * 扫描会被误判成「权限被拒」。所以按系统版本分开取别名。
     */
    private fun audioPermissionAlias(): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) "audio" else "audioLegacy"
    }

    @PermissionCallback
    private fun audioPermissionCallback(call: PluginCall) {
        if (getPermissionState(audioPermissionAlias()) == PermissionState.GRANTED) {
            resolveLocalAudioScan(call)
        } else {
            call.reject("Audio permission denied")
        }
    }

    @PluginMethod
    fun pickAudioFiles(call: PluginCall) {
        if (isAudioPickerOpen) {
            call.reject("Audio picker is already open")
            return
        }
        // 用 Capacitor 自己的活动回调机制（@ActivityCallback + startActivityForResult），
        // 而不是在 load() 里直接 registerForActivityResult：后者依赖活动生命周期时序，
        // 在部分设备上会拿不到可用的启动器，表现就是「点了导入毫无反应」。
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("audio/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        isAudioPickerOpen = true
        startActivityForResult(call, intent, "handlePickedAudio")
    }

    /** 选择整个文件夹；原生侧递归扫描其中的音频，用户可以一次导入整张专辑/目录。 */
    @PluginMethod
    fun pickAudioFolder(call: PluginCall) {
        if (isAudioPickerOpen) {
            call.reject("Audio picker is already open")
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        isAudioPickerOpen = true
        startActivityForResult(call, intent, "handlePickedAudioFolder")
    }

    /**
     * 取走「外部应用送进来、 Web 层还没领」的音频（冷启动那一路）。
     *
     * 从别的应用打开文件时 App 常常是冷启动的：那时浏览器侧还没加载完、一个监听者都没有，
     * 拷好的曲目只能先停在 pendingExternalTracks；页面起来后调一次这个方法把它们取走。
     * 取完即清空 —— 下一步用户回答的是「是否导入」，不是「要不要再拷一次」。
     */
    @PluginMethod
    fun takeExternalAudioUris(call: PluginCall) {
        val tracks = JSArray()
        synchronized(pendingExternalTracks) {
            for (track in pendingExternalTracks) tracks.put(track)
            pendingExternalTracks.clear()
        }
        val result = JSObject()
        result.put("tracks", tracks)
        var port = 0
        try {
            if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
            port = localAudioServer!!.start()
        } catch (ignored: Exception) {
            // 起不来时 Web 层会自己用 localAudioServerPort 再来一次；这里不给端口即可。
        }
        if (port > 0) result.put("port", port)
        call.resolve(result)
    }

    /** 供 WebView 重建导入音频的流地址（端口每次启动都可能不同，不能把 URL 存死）。 */
    @PluginMethod
    fun localAudioServerPort(call: PluginCall) {
        try {
            if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
            val port = localAudioServer!!.start()
            val result = JSObject()
            result.put("port", port)
            call.resolve(result)
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /*
     * 媒体缓存（App 私有目录）。
     *
     * 字节读写走回环服务的 /media-cache 路由（见 LocalAudioServer）：几 MB 的东西过不了桥，
     * 桥只有一条，压上去别的平台会集体超时。这两个方法只传数字，很轻。
     */

    @PluginMethod
    fun mediaCacheStats(call: PluginCall) {
        try {
            if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
            val stats = localAudioServer!!.mediaCacheStats()
            val result = JSObject()
            result.put("size", stats[0].toDouble())
            result.put("count", stats[1].toInt())
            call.resolve(result)
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /**
     * 原生侧整首歌落盘：从 URL 直接下载进媒体缓存。
     *
     * 以前写缓存的是 Web（抓完字节再 PUT 回回环服务），也就是说缓存这件事本身
     * 跑在 WebView 里 —— 应用退后台 / WebView 冻结时整首播完了也没人写。这里把
     * 下载挪进原生：谁叫一声都能存，不挑 WebView 的状态。
     *
     * 网络在后台线程（桥的线程规则：插件方法不许同步阻塞），落盘结果异步 resolve：
     * stored = 字节数（0 = 没存，下载失败或被判定为试听片段）。
     */
    @PluginMethod
    fun cacheAudioFromUrl(call: PluginCall) {
        val cacheKey = call.getString("cacheKey")
        val url = call.getString("url")
        // getDouble 标可空：先接住再落值，别在同一行里二次调用（两次可能不一致）。
        val limitBytes = call.getDouble("limitBytes", 0.0) ?: 0.0
        val minDurationMs = call.getDouble("minDurationMs", 0.0) ?: 0.0
        if (cacheKey == null || cacheKey.isEmpty() || url == null || url.isEmpty()) {
            call.reject("cacheKey and url are required")
            return
        }
        if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
        val server = localAudioServer
        Thread(Runnable {
            val stored = server!!.storeMediaCacheFromUrl(cacheKey, url,
                limitBytes.toLong(), minDurationMs.toLong())
            val result = JSObject()
            result.put("stored", stored)
            call.resolve(result)
        }, "folia-cache-audio").start()
    }

    @PluginMethod
    fun clearMediaCache(call: PluginCall) {
        try {
            if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
            localAudioServer!!.clearMediaCache()
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /*
     * 歌词后方「视频层」的本地视频。
     *
     * WebView 里没有 File System Access API：`<input type=file>` 挑出来的 File 只能变成
     * blob: 地址，进程一死就失效 —— 也就是「重启就没了」。所以这一端改成原生拷一份进私有
     * 目录（VideoLayerFile），Web 侧只拿一个回环地址。地址里带着端口，而端口每次启动都可能
     * 变（见 localAudioServerPort），所以绝不能存死，每次要用都得回来问一次。
     */

    /** 打开系统文件选择器挑一个视频。 */
    @PluginMethod
    fun pickVideoLayerFile(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
        intent.addCategory(Intent.CATEGORY_OPENABLE)
        intent.setType("video/*")
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivityForResult(call, intent, "handleVideoLayerPicked")
    }

    @ActivityCallback
    private fun handleVideoLayerPicked(call: PluginCall?, result: ActivityResult?) {
        if (call == null) return
        val resultCode = if (result == null) Activity.RESULT_CANCELED else result.resultCode
        val data = if (result == null) null else result.data
        val uri = if (resultCode == Activity.RESULT_OK && data != null) data.data else null
        if (uri == null) {
            resolveVideoLayerPick(call, false, resultCode == Activity.RESULT_OK, null, null)
            return
        }
        /*
         * 拷贝是重活（几十 MB 起），必须挪出桥线程：Capacitor 只有一条桥，
         * 占住它等于让所有别的方法一起排队，别的平台会集体超时。
         */
        val activity = getActivity()
        Thread(Runnable {
            var storedName: String? = null
            var storedUrl: String? = null
            try {
                val resolver = getContext().contentResolver
                val displayName = queryDisplayName(resolver, uri)
                val mimeType = resolver.getType(uri)
                if (VideoLayerFile.store(getContext(), uri, displayName, mimeType) != null) {
                    storedName = VideoLayerFile.displayName(getContext())
                    storedUrl = videoLayerUrl()
                }
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to store the chosen video layer file", error)
            }
            val name = storedName
            val url = storedUrl
            val picked = name != null && url != null
            if (activity != null) {
                activity.runOnUiThread { resolveVideoLayerPick(call, picked, true, name, url) }
            } else {
                resolveVideoLayerPick(call, picked, true, name, url)
            }
        }, "folia-video-layer").start()
    }

    private fun resolveVideoLayerPick(call: PluginCall, picked: Boolean, rejected: Boolean, name: String?, url: String?) {
        val out = JSObject()
        out.put("picked", picked)
        // 选了却用不了（太大 / 读不出来）：要和「用户取消」分开，界面才好给提示。
        out.put("rejected", !picked && rejected)
        if (name != null) out.put("name", name)
        if (url != null) out.put("url", url)
        call.resolve(out)
    }

    /** 挑过没有、它此刻的回环地址是什么。每次启动都要重问：端口会变。 */
    @PluginMethod
    fun getVideoLayerFile(call: PluginCall) {
        val out = JSObject()
        val key = VideoLayerFile.key(getContext())
        val has = key != null
        out.put("has", has)
        if (has) {
            out.put("name", VideoLayerFile.displayName(getContext()))
            val url = videoLayerUrl()
            if (url != null) out.put("url", url)
        }
        call.resolve(out)
    }

    /** 用户主动「清除本地视频」：连磁盘上的副本一起删掉。 */
    @PluginMethod
    fun clearVideoLayerFile(call: PluginCall) {
        VideoLayerFile.clear(getContext())
        call.resolve()
    }

    /** 视频层副本的回环地址；本地服务起不来时为 null。 */
    private fun videoLayerUrl(): String? {
        try {
            if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
            val port = localAudioServer!!.start()
            return "http://127.0.0.1:" + port + "/video-layer/current"
        } catch (error: Exception) {
            Log.w(TAG, "Could not start the local server for the video layer", error)
            return null
        }
    }

    @ActivityCallback
    private fun handlePickedAudio(call: PluginCall?, activityResult: ActivityResult?) {
        isAudioPickerOpen = false
        if (call == null) return

        // -1 = RESULT_OK，0 = RESULT_CANCELED。区分「用户取消」和「选完了却没数据」，
        // 否则两种情况的返回值一模一样，只能靠猜。
        val resultCode = if (activityResult == null) Activity.RESULT_CANCELED else activityResult.resultCode
        val uris = ArrayList<Uri>()
        val data = if (activityResult == null) null else activityResult.data
        if (data != null) {
            val clipData = data.clipData
            if (clipData != null) {
                for (index in 0 until clipData.itemCount) {
                    val uri = clipData.getItemAt(index).uri
                    if (uri != null) uris.add(uri)
                }
            } else if (data.data != null) {
                // data.data 标可空（平台类型），上面已判 null，这里断言一下。
                uris.add(data.data!!)
            }
        }

        completePickedAudioImport(call, uris, resultCode)
    }

    @ActivityCallback
    private fun handlePickedAudioFolder(call: PluginCall?, activityResult: ActivityResult?) {
        isAudioPickerOpen = false
        if (call == null) return
        val resultCode = if (activityResult == null) Activity.RESULT_CANCELED else activityResult.resultCode
        val uris = ArrayList<Uri>()
        val data = if (activityResult == null) null else activityResult.data
        if (data != null) {
            val treeUri = data.data
            if (treeUri != null) {
                try {
                    // 拿到长期授权：重启之后还能读这个目录，重新导入时不必再让用户选一次。
                    getContext().contentResolver.takePersistableUriPermission(
                        treeUri,
                        data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (ignored: Exception) {
                    // Some providers do not offer persistable grants; the current grant is still usable.
                }
                collectAudioDocuments(treeUri, DocumentsContract.getTreeDocumentId(treeUri), uris)
            }
        }
        completePickedAudioImport(call, uris, resultCode)
    }

    private fun collectAudioDocuments(treeUri: Uri, parentDocumentId: String, output: MutableList<Uri>) {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        )
        try {
            getContext().contentResolver.query(childrenUri, projection, null, null, null).use { cursor ->
                if (cursor == null) return
                while (cursor.moveToNext()) {
                    val documentId = cursor.getString(0)
                    val displayName = cursor.getString(1)
                    val mimeType = cursor.getString(2)
                    if (DocumentsContract.Document.MIME_TYPE_DIR == mimeType) {
                        collectAudioDocuments(treeUri, documentId, output)
                        continue
                    }
                    if (isAudioDocument(displayName, mimeType)) {
                        output.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId))
                    }
                }
            }
        } catch (ignored: Exception) {
            // A provider can deny one subtree without invalidating the rest of the selection.
        }
    }

    /**
     * 拷完之后的出口：挑文件那条路要给 PluginCall，外部打开那条路要给 Web 层的事件，
     * 中间这一份流水（复制 + 去重 + 记 failure）两边共用。
     */
    private interface AudioImportSink {
        fun complete(result: JSObject)
        fun fail(message: String, error: Exception)
    }

    private fun completePickedAudioImport(call: PluginCall, uris: List<Uri>, resultCode: Int) {
        if (uris.isEmpty()) {
            val result = JSObject()
            result.put("tracks", JSArray())
            result.put("cancelled", resultCode != Activity.RESULT_OK)
            result.put("picked", 0)
            result.put("resultCode", resultCode)
            if (resultCode == Activity.RESULT_OK) {
                result.put("error", "Picker returned RESULT_OK without a readable document uri")
            }
            call.resolve(result)
            return
        }

        val activity = getActivity()
        importAudioFiles(uris, resultCode, object : AudioImportSink {
            override fun complete(result: JSObject) {
                if (activity != null) activity.runOnUiThread { call.resolve(result) }
                else call.resolve(result)
            }

            override fun fail(message: String, error: Exception) {
                if (activity != null) activity.runOnUiThread { call.reject(message, error) }
                else call.reject(message, error)
            }
        })
    }

    /**
     * 把一组 uri 拷进 App 私有目录：本地曲库所有能播的音频都得先从这里过一遍。
     *
     * 两条入口共用：系统文件管理器挑中的（completePickedAudioImport）与外部应用
     * 「用 Folia 打开 / 分享过来」的（noteExternalAudioUris）。
     */
    private fun importAudioFiles(uris: List<Uri>, resultCode: Int, sink: AudioImportSink) {
        // 拷贝是重活：一次导入几十上百个文件，放在调用线程上会把界面卡死，
        // 所以整个搬进后台线程，完成后再回到 UI 线程交给出口。
        val activity = getActivity()
        Thread(Runnable {
            try {
                if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
                val port = localAudioServer!!.start()
                val directory = localAudioServer!!.importedAudioDirectory()
                val resolver = getContext().contentResolver
                val tracks = JSArray()
                val failures = JSArray()
                var copied = 0

                for (uri in uris) {
                    try {
                        // （Java 的 continue 在 try-with-resources 里，Kotlin 用 run + return@run 等价替代。）
                        run {
                            var displayName = queryDisplayName(resolver, uri)
                            val fileSize = queryFileSize(resolver, uri)
                            if (displayName == null || displayName.isEmpty()) displayName = "track-" + System.currentTimeMillis()
                            val safeName = "imported-" + stableFileId(displayName, fileSize, directory)
                            val target = File(directory, safeName)
                            val alreadyThere = target.isFile && target.length() > 0
                                && (fileSize <= 0 || target.length() == fileSize)
                            if (!alreadyThere) {
                                // 这里不能再叫 sink：外层方法的回调参数就叫 sink（AudioImportSink）。
                                val source = resolver.openInputStream(uri)
                                FileOutputStream(target).use { copyOut ->
                                    if (source == null) return@run
                                    source.use {
                                        val buffer = ByteArray(128 * 1024)
                                        var read = source.read(buffer)
                                        while (read != -1) {
                                            copyOut.write(buffer, 0, read)
                                            read = source.read(buffer)
                                        }
                                    }
                                }
                            }
                            /*
                             * 拷出来是 0 字节（provider 授权失效、openInputStream 静默失败等）绝对不能进库：
                             * <audio> 播它会报一句莫名的 MEDIA_ELEMENT_ERROR: Format error，用户只会看到
                             * "本地播放有 bug"。这里删掉空文件、记进 failures，让上层能看见。
                             */
                            if (target.length() <= 0) {
                                target.delete()
                                val failure = JSObject()
                                failure.put("uri", java.lang.String.valueOf(uri))
                                failure.put("message", "Copied file is empty: " + displayName)
                                failures.put(failure)
                                return@run
                            }

                            val track = JSObject()
                            track.put("id", safeName)
                            track.put("fileName", displayName)
                            track.put("fileSize", target.length())
                            track.put("mimeType", LocalAudioServer.guessMimeType(safeName))
                            track.put("url", "http://127.0.0.1:" + port + "/audio/" + safeName)
                            tracks.put(track)
                            copied += 1
                        }
                    } catch (error: Exception) {
                        // 单个文件读不了不该让整批失败，但必须把原因带回去，
                        // 否则界面只会「什么都没发生」。
                        val failure = JSObject()
                        failure.put("uri", java.lang.String.valueOf(uri))
                        failure.put("message", if (error.message == null) error.toString() else error.message)
                        failures.put(failure)
                    }
                }

                val result = JSObject()
                result.put("tracks", tracks)
                result.put("port", port)
                result.put("picked", uris.size)
                result.put("copied", copied)
                result.put("failures", failures)
                result.put("resultCode", resultCode)
                if (activity != null) activity.runOnUiThread { sink.complete(result) }
                else sink.complete(result)
            } catch (error: Exception) {
                // error.message 标可空；fail 的契约要非空，兜成 toString()。
                val message = error.message ?: error.toString()
                if (activity != null) activity.runOnUiThread { sink.fail(message, error) }
                else sink.fail(message, error)
            }
        }, "folia-audio-import").start()
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
    private fun resolveLocalAudioScan(call: PluginCall) {
        try {
            if (localAudioServer == null) {
                localAudioServer = LocalAudioServer(getContext())
            }
            val port = localAudioServer!!.start()
            val tracks = JSArray()
            val projection = arrayOf(
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.MIME_TYPE
            )
            // IS_MUSIC != 0：把录音、通知音、语音消息这些"也是音频但不是歌"的东西滤掉。
            getContext().contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                projection,
                MediaStore.Audio.Media.IS_MUSIC + " != 0",
                null,
                MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC"
            ).use { cursor ->
                if (cursor != null) {
                    val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID)
                    val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                    val titleColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE)
                    val artistColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST)
                    val albumColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM)
                    val durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)
                    val sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
                    val mimeColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE)
                    while (cursor.moveToNext()) {
                        val id = cursor.getLong(idColumn)
                        val track = JSObject()
                        track.put("id", java.lang.String.valueOf(id))
                        track.put("fileName", cursor.getString(nameColumn))
                        track.put("title", cursor.getString(titleColumn))
                        track.put("artist", cursor.getString(artistColumn))
                        track.put("album", cursor.getString(albumColumn))
                        track.put("duration", cursor.getLong(durationColumn))
                        track.put("fileSize", cursor.getLong(sizeColumn))
                        track.put("mimeType", cursor.getString(mimeColumn))
                        track.put("url", "http://127.0.0.1:" + port + "/audio/" + id)
                        tracks.put(track)
                    }
                }
            }
            val result = JSObject()
            if (tracks.length() == 0 && isAllFilesAccessGranted()) {
                collectAudioFilesFromStorage(tracks, port)
            } else if (tracks.length() == 0) {
                result.put("needsAllFilesAccess", true)
            }
            result.put("tracks", tracks)
            call.resolve(result)
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /**
     * 「所有文件访问」是受限权限，弹窗要不来，只能跳系统设置让用户手动开。
     * 开完回到应用（onActivityResult 由 Capacitor 的 ActivityCallback 接住）再把结果带回 JS。
     */
    @PluginMethod
    fun requestAllFilesAccess(call: PluginCall) {
        if (isAllFilesAccessGranted()) {
            val result = JSObject()
            result.put("granted", true)
            call.resolve(result)
            return
        }
        val activity = getActivity()
        if (activity == null) {
            call.reject("Activity unavailable; cannot request all-files access.")
            return
        }
        val intent = Intent(
            Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.fromParts("package", activity.packageName, null)
        )
        try {
            startActivityForResult(call, intent, "handleAllFilesAccessResult")
        } catch (firstError: Exception) {
            // 有的 ROM 不认带包名的深链，退到通用的"所有文件访问"列表页。
            try {
                startActivityForResult(
                    call,
                    Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
                    "handleAllFilesAccessResult"
                )
            } catch (secondError: Exception) {
                call.reject("No all-files access settings page on this device: " +
                    secondError.message, secondError)
            }
        }
    }

    @ActivityCallback
    private fun handleAllFilesAccessResult(call: PluginCall?, activityResult: ActivityResult?) {
        if (call == null) return
        val result = JSObject()
        result.put("granted", isAllFilesAccessGranted())
        call.resolve(result)
    }

    /**
     * 文件系统兜底扫描：媒体库一首都没有、但用户给了所有文件访问时，直接翻外存目录。
     *
     * 只递归 Music / Download（外加它们的子目录），跳过隐藏目录与 Android/ 私有区，
     * 最多收 2000 首 —— 全盘翻既慢又会把系统目录翻出成千上万垃圾。
     * ref 是 `file-<绝对路径>`，播放地址按它拼，音频由 LocalAudioServer 的 file- 路由直接从原文件流出来，不复制。
     */
    private fun collectAudioFilesFromStorage(tracks: JSArray, port: Int) {
        val root = Environment.getExternalStorageDirectory()
        if (root == null || !root.isDirectory) return
        val music = File(root, "Music")
        val download = File(root, "Download")
        val queue = java.util.ArrayDeque<File>()
        if (music.isDirectory) queue.add(music)
        if (download.isDirectory) queue.add(download)
        var collected = 0
        var visited = 0
        while (!queue.isEmpty() && collected < 2000 && visited < 20000) {
            val directory = queue.poll() ?: continue
            val children = directory.listFiles()
            if (children == null) continue
            for (child in children) {
                visited += 1
                val name = child.name
                if (child.isDirectory) {
                    if (name.startsWith(".") || name == "Android") continue
                    queue.add(child)
                    continue
                }
                if (!LocalAudioServer.isAudioFileName(name)) continue
                val ref = "file-" + child.absolutePath
                val track = JSObject()
                track.put("id", ref)
                track.put("fileName", name)
                track.put("title", name.replaceFirst("\\.[^.]+$".toRegex(), ""))
                track.put("fileSize", child.length())
                track.put("mimeType", LocalAudioServer.guessMimeType(name))
                track.put("url", "http://127.0.0.1:" + port + "/audio/" + Uri.encode(ref))
                tracks.put(track)
                collected += 1
                if (collected >= 2000) break
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
    fun deleteImportedAudio(call: PluginCall) {
        val refs = call.getArray("refs", JSArray()) ?: JSArray()
        val deleted = JSArray()
        val failed = JSArray()
        try {
            if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
            val directory = localAudioServer!!.importedAudioDirectory()
            for (index in 0 until refs.length()) {
                val ref = refs.getString(index) ?: continue
                val target = resolveImportedFile(directory, ref)
                if (target == null) {
                    failed.put(ref)
                    continue
                }
                // 已经不在了也算成功，重复删除不该被当成错误。
                if (!target.exists() || target.delete()) {
                    deleted.put(ref)
                } else {
                    failed.put(ref)
                }
            }
            val result = JSObject()
            result.put("deleted", deleted)
            result.put("failed", failed)
            call.resolve(result)
        } catch (error: Exception) {
            call.reject(error.message, error)
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
    fun registerRemoteAudio(call: PluginCall) {
        val url = call.getString("url")
        if (url == null || url.isEmpty()) {
            val empty = JSObject()
            empty.put("url", if (url == null) "" else url)
            empty.put("proxied", false)
            call.resolve(empty)
            return
        }
        // 自建服务（飞牛）的音频流要带 `Cookie: music-token=...`，而且地址是用户自己填的、
        // 不在白名单里 —— 两者都只能由调用方显式声明。
        val headers = HashMap<String, String>()
        val headerObject = call.getObject("headers")
        if (headerObject != null) {
            val headerNames = headerObject.keys()
            while (headerNames.hasNext()) {
                val headerName = headerNames.next()
                val headerValue = headerObject.opt(headerName)
                if (headerValue != null) headers.put(headerName, java.lang.String.valueOf(headerValue))
            }
        }
        val allowAnyHost = java.lang.Boolean.TRUE.equals(call.getBoolean("allowAnyHost", false))
        try {
            if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
            val credentialOrigin = call.getString("credentialOrigin")
            val proxied = if (credentialOrigin != null)
                localAudioServer!!.registerScopedRemoteAudio(url, headers, credentialOrigin)
            else localAudioServer!!.registerRemoteAudio(url, headers, allowAnyHost)
            val result = JSObject()
            result.put("url", proxied)
            result.put("proxied", true)
            call.resolve(result)
        } catch (error: Exception) {
            val result = JSObject()
            result.put("url", url)
            result.put("proxied", false)
            result.put("error", java.lang.String.valueOf(error.message))
            call.resolve(result)
        }
    }

    @PluginMethod
    fun registerScopedRemoteAudio(call: PluginCall) {
        if (call.getString("credentialOrigin") == null) {
            call.reject("Credential origin is required")
            return
        }
        registerRemoteAudio(call)
    }

    @PluginMethod
    fun unregisterRemoteAudio(call: PluginCall) {
        try {
            val url = call.getString("url")
            if (localAudioServer != null && url != null) localAudioServer!!.unregisterRemoteAudio(url)
            call.resolve()
        } catch (error: Exception) {
            call.reject("Could not unregister remote resource")
        }
    }

    /**
     * 接收 Web 层推来的平台凭据（目前只有飞牛）。
     *
     * 飞牛是用户自己的 NAS：地址、token、中继开关都在 Web 层的会话存储里，
     * 原生网关（MusicGateway）要拿它们拼取流地址与带 Cookie —— 登录 / 登出 /
     * 改地址 / 切中继时各推一次（见 feiniuTransport.syncFeiniuGatewayCredentials）。
     * token 为空＝登出，网关那边清掉。
     */
    @PluginMethod
    fun setGatewayCredentials(call: PluginCall) {
        val provider = call.getString("provider", "")
        if ("feiniu" == provider) {
            val serverUrl = call.getString("serverUrl", "")
            val token = call.getString("token", "")
            val relayMode = java.lang.Boolean.TRUE.equals(call.getBoolean("relayMode", false))
            top.izuna.foliamajor.online.MusicGateway.setFeiniuCredentials(serverUrl, token, relayMode)
        } else if ("netease" == provider) {
            // 网易的「我喜欢」名单要 uid 才拉得动（weapi /song/like/get），
            // uid 只在 Web 层的账号缓存里 —— 登录 / 登出时推一份。
            top.izuna.foliamajor.online.MusicGateway.setNeteaseUid(call.getString("userId", ""))
        }
        call.resolve()
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
    fun copyLocalAudio(call: PluginCall) {
        val ref = call.getString("ref")
        if (ref == null || ref.isEmpty()) {
            call.reject("Missing audio ref")
            return
        }
        val fileName = call.getString("fileName")
        val fileSize = call.getLong("fileSize", 0L) ?: 0L
        val activity = getActivity()
        Thread(Runnable {
            val result = JSObject()
            try {
                if (localAudioServer == null) localAudioServer = LocalAudioServer(getContext())
                localAudioServer!!.start()
                val directory = localAudioServer!!.importedAudioDirectory()
                val copied = materializeAudioCopy(directory, ref, fileName, fileSize)
                if (copied == null) {
                    val target = File(directory, ref)
                    val why = if (ref.startsWith("imported-") && !target.isFile)
                        "private copy is gone and the original was not found in the media store"
                    else
                        "source is unreachable"
                    Log.w(TAG, "copyLocalAudio failed for " + ref + ": " + why)
                    result.put("copied", false)
                    result.put("error", why + ": " + ref)
                } else {
                    result.put("copied", true)
                    result.put("ref", copied)
                }
            } catch (error: Exception) {
                Log.w(TAG, "copyLocalAudio failed for " + ref, error)
                result.put("copied", false)
                result.put("error", if (error.message == null) error.toString() else error.message)
            }
            if (activity != null) activity.runOnUiThread { call.resolve(result) }
            else call.resolve(result)
        }, "folia-audio-copy").start()
    }

    /**
     * 按文件名 + 大小回媒体库里找原文件。
     *
     * 兜的是「私有副本没了、而这首歌本来是挑文件夹导入的」这种情况：
     * 挑选导入时只记了副本名，原文件的 Uri 没留下来，副本一旦丢了就没有任何退路 ——
     * 只能让用户重新导入整个文件夹。而原文件多半还躺在外部存储里、也被媒体库收录着，
     * 按「文件名 + 大小」把它找回来重新拷一遍，比让用户重导一遍合理得多。
     */
    private fun copyFromMediaStoreByName(directory: File, fileName: String?, fileSize: Long): String? {
        if (fileName == null || fileName.isEmpty()) return null
        val resolver = getContext().contentResolver
        val selection = if (fileSize > 0)
            MediaStore.Audio.Media.DISPLAY_NAME + "=? AND " + MediaStore.Audio.Media.SIZE + "=?"
        else
            MediaStore.Audio.Media.DISPLAY_NAME + "=?"
        val args = if (fileSize > 0)
            arrayOf(fileName, java.lang.String.valueOf(fileSize))
        else
            arrayOf(fileName)
        try {
            resolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Audio.Media._ID),
                selection, args, null
            ).use { cursor ->
                if (cursor == null || !cursor.moveToFirst()) return null
                val id = cursor.getLong(0)
                return materializeAudioCopy(directory, java.lang.String.valueOf(id), fileName, fileSize)
            }
        } catch (error: Exception) {
            Log.w(TAG, "media store lookup failed for " + fileName, error)
            return null
        }
    }

    /** 返回新 ref（imported-xxx）；源取不到、或拷出来是空的，都返回 null。 */
    @Throws(IOException::class)
    private fun materializeAudioCopy(directory: File, ref: String, fileName: String?, fileSize: Long): String? {
        // （Java 在这里直接重新赋值参数，Kotlin 参数不可变，用局部变量 size 代替。）
        var size = fileSize
        if (ref.startsWith("imported-")) {
            // 副本还在就没什么可做的；没了才回媒体库按文件名把原文件找回来重拷。
            val existing = File(directory, ref)
            if (existing.isFile && existing.length() > 0) return null
            return copyFromMediaStoreByName(directory, fileName, size)
        }

        val resolver = getContext().contentResolver
        var sourceUri: Uri? = null
        var sourceFile: File? = null
        var displayName: String? = null

        if (ref.startsWith("file-")) {
            sourceFile = File(ref.substring("file-".length))
            if (!sourceFile.isFile) return null
            displayName = sourceFile.name
            size = sourceFile.length()
        } else {
            val mediaId: Long
            try {
                mediaId = ref.trim().toLong()
            } catch (error: NumberFormatException) {
                return null
            }
            sourceUri = android.content.ContentUris.withAppendedId(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId)
            resolver.query(sourceUri, arrayOf(
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.SIZE,
            ), null, null, null).use { cursor ->
                if (cursor == null || !cursor.moveToFirst()) return null
                displayName = cursor.getString(0)
                size = cursor.getLong(1)
            }
        }
        if (displayName == null || displayName.isEmpty()) displayName = "track-" + System.currentTimeMillis()

        val target = File(directory, "imported-" + stableFileId(displayName!!, size, directory))
        if (target.isFile && target.length() > 0) return target.name

        // 取本地 val 再判：sourceUri / sourceFile 各对应一种 ref 形态，正常只会有一个非空。
        // 老写法是 `FileInputStream(sourceFile!!)` —— ref 既不是 file- 前缀也不是数字时
        // 两个都是 null，当场 NPE；改成显式判空后这条路变成「返回 null（拷不了）」。
        val localSourceFile = sourceFile
        val source: InputStream? = if (sourceUri != null)
            resolver.openInputStream(sourceUri)
        else if (localSourceFile != null)
            java.io.FileInputStream(localSourceFile)
        else null
        if (source == null) return null
        source.use { `in` ->
            FileOutputStream(target).use { sink ->
                val buffer = ByteArray(128 * 1024)
                var read = `in`.read(buffer)
                while (read != -1) {
                    sink.write(buffer, 0, read)
                    read = `in`.read(buffer)
                }
            }
        }
        // 拷出来是 0 字节（授权失效 / provider 静默失败）等于没拷：删掉，别留个坏文件。
        if (target.length() <= 0) {
            target.delete()
            return null
        }
        return target.name
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
    fun showToast(call: PluginCall) {
        val text = call.getString("text", "")
        val longDuration = java.lang.Boolean.TRUE.equals(call.getBoolean("long", false))
        val message = if (text == null) "" else text
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            try {
                Toast.makeText(getContext(), message,
                    if (longDuration) Toast.LENGTH_LONG else Toast.LENGTH_SHORT).show()
            } catch (ignored: Throwable) {
                // 上下文已经没了（进程正在收尾）：一句提示不值得再抛出点什么。
            }
        }
        call.resolve()
    }

    /*
     * 弹一条**自己画**的悬浮提示条（FoliaOverlayNotice），样子照 Web 层那条提示来做，
     * 但贴在**屏幕下边**（画在别的应用上面时，压住别人顶部的状态栏比压住底部手势条更碍事）。
     *
     * 为什么还要这条路：系统 Toast 在 Android 11 起后台只给纯文本，画不出我们自己的
     * 圆角条；而「后台自动跳过了下一首」偏偏是最需要在别的应用上面说清楚的一句话。
     * 悬浮窗能画自己的样子，代价是用户要先在系统设置里给「显示在其他应用上层」。
     *
     * 没授权（或窗口令牌失效、ROM 不让画）时这里**什么都不做**，只回 `shown:false`，
     * 由渲染层退回系统 Toast —— 不去申请权限、也不把用户扔进设置页：一句提示不值得
     * 打断一次「去设置里授权」的流程。
     *
     * 同样是主线程 Handler + Application 上下文：插件方法跑在 Capacitor 自己的线程上，
     * 而 WindowManager 有线程归属，并且这时 Activity 往往已经 stop。
     */
    @PluginMethod
    fun showOverlayNotice(call: PluginCall) {
        val text = call.getString("text", "")
        val message = if (text == null) "" else text
        val requested = call.getLong("durationMs", 4000L)
        val durationMs = requested ?: 4000L
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            var shown = false
            try {
                shown = FoliaOverlayNotice.show(getContext(), message, durationMs)
            } catch (error: Throwable) {
                // 悬浮窗这层出了任何岔子都只是「没弹出来」，让调用方回退。
                Log.w("FoliaNativePlugin", "showOverlayNotice failed", error)
            }
            val result = JSObject()
            result.put("shown", shown)
            call.resolve(result)
        }
    }

    /*
     * 回到应用：收掉那条悬浮提示。
     *
     * 它是画在**别的应用上面**的，使命就是「界面没人看时替界面说一句话」。界面回来了，
     * 这句话该由页面自己说 —— 再挂在上面就是挡自己的视线。
     *
     * 也是「它到底会不会消失」的最后一道保险：定时收掉那条路万一没走通（出场动画的回调
     * 不派发、窗口令牌中途失效），至少回到应用时一定清掉。放在原生这边而不是让网页来调，
     * 是因为后台 WebView 的 timer 会被节流，回前台那一刻不一定赶得及。
     *
     * Capacitor 是从 Activity 的 onResume 调过来的，所以已经在主线程上（hide 要求主线程）。
     */
    override fun handleOnResume() {
        try {
            FoliaOverlayNotice.hide()
        } catch (error: Throwable) {
            Log.w(TAG, "hiding the overlay notice failed", error)
        }
    }

    @PluginMethod
    fun setScreenAwake(call: PluginCall) {
        val awake = java.lang.Boolean.TRUE.equals(call.getBoolean("awake", false))
        val activity = getActivity()
        if (activity != null) {
            activity.runOnUiThread {
                try {
                    if (awake) {
                        activity.window.addFlags(
                            android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        activity.window.clearFlags(
                            android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                } catch (ignored: Throwable) {
                    // Activity 正在 finishing：窗口已经没了。
                }
            }
        }
        call.resolve()
    }

    /*
     * 导出：让用户自己挑保存位置。
     *
     * WebView 里 <a download> 在安卓上要么静默丢进 Download、要么干脆没有反应 ——
     * 用户点「导出歌词」看不到任何「存到哪儿」的界面。这里用系统的
     * ACTION_CREATE_DOCUMENT（Storage Access Framework）弹一张保存位置选择器，
     * 选完由原生把字节写进用户给的那个 URI。
     *
     * 文本走 content（原生按 UTF-8 编码），二进制走 contentBase64（批量导出那个 zip），
     * 两条路都不经过 WebView 自己的下载器。
     */
    @PluginMethod
    fun saveFile(call: PluginCall) {
        val fileName = call.getString("fileName", "")
        val content = call.getString("content")
        val contentBase64 = call.getString("contentBase64")
        if (fileName == null || fileName.trim().isEmpty()) {
            call.reject("Missing fileName")
            return
        }
        if ((content == null || content.isEmpty()) && (contentBase64 == null || contentBase64.isEmpty())) {
            call.reject("Missing content")
            return
        }
        val mimeType = call.getString("mimeType", "application/octet-stream")
        try {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mimeType)
                .putExtra(Intent.EXTRA_TITLE, fileName)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            // 用 Capacitor 的活动回调（@ActivityCallback + startActivityForResult）——
            // 和导入音频那两条路一个写法，见 pickAudioFiles 上的注释。
            startActivityForResult(call, intent, "handleSavedFile")
        } catch (error: Exception) {
            call.reject("Save picker failed: " + error.message, error)
        }
    }

    @ActivityCallback
    private fun handleSavedFile(call: PluginCall, result: ActivityResult?) {
        val cancelled = JSObject()
        cancelled.put("saved", false)
        cancelled.put("cancelled", true)
        if (result == null || result.resultCode != Activity.RESULT_OK) {
            call.resolve(cancelled)
            return
        }
        val data = result.data
        val uri = if (data != null) data.data else null
        if (uri == null) {
            call.resolve(cancelled)
            return
        }
        var out: OutputStream? = null
        try {
            val contentBase64 = call.getString("contentBase64")
            val content = call.getString("content")
            val bytes: ByteArray
            if (contentBase64 != null && !contentBase64.isEmpty()) {
                bytes = Base64.decode(contentBase64, Base64.DEFAULT)
            } else {
                bytes = (if (content == null) "" else content).toByteArray(StandardCharsets.UTF_8)
            }
            out = getContext().contentResolver.openOutputStream(uri, "w")
            if (out == null) {
                call.reject("Cannot open destination")
                return
            }
            out.write(bytes)
            out.flush()
            val saved = JSObject()
            saved.put("saved", true)
            saved.put("uri", uri.toString())
            saved.put("name", call.getString("fileName", ""))
            call.resolve(saved)
        } catch (error: Exception) {
            call.reject("Write failed: " + error.message, error)
        } finally {
            if (out != null) {
                try {
                    out.close()
                } catch (ignored: IOException) {
                    // 关不掉也已经写完了。
                }
            }
        }
    }

    /*
     * 音频焦点策略：后台要不要允许与其它音源同时播放。
     *
     * 值**落盘**（见 FoliaAudioFocus 的说明）：WebView 是在它自己要请求音频焦点时才来
     * 向 Application 要 AudioManager 的，冷启动后第一次播放就发生在这之前 —— 那时
     * Web 层还没跑到，只有磁盘上的值能决定给出去的是哪一种 AudioManager。
     */
    @PluginMethod
    fun setAudioFocusPolicy(call: PluginCall) {
        val mixWithOthers = java.lang.Boolean.TRUE.equals(call.getBoolean("mixWithOthers", false))
        top.izuna.foliamajor.audio.FoliaAudioFocus.setMixWithOthers(getContext(), mixWithOthers)
        call.resolve()
    }

    @PluginMethod
    fun getPhoneFitLayout(call: PluginCall) {
        val result = JSObject()
        result.put("enabled", PhoneLayoutOrientation.isEnabled(getContext()))
        result.put("orientation", PhoneLayoutOrientation.getOrientation(getContext()))
        call.resolve(result)
    }

    /** 挖孔现场，供诊断用（屏幕高度 / decor 高度 / 残留 padding / 挖孔矩形）。 */
    @PluginMethod
    fun getDisplayCutout(call: PluginCall) {
        try {
            call.resolve(JSObject.fromJSONObject(PhoneFitCutout.describe(getActivity())))
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /** 手机布局开关顺带锁方向：开＝锁竖屏（或横屏），关＝跟随系统。 */
    @PluginMethod
    fun setPhoneFitLayout(call: PluginCall) {
        val enabled = java.lang.Boolean.TRUE.equals(call.getBoolean("enabled", false))
        val orientation = call.getString("orientation", PhoneLayoutOrientation.getOrientation(getContext()))
        PhoneLayoutOrientation.update(getContext(), enabled, orientation)
        val activity = getActivity()
        if (activity != null) {
            activity.runOnUiThread { PhoneLayoutOrientation.apply(activity) }
        }
        val result = JSObject()
        result.put("enabled", enabled)
        result.put("orientation", PhoneLayoutOrientation.getOrientation(getContext()))
        call.resolve(result)
    }

    /*
     * 「HDR 投影」的显示那一半：把亮度顶到最亮。
     *
     * 屏幕亮度在 WebView 里改不动 —— 那是 Activity 窗口的属性（`lp.screenBrightness`），
     * 网页拿不到自己的窗口。所以要走这里。
     *
     * 两条腿都走：
     *   1. **窗口覆盖**（BRIGHTNESS_OVERRIDE_*）：不用任何权限，进程活着就有效，
     *      退到后台由系统照常接管 —— 不会把用户的亮度永久改掉。
     *   2. **真的写系统亮度**：窗口覆盖只对我们自己的窗口生效，设置里那个滑块一动不动，
     *      而带「阳光屏 / 护眼 / 自动亮度」的 ROM（ColorOS 一类）会按自己的策略把它压回
     *      去，用户看到的就是「开了 HDR，屏幕一点没亮」。所以拿到 WRITE_SETTINGS 授权时
     *      顺手把系统亮度也顶满，并在关掉时还原成开之前的值与模式。
     *
     * WRITE_SETTINGS 是「特殊权限」，装的时候不给，得用户在系统设置里亲手开一次；
     * 没给就只靠第 1 条，返回值里把这件事报回去，界面上才好提示。
     */
    @PluginMethod
    fun setDisplayBoost(call: PluginCall) {
        val boost = java.lang.Boolean.TRUE.equals(call.getBoolean("boost", false))
        var wroteSystem = false
        var canWrite = false
        val activity = getActivity()
        if (activity != null) {
            activity.runOnUiThread {
                try {
                    val window = activity.window
                    val params = window.attributes
                    /*
                     * 只动亮度，不动色彩模式。
                     *
                     * 早先这里还试着把窗口切进 COLOR_MODE_HDR（不支持再退广色域），结果在
                     * 不支持的机器上整屏发黑：窗口被当成 HDR / 广色域的合成目标，而 WebView
                     * 画的是 sRGB，同一个像素值被按另一条曲线解释，画面就被压到近乎全黑 ——
                     * 偏偏这个开关是落盘的，一黑就再也找不到地方把它关掉。
                     *
                     * 亮度覆盖是窗口自己的属性，不碰色彩空间；投到玻璃上要的「够亮」它已经
                     * 够了，HDR 那半收益没有、风险很大，不再碰。
                     */
                    params.screenBrightness = if (boost)
                        android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
                    else
                        android.view.WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                    window.setAttributes(params)
                    /*
                     * 投影时别息屏：手机躺在仪表台上没人碰，系统息屏时间一到整屏就黑了，
                     * 而且这时候用户看不到「再点一次」的入口。
                     */
                    if (boost) {
                        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                    canWrite = canWriteSystemSettings()
                    if (canWrite) {
                        wroteSystem = writeSystemBrightness(boost)
                    }
                } catch (ignored: Throwable) {
                    // Activity 正在 finishing：窗口已经没了。
                }
                /*
                 * 结果要等窗口那段跑完再给：`canWrite` / `wroteSystem` 是在里面填的，
                 * 放在 runOnUiThread 外面 resolve 的话读到的永远是初始的 false。
                 */
                call.resolve(buildDisplayBoostResult(wroteSystem, canWrite))
            }
            return
        }
        call.resolve(buildDisplayBoostResult(false, false))
    }

    private fun buildDisplayBoostResult(wroteSystem: Boolean, canWrite: Boolean): JSObject {
        val result = JSObject()
        result.put("systemBrightness", wroteSystem)
        result.put("canWriteSettings", canWrite)
        return result
    }

    /** WRITE_SETTINGS 拿到了没有（这是特殊权限，只能用户在系统设置里给）。 */
    private fun canWriteSystemSettings(): Boolean {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                return Settings.System.canWrite(getContext())
            }
            return true
        } catch (ignored: Throwable) {
            return false
        }
    }

    /*
     * 改完记得还原：系统亮度是全局的，忘了还就是把用户的屏幕永久钉在最亮。
     * 开之前的值与自动 / 手动模式存在进程里，关掉开关时照原样写回去。
     */
    private var savedSystemBrightness = -1
    private var savedSystemBrightnessMode = -1

    private fun writeSystemBrightness(boost: Boolean): Boolean {
        try {
            val resolver = getContext().contentResolver
            if (boost) {
                if (savedSystemBrightness < 0) {
                    savedSystemBrightness = Settings.System.getInt(
                        resolver, Settings.System.SCREEN_BRIGHTNESS, 255)
                    savedSystemBrightnessMode = Settings.System.getInt(
                        resolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                        Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC)
                }
                Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                    Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
                Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS, 255)
                return true
            }
            if (savedSystemBrightness >= 0) {
                Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS_MODE,
                    if (savedSystemBrightnessMode == Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
                        Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
                    else
                        Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC)
                Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS,
                    savedSystemBrightness)
                savedSystemBrightness = -1
                savedSystemBrightnessMode = -1
                return true
            }
            return false
        } catch (ignored: Throwable) {
            return false
        }
    }

    private fun parseCookieHeader(header: String?, domain: String?): List<JSObject> {
        val cookies = ArrayList<JSObject>()
        if (header == null || header.isEmpty()) return cookies
        val pairs = header.split(";")
        for (pair in pairs) {
            val separator = pair.indexOf('=')
            if (separator <= 0) continue
            val name = pair.substring(0, separator).trim()
            val value = pair.substring(separator + 1).trim()
            if (name.isEmpty()) continue
            val cookie = JSObject()
            cookie.put("name", name)
            cookie.put("value", value)
            cookie.put("domain", if (domain == null) "" else domain)
            cookie.put("path", "/")
            cookie.put("secure", true)
            cookie.put("httpOnly", false)
            cookies.add(cookie)
        }
        return cookies
    }
}
