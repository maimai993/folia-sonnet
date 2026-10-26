package top.izuna.foliamajor

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

import org.json.JSONObject

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.HashMap
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 汽水音乐的签名宿主（安卓版）。
 *
 * 汽水那套接口的签名不是我们算的，是官方的 bdms.js 算的 —— 它改写页面里的 XHR/fetch，
 * 在请求发出前补上签名参数。所以要拿到签名，就必须有一个**真的浏览器页面**在跑它。
 * 桌面端由 Electron 的隐藏 BrowserWindow 提供（electron/qishui/qishui-auth-v6.js），
 * 安卓端没有 Electron，这里用原生起的隐藏 WebView 顶上，并且：
 *
 *   1. 把打包进 assets 的那套页面与脚本挂到一个假的 https 源下
 *      （https://www.qishui.com/__folia/...），让 bdms.js 认为自己就在汽水的站点里；
 *   2. 用 shouldInterceptRequest 把这个页面发出去的跨域请求拦下来，改由 OkHttp 真发，
 *      并补上 CORS 头 —— 否则 https://www.qishui.com 的页面读不到 api.qishui.com 的响应。
 *
 * 页面里的协议层（qishui-api.js 那一份）由此可以在安卓上原样跑，
 * 与桌面端共用同一个 operation 表与同一个返回信封。
 *
 * 线程：所有 WebView 操作都在主线程；shouldInterceptRequest 跑在 WebView 的工作线程上，
 * 所以那里用 OkHttp 的同步 execute() 是安全的（同步阻塞的是那个线程，不是插件线程）。
 */
class QishuiSignHost(private val activity: MainActivity) {
    companion object {
        private const val TAG = "QishuiSignHost"

        /** 协议层持久化用的 SharedPreferences 名与键前缀（见 HostBridge.getStore）。 */
        private const val STORE_PREFS = "folia_qishui"
        private const val STORE_PREFIX = "car:"

        /** 假源：页面挂在这个源下，bdms.js 才会按「在汽水站内」那套规则签名。 */
        const val PAGE_ORIGIN = "https://www.qishui.com"

        /** assets 里那套页面在这个假源下的挂载点。 */
        private const val PAGE_PATH_PREFIX = "/__folia/"
        private const val BOOTSTRAP_URL = PAGE_ORIGIN + PAGE_PATH_PREFIX + "bootstrap.html"

        /** assets 下的目录。 */
        private const val ASSET_DIR = "qishui/"

        /**
         * 与桌面端 qishui-auth-v6.js 的 UA 保持一致：签名里带了设备指纹，
         * UA 换一套会让风控把这一路判成「换设备」，登录态立刻失效。
         */
        private const val UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "SodaMusic/3.2.1 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 " +
                "TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36"

        /** 允许代发请求的主机后缀（其余一律拦掉，避免这个 WebView 变成任意代理）。 */
        private val ALLOWED_HOST_SUFFIXES = arrayOf(
            "qishui.com", "douyin.com", "byteimg.com", "volcengine.com", "amemv.com", "snssdk.com",
            // 二次验证（MFA）组件跑在 verify/auth.zijieapi.com，组件脚本与素材在字节静态 CDN 上。
            "zijieapi.com", "yhgfb-cn-static.com", "bytedance.net", "ibytedtos.com",
        )

        /** 官方 bdms.js 的 CDN 地址：上游用 session hook 重定向到本地，这里对同一个 URL 直接回 assets。 */
        private const val OFFICIAL_BDMS_URL =
            "https://lf-headquarters-speed.yhgfb-cn-static.com/obj/rc-client-security/web/stable/1.0.0.41/bdms.js"

        /** evaluateJavascript 走 IPC 有长度上限；回传大响应（歌单整包）时按块推给页面。 */
        private const val HTTP_RESULT_CHUNK_CHARS = 512 * 1024

        /**
         * 一个票据最多等这么久。
         *
         * 比渲染层 accountRead 的 60 秒兜底（WHO_WAIT_MS）短，这样「桥确实没回」会变成一个
         * **明确的错误**（渲染层记一条 warn 并保留账号），而不是一句看不出所以然的
         * "no answer in 60 s"。比 OkHttp 那头的读超时（25 秒）长，正常慢请求不会被误杀。
         */
        private const val RESPONSE_TIMEOUT_MS = 45_000L

        /** 与桌面端 qishuiApiBridge.cjs 的 { ok, data } / { ok, error } 信封一致。 */
        fun envelopeJson(ok: Boolean, dataJson: String?, code: String?, message: String?): String {
            val json = StringBuilder()
            if (ok) {
                json.append("{\"ok\":true,\"data\":").append(if (dataJson == null) "null" else dataJson).append("}")
            } else {
                json.append("{\"ok\":false,\"error\":{\"code\":").append(quote(code))
                    .append(",\"message\":").append(quote(message)).append("}}")
            }
            return json.toString()
        }

        /** 给 JS 侧解码用：原生只传 base64，避免转义问题。 */
        fun decodeBase64(value: String?): String {
            try {
                return String(Base64.decode(value, Base64.DEFAULT), StandardCharsets.UTF_8)
            } catch (error: Throwable) {
                return ""
            }
        }

        private fun quote(value: String?): String {
            return "\"" + value.toString().replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        }

        private fun empty(status: Int, reason: String): WebResourceResponse {
            val stream = ByteArrayInputStream(ByteArray(0))
            val headers = HashMap<String, String>()
            headers.put("Access-Control-Allow-Origin", PAGE_ORIGIN)
            return WebResourceResponse("text/plain", "UTF-8", status, reason, headers, stream)
        }

        private fun mimeFor(relative: String): String {
            if (relative.endsWith(".html")) return "text/html"
            if (relative.endsWith(".js")) return "application/javascript"
            if (relative.endsWith(".json")) return "application/json"
            return "application/octet-stream"
        }
    }

    private fun prefs(): SharedPreferences {
        return activity.getSharedPreferences(STORE_PREFS, Context.MODE_PRIVATE)
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    // 车机协议（客户端令牌 / ticket-guard）的参考实现用 `redirect: 'error'`：
    // 请求里带着 access_code 与 CSR，一旦上游回 3xx，跟随跳转后**响应头里的
    // bd-ticket-guard-server-data 会丢** —— 表现是请求成功（err_no=0）却读不到
    // guard 数据，登录卡在 ticket 那一拍。所以整座桥都不跟随重定向：协议层所有
    // 端点都不该跳，跳了就是异常，直接把状态码交回页面判定。
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    private var webView: WebView? = null
    @Volatile
    private var ready = false
    @Volatile
    private var _failureReason: String? = null
    private val ticketSeq = AtomicInteger(1)
    private val pending = ConcurrentHashMap<String, Pending>()

    /** 页面就绪之前发来的请求在这里排队（见 request 与 drainWaiting）。 */
    private val waiting: java.util.Queue<Runnable> = java.util.concurrent.ConcurrentLinkedQueue()

    /** 宿主自己要用的 cookie：协议层的「当前会话」就是它。 */
    @Volatile
    private var _sessionCookie = ""

    /**
     * OkHttp 收到的 set-cookie 自己攒一份。登录态（sessionid 等）正是这么下发的，
     * 而 CookieManager 的读回依赖 WebView 状态、还可能因为不在主线程而失败 ——
     * 不能当唯一来源，所以这里同步记一份，`getCookie` 先给这份再补 CookieManager。
     */
    private val jarCookies: MutableMap<String, String> =
        java.util.Collections.synchronizedMap(java.util.LinkedHashMap<String, String>())

    /** 加密音频的本地回环代理：主 WebView 的 <audio> 吃这个地址（独立于签名 WebView）。 */
    private val audioServer = QishuiAudioServer()

    private val executor: java.util.concurrent.ExecutorService =
        java.util.concurrent.Executors.newSingleThreadExecutor()

    /**
     * 请求要带的 Cookie 头：自攒的 jar 优先，CookieManager 补缺的名字。
     *
     * 都放在外层是因为两条出口都要用——http() 桥（异步，内部类 HostBridge 里）和
     * shouldInterceptRequest（同步，外层方法）。只在一处实现必然编译不过或漏一半。
     */
    private fun cookieHeaderFor(url: String?): String {
        val out = StringBuilder()
        synchronized(jarCookies) {
            for (entry in jarCookies.entries) {
                if (out.length > 0) out.append("; ")
                out.append(entry.key).append('=').append(entry.value)
            }
        }
        // CookieManager 可能还存着页面自己那一份，缺的名字补上（已有的不覆盖，
        // 罐里的值可能更旧）。
        val pairs = readWebViewCookies(url).split(";")
        for (pair in pairs) {
            val eq = pair.indexOf('=')
            if (eq <= 0) continue
            val name = pair.substring(0, eq).trim()
            if (name.isEmpty()) continue
            val known = synchronized(jarCookies) { jarCookies.containsKey(name) }
            if (known) continue
            if (out.length > 0) out.append("; ")
            out.append(name).append('=').append(pair.substring(eq + 1).trim())
        }
        return out.toString()
    }

    private fun readWebViewCookies(url: String?): String {
        if (url == null || url.isEmpty()) return ""
        try {
            val value = CookieManager.getInstance().getCookie(url)
            return if (value == null) "" else value
        } catch (error: Throwable) {
            Log.w(TAG, "getCookie failed", error)
            return ""
        }
    }

    /** 只保留 `name=value`，丢掉 expires / path / domain 等属性。 */
    private fun rememberCookie(setCookie: String?) {
        if (setCookie == null) return
        val pair = setCookie.split(";", limit = 2)[0].trim()
        val eq = pair.indexOf('=')
        if (eq <= 0) return
        val name = pair.substring(0, eq).trim()
        val value = pair.substring(eq + 1).trim()
        if (name.isEmpty()) return
        // 空值是服务端在清这个 cookie。
        if (value.isEmpty()) jarCookies.remove(name)
        else jarCookies.put(name, value)
    }

    fun interface Pending {
        fun resolve(json: String?)
    }

    fun isReady(): Boolean {
        return ready
    }

    /**
     * 播放服务那条路（经 {@link QishuiGatewayBridge}）用的：把带 #auth= 的加密
     * 直链换成 loopback 解密代理地址。与页面里 FoliaQishuiHost.audioProxyUrl
     * 是同一个出口、同一座服务器，只是给原生侧（不起页面协议的那条路）开一扇门。
     */
    fun audioProxyUrlFor(cleanUrl: String?, auth: String?): String {
        return audioServer.buildProxyUrl(cleanUrl, auth)
    }

    fun getFailureReason(): String? {
        return _failureReason
    }

    /** 主线程上创建隐藏 WebView 并加载引导页；可重复调用（已建好就直接返回）。 */
    fun ensureStarted() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { ensureStarted() }
            return
        }
        if (webView != null) return
        val created: WebView
        try {
            created = WebView(activity)
        } catch (error: Throwable) {
            val reason = "webview-create-failed: " + error.message
            _failureReason = reason
            Log.w(TAG, reason)
            return
        }
        webView = created
        configure(created)
        // 挂到 Activity 的内容视图上（1x1、透明、移到屏幕外）。
        //
        // 不能只 new 一个不挂载的 WebView：没有 attach 的 WebView 不会走完整的
        // 生命周期，JS 定时器与 rAF 会被系统掐掉，bdms.js 的初始化会一直卡住。
        // 也不能用 setVisibility(INVISIBLE) —— 那样同样会被当成不可见而不排帧。
        // 这里让它在布局里真实存在，只是小到看不见。
        try {
            val root = activity.findViewById<ViewGroup>(android.R.id.content)
            if (root != null) {
                val params = ViewGroup.LayoutParams(1, 1)
                created.layoutParams = params
                created.alpha = 0f
                created.setBackgroundColor(Color.TRANSPARENT)
                created.translationX = -10000f
                root.addView(created)
            }
        } catch (error: Throwable) {
            Log.w(TAG, "attaching the hidden signing webview failed", error)
        }
        created.addJavascriptInterface(HostBridge(), "FoliaQishuiHost")
        created.webViewClient = HostClient()
        /*
         * 这一座 WebView **只跑 JS，不画东西**（引导页的 body 是空的），所以它不该再去占一块
         * GPU 合成面：平板上主 WebView 的视口本来就比手机大得多，合成内存已经被吃掉一大截，
         * 再多一块 GL 面就够让系统去收渲染进程（见 onSigningRendererGone）。改成软件绘制，
         * 这一座一个像素都不必真的画出来。
         */
        try {
            created.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
        } catch (error: Throwable) {
            Log.w(TAG, "forcing software drawing on the signing webview failed", error)
        }
        created.loadUrl(BOOTSTRAP_URL)
        // 音频代理提前起（失败只降级为「无本地代理」，song.url 原样直链）。
        executor.execute { audioServer.start() }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(view: WebView) {
        val settings: WebSettings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.userAgentString = UA
        settings.loadWithOverviewMode = false
        settings.mediaPlaybackRequiresUserGesture = false
        // 不能缓存：签名参数每次都不一样，缓存下来的响应会被风控认成重放。
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
    }

    /**
     * 把一个 operation 交给页面里的协议层。
     *
     * 不能走 evaluateJavascript 的返回值：页面里的协议层是异步的，而
     * evaluateJavascript 只能拿到表达式的**同步**结果。这里改成票据 + 回调：
     * 原生给一个 ticket，页面算完调 FoliaQishuiHost.resolve(ticket, json)。
     */
    fun request(operation: String, paramsJson: String?, callback: Pending) {
        val ticket = ticketSeq.getAndIncrement().toString()
        pending.put(ticket, callback)
        val script = "window.__foliaQishui && window.__foliaQishui.start(" +
            quote(operation) + "," + paramsJson + "," + quote(ticket) + ")"
        val send = Runnable {
            val view = webView
            if (view == null) {
                val entry = pending.remove(ticket)
                if (entry != null) entry.resolve(envelopeJson(false, null, "unavailable", "Signing host is not started"))
                return@Runnable
            }
            view.evaluateJavascript(script, null)
        }
        // ⚠ 页面没 ready 就发 = **静默丢单**，这是「重启后账号没了」的直接原因。
        //
        // 脚本开头那个 `window.__foliaQishui && …` 在 protocol.js 执行完之前是
        // undefined：整个表达式短路成 undefined，evaluateJavascript 正常返回，
        // 页面**永远不会**调 resolve(ticket)。这个票据从此没人管，渲染层只能一路
        // 等到 accountRead 的 60 秒兜底 —— 真机日志里那句
        // "who is signed in could not be asked … no answer in 60 s" 就是它。
        // 而 status 那一问正是**续期（renew）的唯一触发点**：它没跑，凭据就一直
        // 是旧的，账号请求被上游判 auth-required，只能退回公共令牌 → VIP 曲子
        // 只剩试听。一个丢单，两个现象。
        if (!ready) {
            synchronized(waiting) { waiting.add(send) }
            Log.i(TAG, "request " + operation + " waits for the page (ticket " + ticket + ")")
        } else {
            mainHandler.post(send)
        }
        // 兜底：无论如何都要给这个票据一个结局，不能让它永远挂着。
        mainHandler.postDelayed({ timeoutTicket(ticket, operation) }, RESPONSE_TIMEOUT_MS)
    }

    private fun timeoutTicket(ticket: String, operation: String) {
        val entry = pending.remove(ticket)
        if (entry == null) return
        Log.w(TAG, "request " + operation + " (ticket " + ticket + ") got no answer in " +
            RESPONSE_TIMEOUT_MS + " ms")
        entry.resolve(envelopeJson(false, null, "network", "The Qishui signing host did not answer in time"))
    }

    /** 页面就绪：把排队等着的请求全部发出去（已在主线程）。 */
    private fun drainWaiting() {
        val queued = synchronized(waiting) {
            if (waiting.isEmpty()) return
            val copy: List<Runnable> = java.util.ArrayList(waiting)
            waiting.clear()
            copy
        }
        Log.i(TAG, "the page is ready; " + queued.size + " queued request(s) go out now")
        for (send in queued) send.run()
    }

    fun setSessionCookie(cookie: String?) {
        _sessionCookie = if (cookie == null) "" else cookie
    }

    fun getSessionCookie(): String {
        return _sessionCookie
    }

    /** 主线程：把隐藏 WebView 摘下来并销毁；不管它现在是好的还是已经废了。 */
    private fun dropWebView() {
        val view = webView
        webView = null
        ready = false
        if (view == null) return
        try {
            view.stopLoading()
            view.removeJavascriptInterface("FoliaQishuiHost")
            val parent = view.parent as ViewGroup?
            if (parent != null) parent.removeView(view)
            view.destroy()
        } catch (error: Throwable) {
            Log.w(TAG, "dropping the signing webview failed", error)
        }
    }

    /**
     * 隐藏 WebView 的渲染进程没了：系统内存不足把它收走了，或者它自己崩了。
     *
     * ⚠ 这一声必须自己接住。`WebViewClient` 的默认实现返回 **false**，意思是
     * 「这个 App 处理不了渲染进程没了」—— 系统随即把整个进程带走；真机上的表现就是
     * 「一扫汽水的二维码，整屏先黑，接着整个 App 卡死，只能从最近任务里杀掉」。
     * 只有汽水会这样：它是唯一会**再起一座 WebView** 的平台（协议层要一个真页面）。
     * 平板上必现是因为视口大、合成内存本来就吃得多，多这一座就够让系统去收渲染进程。
     *
     * 接住之后只废这一座桥：在途的票据当场结掉（不结，渲染层只能干等到 45 秒兜底），
     * 然后立刻重建一座 —— 用户点「刷新二维码」时它已经重新就绪了。应用其它部分不受影响。
     */
    private fun onSigningRendererGone(crashed: Boolean) {
        Log.w(TAG, "the signing webview's renderer is gone (crashed=" + crashed + "); the bridge is rebuilt")
        mainHandler.post {
            _failureReason = if (crashed) "renderer-crashed" else "renderer-killed"
            dropWebView()
            // 在途的票据要有结局：这一座已经废了，等它回话是等不到的。
            synchronized(waiting) { waiting.clear() }
            for (entry in pending.entries) {
                entry.value.resolve(envelopeJson(false, null, "unavailable", "The Qishui signing host lost its renderer"))
            }
            pending.clear()
            // 就地重建：下一次请求（用户刷新二维码）落在一座好的上。
            // 页面 ready 时 HostBridge.onReady 会把 _failureReason 清掉。
            ensureStarted()
        }
    }

    fun dispose() {
        mainHandler.post {
            dropWebView()
            audioServer.stop()
            // 还在排队的那几个票据仍挂在 pending 里，下面这一圈会一并把它们结掉。
            synchronized(waiting) { waiting.clear() }
            for (entry in pending.entries) {
                entry.value.resolve(envelopeJson(false, null, "unavailable", "Signing host was disposed"))
            }
            pending.clear()
        }
    }

    // ─── JS → 原生 ────────────────────────────────────────────────────────

    private inner class HostBridge {
        @JavascriptInterface
        fun onReady(cookie: String?) {
            ready = true
            _failureReason = null
            if (cookie != null) _sessionCookie = cookie
            Log.i(TAG, "signing host ready")
            // 排队的请求现在可以发了（@JavascriptInterface 跑在桥线程，派发回主线程）。
            mainHandler.post { this@QishuiSignHost.drainWaiting() }
        }

        @JavascriptInterface
        fun onFailure(reason: String?) {
            _failureReason = reason
            Log.w(TAG, "signing host failed: " + reason)
        }

        @JavascriptInterface
        fun resolve(ticket: String, json: String?) {
            val entry = pending.remove(ticket)
            if (entry != null) entry.resolve(json)
        }

        /** 页面把当前会话 cookie 回传（登录后 / 登出后都会调）。 */
        @JavascriptInterface
        fun setCookie(cookie: String?) {
            _sessionCookie = if (cookie == null) "" else cookie
        }

        /**
         * 登出时把宿主侧的 cookie 全部清掉。
         *
         * 协议层只清它自己那份（config.cookie 与 COOKIE_FILE），但登录态还留在
         * 这里的两处：自攒的 jarCookies 与 WebView 的 CookieManager —— 请求发
         * 出去时仍然带着旧会话，于是「点了退出却还登着」，下一次扫码也会撞上
         * 上一个会话。
         */
        @JavascriptInterface
        fun clearCookies() {
            synchronized(jarCookies) {
                jarCookies.clear()
            }
            _sessionCookie = ""
            try {
                CookieManager.getInstance().removeAllCookies(null)
            } catch (error: Throwable) {
                Log.w(TAG, "clearCookies failed", error)
            }
        }

        /**
         * 把 WebView cookie 罐里某个源下的 cookie 回给页面。
         *
         * 登录确认时 passport 的登录态是走 Set-Cookie 下发的（响应体里的
         * session_cookie 字段经常是空的）；这些 cookie 由 OkHttp 收到后转发进
         * CookieManager（见 http() 里的 set-cookie 处理）。上游在 Electron 里靠
         * `session.cookies.get({})` 把它们并回 config，安卓只能从这里读 —— 少了
         * 这一步，`getStatus().loggedIn` 永远是 false，表现成「扫码确认了但账号
         * 出不来」。
         */
        /**
         * 协议层的持久化出口：设备 ID 与登录凭据存这里。
         *
         * WebView 的 localStorage 本来也能持久化，但它依赖 DOM storage 与 WebView
         * 数据目录的状态（系统清理、存储紧张、多进程都会让它丢），表现就是
         * 「登录成功、重启后账号没了」。SharedPreferences 是 App 自己的文件，稳。
         * 页面侧（car/storage.js）仍然双写 localStorage 作为回退。
         *
         * ⚠ 必须用 **commit()**（同步落盘）而不是 apply()：凭据是在扫码确认那一刻
         * 写进来的，用户常常紧接着就把 App 划掉 / 重启。apply() 只是把写盘排进
         * QueuedWork，进程若在这之前被杀（没走完 onPause，QueuedWork 就不会
         * waitToFinish），那一次写入就没了 —— 表现为「登录成功，重启后账号没了」。
         * 一次写入只有几 KB，同步写在这个桥线程上完全付得起。
         *
         * 两条都打点：真机上再说「账号丢了」，`adb logcat | grep QishuiSignHost`
         * 就能看出是**没写进来**还是**读出来是空的**，这是两种完全不同的故障。
         */
        @JavascriptInterface
        fun getStore(key: String?): String {
            if (key == null || key.isEmpty()) return ""
            try {
                val value = prefs().getString(STORE_PREFIX + key, "")
                Log.i(TAG, "getStore " + key + " -> " + (if (value == null) "null" else value.length.toString() + " chars"))
                return if (value == null) "" else value
            } catch (error: Throwable) {
                Log.w(TAG, "getStore failed", error)
                return ""
            }
        }

        @JavascriptInterface
        fun putStore(key: String?, value: String?) {
            if (key == null || key.isEmpty()) return
            try {
                val editor = prefs().edit()
                if (value == null) editor.remove(STORE_PREFIX + key)
                else editor.putString(STORE_PREFIX + key, value)
                val written = editor.commit()
                Log.i(TAG, "putStore " + key + " -> " + (if (value == null) "removed" else value.length.toString() + " chars") +
                    ", committed=" + written)
            } catch (error: Throwable) {
                Log.w(TAG, "putStore failed", error)
            }
        }

        @JavascriptInterface
        fun getCookie(url: String?): String {
            // 拼装逻辑放在外层（QishuiSignHost.cookieHeaderFor）：shouldInterceptRequest
            // 那条同步出口也要用同一份并集，不能只在这里实现。
            return cookieHeaderFor(url)
        }

        /**
         * 页面内所有协议请求的真传输（folia-xhr.js 的假 XHR 走这里）。
         *
         * 为什么不让 XHR 真发出去再由 shouldInterceptRequest 代发：那个回调拿不到
         * POST body（登录轮询 check_qrconnect 是 POST），而且签名注入后的 URL 也
         * 只在页面里可见。OkHttp 直发没有 CORS、UA 与 cookie 完全可控。
         * 返回 false 表示宿主已不可用，页面会立刻以网络错误收场。
         */
        @JavascriptInterface
        fun http(ticket: String?, payloadJson: String?): Boolean {
            try {
                val payload = JSONObject(payloadJson)
                val url = payload.optString("url", "")
                if (url.isEmpty()) {
                    pushHttpResult(ticket, null, "empty url")
                    return true
                }
                val builder = Request.Builder().url(url)
                val method = payload.optString("method", "GET").uppercase(Locale.US)
                val body = if (payload.isNull("body")) null else payload.optString("body", null)
                val headers = payload.optJSONObject("headers")
                var contentType: String? = null
                if (headers != null) {
                    val keys = headers.keys()
                    while (keys.hasNext()) {
                        val name = keys.next()
                        if (name == null) continue
                        val value = headers.optString(name, "")
                        if ("content-type".equals(name, ignoreCase = true)) {
                            contentType = value
                            continue
                        }
                        if ("host".equals(name, ignoreCase = true) || "content-length".equals(name, ignoreCase = true)) continue
                        try {
                            builder.header(name, value)
                        } catch (ignored: IllegalArgumentException) {
                            // 非法头名/头值由页面侧负责，这里跳过避免整条请求报废。
                        }
                    }
                }
                var timeoutMs = payload.optLong("timeoutMs", 0)
                if (timeoutMs <= 0) timeoutMs = payload.optLong("timeout", 20000)
                if (timeoutMs <= 0) timeoutMs = 20000
                val client = http.newBuilder()
                    .callTimeout(timeoutMs + 2000, TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build()
                if ("POST" == method || "PUT" == method || "PATCH" == method) {
                    val bytes = if (body == null) ByteArray(0) else body.toByteArray(StandardCharsets.UTF_8)
                    val mediaType = (if (contentType != null) contentType else "application/x-www-form-urlencoded")
                        .toMediaTypeOrNull()
                    val requestBody = bytes.toRequestBody(mediaType)
                    builder.method(method, requestBody)
                } else {
                    builder.method(method, null)
                }
                val finalTicket = ticket
                client.newCall(builder.build()).enqueue(object : Callback {
                    override fun onFailure(call: Call, error: IOException) {
                        pushHttpResult(finalTicket, null, error.message)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        try {
                            response.use { closable ->
                                val code = closable.code
                                // 登录态是 passport 用 Set-Cookie 下发的：/passport/web/get_qrcode/
                                // 就已经开始给，check_qrconnect 拿到确认后再给一次 sessionid。
                                // 这条异步路径是假 XHR 的唯一出口（folia-xhr.js → http 桥），
                                // 少了这里的记录，宿主 cookie 罐永远是空的。
                                val responseUrl = closable.request.url.toString()
                                for (value in closable.headers("Set-Cookie")) {
                                    try {
                                        CookieManager.getInstance().setCookie(responseUrl, value)
                                    } catch (ignored: Throwable) {
                                    }
                                    rememberCookie(value)
                                }
                                val responseBody = closable.body
                                val text = if (responseBody != null) responseBody.string() else ""
                                val resultHeaders = JSONObject()
                                for (name in closable.headers.names()) {
                                    // set-cookie 可能多值，逗号合并会破坏过期判断；只取第一个足够用。
                                    resultHeaders.put(name.lowercase(Locale.US), closable.header(name, ""))
                                }
                                val envelope = JSONObject()
                                envelope.put("status", code)
                                envelope.put("headers", resultHeaders)
                                envelope.put("body", text)
                                pushHttpResult(finalTicket, envelope, null)
                            }
                        } catch (error: Exception) {
                            pushHttpResult(finalTicket, null, error.message)
                        }
                    }
                })
                return true
            } catch (error: Exception) {
                Log.w(TAG, "http bridge failed", error)
                pushHttpResult(ticket, null, error.message)
                return true
            }
        }

        /** MFA 二次验证：页面要用户交互时，把隐藏 WebView 拉成全屏，结束再缩回去。 */
        @JavascriptInterface
        fun setMfaVisible(visible: String?) {
            mainHandler.post { setWebViewExpanded("1" == visible) }
        }

        /**
         * 协议层 song.url 用：把带 #auth= 的加密直链改写成 loopback 解密代理地址。
         * JavascriptInterface 的返回值是同步的，协议层可以直接拿到；服务器未就绪时
         * 返回空串，页面侧回退为原样直链（与桌面「无本地代理」的降级一致）。
         */
        @JavascriptInterface
        fun audioProxyUrl(cleanUrl: String?, auth: String?): String {
            return audioServer.buildProxyUrl(cleanUrl, auth)
        }
    }

    private fun setWebViewExpanded(expanded: Boolean) {
        val view = webView
        if (view == null) return
        try {
            val params = view.layoutParams
            if (expanded) {
                view.translationX = 0f
                view.alpha = 1f
                view.setBackgroundColor(Color.WHITE)
                params.width = ViewGroup.LayoutParams.MATCH_PARENT
                params.height = ViewGroup.LayoutParams.MATCH_PARENT
            } else {
                params.width = 1
                params.height = 1
                view.alpha = 0f
                view.setBackgroundColor(Color.TRANSPARENT)
                view.translationX = -10000f
            }
            view.layoutParams = params
        } catch (error: Throwable) {
            Log.w(TAG, "toggling mfa visibility failed", error)
        }
    }

    /**
     * 把一次 http 结果推回页面。响应可能超过 evaluateJavascript 的 IPC 上限
     * （歌单整包能到几百 KB），所以按块推：页面侧 __foliaHttpChunk 先攒齐再派发。
     */
    private fun pushHttpResult(ticket: String?, envelope: JSONObject?, error: String?) {
        var payload: String
        try {
            payload = if (error != null)
                JSONObject().put("error", error).toString()
            else
                envelope!!.toString()
        } catch (jsonError: Exception) {
            payload = "{\"error\":\"result serialization failed\"}"
        }
        // JS 字符串字面量转义：只推 base64，绕开所有引号/换行问题。
        val encoded = Base64.encodeToString(payload.toByteArray(StandardCharsets.UTF_8), Base64.NO_WRAP)
        val totalChunks = Math.max(1, (encoded.length + HTTP_RESULT_CHUNK_CHARS - 1) / HTTP_RESULT_CHUNK_CHARS)
        mainHandler.post {
            val view = webView
            if (view == null) return@post
            for (index in 0 until totalChunks) {
                val start = index * HTTP_RESULT_CHUNK_CHARS
                val end = Math.min(encoded.length, start + HTTP_RESULT_CHUNK_CHARS)
                val script = "window.__foliaHttpChunk && window.__foliaHttpChunk(" +
                    quote(ticket) + "," + totalChunks + "," + index + "," + quote(encoded.substring(start, end)) + ")"
                view.evaluateJavascript(script, null)
            }
        }
    }

    // ─── 请求拦截 ─────────────────────────────────────────────────────────

    private inner class HostClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
            if (request == null || request.url == null) return null
            val uri = request.url
            val url = uri.toString()
            val rawHost = uri.host
            val host = if (rawHost == null) "" else rawHost.lowercase(Locale.US)
            val rawPath = uri.path
            val path = if (rawPath == null) "" else rawPath

            // 1) 打包在 assets 里的页面与脚本：直接按文件路径喂回去。
            //    直接用 URL 前缀判断：Uri 没有 getProtocol()，只有 getScheme()。
            if (url.startsWith(PAGE_ORIGIN + PAGE_PATH_PREFIX)) {
                return serveAsset(path.substring(PAGE_PATH_PREFIX.length))
            }
            // 2) sdk-glue 会动态加载官方 CDN 的 bdms.js；上游（Electron）用 session hook
            //    把这个 URL 重定向到本地固定版本，这里同样处理 —— 版本漂移会破坏指纹一致性。
            if (OFFICIAL_BDMS_URL == url) {
                return serveAsset("bdms.js")
            }
            // 3) 白名单主机的页面级资源（MFA 组件脚本与素材）：代发并补 CORS 头。
            //    协议请求本身不走这里 —— folia-xhr.js 的假 XHR 全部经原生桥直发。
            if (hostAllowed(host)) {
                return proxy(request, url)
            }
            // 4) 其余一律拦掉：这个 WebView 只用来签名，不该碰别的网络。
            return empty(404, "blocked")
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            // 页面里没有导航，任何跳转都拦掉，免得把用户带到别处去。
            return true
        }

        /**
         * 渲染进程没了（API 26+）：**必须返回 true**，否则默认实现告诉系统「这个 App 处理不了」，
         * 系统就把整个进程带走 —— 表现是整屏黑在那里、只能杀进程。见 onSigningRendererGone。
         */
        // 这个回调只在 API 26+ 上才会被系统调用，里面读 26 的 API 是安全的（minSdk 是 24）。
        @SuppressLint("NewApi")
        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            onSigningRendererGone(detail != null && detail.didCrash())
            return true
        }
    }

    private fun hostAllowed(host: String): Boolean {
        for (suffix in ALLOWED_HOST_SUFFIXES) {
            if (host == suffix || host.endsWith("." + suffix)) return true
        }
        return false
    }

    private fun serveAsset(relative: String): WebResourceResponse {
        if (relative.contains("..")) return empty(404, "bad-path")
        try {
            val stream: InputStream = activity.assets.open(ASSET_DIR + relative)
            val mime = mimeFor(relative)
            val headers = HashMap<String, String>()
            headers.put("Access-Control-Allow-Origin", PAGE_ORIGIN)
            return WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream)
        } catch (error: IOException) {
            return empty(404, "no-asset")
        }
    }

    private fun proxy(request: WebResourceRequest, url: String): WebResourceResponse {
        try {
            val builder = Request.Builder().url(url)
            val requestHeaders: Map<String, String?>? = request.requestHeaders
            if (requestHeaders != null) {
                for (entry in requestHeaders.entries) {
                    val name = entry.key
                    if (name == null) continue
                    if ("cookie".equals(name, ignoreCase = true) || "host".equals(name, ignoreCase = true)
                        || "content-length".equals(name, ignoreCase = true) || "origin".equals(name, ignoreCase = true)) continue
                    val value = entry.value
                    builder.header(name, if (value == null) "" else value)
                }
            }
            // 登录态：优先用宿主自己记的会话 cookie，其次才是 WebView cookie 罐里的。
            // 走 cookieHeaderFor 的并集（自攒的 jar + CookieManager），别只读后者 ——
            // 假 XHR 不走真实网络，CookieManager 里未必有 OkHttp 收到的那批。
            val cookie = if (_sessionCookie != null && _sessionCookie.isNotEmpty())
                _sessionCookie
            else
                cookieHeaderFor(url)
            if (cookie != null && cookie.isNotEmpty()) builder.header("Cookie", cookie)

            val method = if (request.method == null) "GET" else request.method
            if ("POST".equals(method, ignoreCase = true) && request.method != null) {
                // 请求体拿不到（shouldInterceptRequest 不给），所以 POST 一律走空体，
                // 由协议层把参数拼进 URL —— 汽水的 web 接口本来就是 GET 为主。
                builder.post(ByteArray(0).toRequestBody(null))
            } else {
                builder.get()
            }

            val response = http.newCall(builder.build()).execute()
            val code = response.code
            val responseBody = response.body
            val body = if (responseBody != null) responseBody.string() else ""
            val headers = HashMap<String, String>()
            // 页面是这个源，代发回来的响应必须显式放行，否则 XHR 读不到正文。
            headers.put("Access-Control-Allow-Origin", PAGE_ORIGIN)
            headers.put("Access-Control-Allow-Credentials", "true")
            headers.put("Access-Control-Expose-Headers", "Set-Cookie")
            val setCookies: List<String> = response.headers("Set-Cookie")
            for (value in setCookies) {
                try {
                    CookieManager.getInstance().setCookie(url, value)
                } catch (ignored: Throwable) {
                }
                rememberCookie(value)
                if (headers.containsKey("Set-Cookie")) {
                    headers.put("Set-Cookie", headers["Set-Cookie"] + "," + value)
                } else {
                    headers.put("Set-Cookie", value)
                }
            }
            val contentType = response.header("Content-Type", "application/json; charset=utf-8")
                ?: "application/json; charset=utf-8"
            val mime = if (contentType.contains(";")) contentType.substring(0, contentType.indexOf(';')) else contentType
            val stream = ByteArrayInputStream(body.toByteArray(StandardCharsets.UTF_8))
            return WebResourceResponse(mime, "UTF-8", code, "OK", headers, stream)
        } catch (error: IOException) {
            return empty(502, "proxy-failed")
        } catch (error: Throwable) {
            Log.w(TAG, "proxying " + url + " failed", error)
            return empty(500, "proxy-error")
        }
    }
}
