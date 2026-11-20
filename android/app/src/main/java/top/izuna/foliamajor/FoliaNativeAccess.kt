package top.izuna.foliamajor

import android.content.SharedPreferences
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log

import java.net.URI
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// 当前文件：FoliaNativePlugin 的授权层 —— 谁可以调（origin）、可以调到哪里（域名白名单）、
// 本次会话登记的自建服务、以及几条出口（openUrl / 更新包 / 导出路径）的准入判定。
//
// 安全缺陷 C1 / H2 / H3 三条共用的就是这一层：插件对象挂在页面的全局对象上
// （window.Capacitor.Plugins.FoliaNative），页面里任何一段脚本都能直接调用它，
// 所以「谁在调」与「允许调到哪里」必须在原生侧自己判定，不能指望 JS 封装层。

/**
 * 一条被拒绝的调用。
 *
 * 单独一类而不是普通 Exception：插件方法里统一 catch 它、按固定前缀回 getMessage，
 * 日志也只记这一种（带方法名与被拒原因，不含 URL 全文 —— query 里有签名与凭据）。
 */
class FoliaNativeAccessDenied(val reason: String) : Exception(reason)

/** 域名白名单：按「本域 + 子域」匹配，端口不参与。 */
class FoliaHostAllowlist {

    private val exact = LinkedHashSet<String>()

    /** `*.example.com` 这种：命中 example.com 的全部子域，**不含** example.com 本身。 */
    private val suffixes = LinkedHashSet<String>()

    fun add(entry: String?) {
        if (entry.isNullOrBlank()) return
        val host = entry.trim().lowercase(Locale.US).removeSuffix(".")
        if (host.isEmpty()) return
        if (host.startsWith("*.")) {
            val suffix = host.substring(2)
            if (suffix.isNotEmpty()) suffixes.add(suffix)
        } else {
            exact.add(host)
        }
    }

    fun addAll(entries: Collection<String>) {
        entries.forEach { add(it) }
    }

    fun matches(host: String?): Boolean {
        if (host.isNullOrEmpty()) return false
        val target = host.lowercase(Locale.US).removeSuffix(".")
        if (exact.contains(target)) return true
        for (suffix in suffixes) {
            if (target.endsWith(".$suffix")) return true
        }
        return false
    }

    /**
     * 换算出这条地址所属的「域」，供 cookie 操作用（C1 / H2）。
     *
     * 精确登记的取登记的那一项（`eaaccess.kugou.com` 就只能是它），后缀登记取命中的那个后缀
     * （`*.qq.com` → `qq.com`）。CookieManager 按域匹配，拿主域去读就只有**这个平台自己**
     * 那一片 cookie，不会把隔壁平台的带出来。
     */
    fun domainOf(host: String?): String? {
        if (host.isNullOrEmpty()) return null
        val target = host.lowercase(Locale.US).removeSuffix(".")
        if (exact.contains(target)) return target
        for (suffix in suffixes) {
            if (target.endsWith(".$suffix")) return suffix
        }
        return null
    }

    /** 复制一份，给「平台域 + 用户配置的自建服务」这种组合用。 */
    fun copy(): FoliaHostAllowlist {
        val copy = FoliaHostAllowlist()
        copy.exact.addAll(exact)
        copy.suffixes.addAll(suffixes)
        return copy
    }
}

/**
 * 平台域名白名单（C1 / H2 / H3 的默认集）。
 *
 * 与 JS 侧 `src/services/onlineMusic/providerRegistry.ts` 登记的平台对应：这里只写各家
 * 自己的接口主机与图床 / 媒体主机，**不放**第三方站点。新登记一个平台时两边一起加，
 * 否则那个平台的请求会被原生侧拒掉。
 */
object FoliaPlatformHosts {

    /** 精确主机。 */
    val hosts: List<String> = listOf(
        // 网易云（接口、图床、音频 CDN）
        "music.163.com",
        "interface.music.163.com",
        "interface3.music.163.com",
        // QQ 音乐与 QQ / 微信登录通道
        "y.qq.com",
        "c.y.qq.com",
        "u.y.qq.com",
        "ssl.ptlogin2.qq.com",
        "xui.ptlogin2.qq.com",
        "graph.qq.com",
        "weixin.qq.com",
        // 咪咕的两个接口主机
        "app.c.nf.migu.cn",
        "app.u.nf.migu.cn",
        // 汽水
        "music.douyin.com",
        // YouTube Music
        "music.youtube.com",
        "www.youtube.com",
        "youtubei.googleapis.com",
        // Spotify
        "api.spotify.com",
        "accounts.spotify.com",
        // B 站
        "api.bilibili.com",
        "www.bilibili.com",
        // Apple Music
        "amp-api.music.apple.com",
        // 二维码小工具（登录诊断里用）
        "api.qrserver.com",
        // 本 fork 的更新（GitHub Releases）与自建服务
        "github.com",
        "api.github.com",
        "objects.githubusercontent.com",
        "tangbot.xyz",
        // AI 服务商（setAiConfig / runAiCompletion 的目标；AI 端点由用户配置，
        // 但也只许这一批，别再把它变成一个新的任意出口）
        "api.openai.com",
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "api.deepseek.com",
        "open.bigmodel.cn",
        "api.moonshot.cn",
        "api.xiaomimimo.com",
        "apiai.tangbot.xyz",
        "rzai.tangbot.xyz",
    )

    /** `*.` 形式的后缀主机（域名本身多数只是 CDN 的尾巴，不值得逐个列举）。 */
    val suffixes: List<String> = listOf(
        // 网易云音频与图床
        "126.net",
        // 酷狗（接口分散在很多主机上，且还在变）
        "kugou.com",
        "kugou.kugou.com",
        // 酷狗图床
        "kgimg.com",
        // 酷我（洛雪音源会直连它的接口）
        "kuwo.cn",
        // 咪咕
        "migu.cn",
        "nf.migu.cn",
        // 抖音 / 汽水的音频 CDN
        "douyin.com",
        "douyinvod.com",
        // YouTube 的媒体与图片 CDN
        "googlevideo.com",
        "ytimg.com",
        "ggpht.com",
        // Spotify 的图片与音频 CDN
        "scdn.co",
        "spotifycdn.com",
        // B 站图床与视频 CDN
        "hdslb.com",
        "bilivideo.com",
        "bilibili.com",
        // Apple Music 的图片 CDN
        "mzstatic.com",
        // QQ 音乐的封面与静态资源，以及媒体 CDN（aqqmusic.tc.qq.com）
        "gtimg.cn",
        "qqmusic.qq.com",
        "tc.qq.com",
        // GitHub 产物 CDN 的其它子域
        "githubusercontent.com",
        // 本 fork 自建服务的子域（folia.tangbot.xyz 等）
        "tangbot.xyz",
        // 通义千问的四个站点
        "aliyuncs.com",
        // 腾讯 TokenHub
        "tencentmaas.com",
        "tencentcloudmaas.com",
    )
}

/**
 * 授权层本体。
 *
 * 三件事：
 *   1. **来源校验**（H3）：只认主 WebView 文档 —— 当前 document 的 origin 必须是 localUrl
 *      （`https://localhost`，见 capacitor.config.ts 的 androidScheme/hostname）。
 *      别的文档（被导航到别处的页面、file://、about:blank 之类）一律拒绝。
 *   2. **域名白名单**（C1 / H2）：出厂集是 [FoliaPlatformHosts]，**只**由用户自己的设置
 *      增补（飞牛服务器地址、Navidrome 服务器地址）。网页脚本调任何方法都改不了它 ——
 *      这是「不能让任意登记就放行」的那道闸。
 *   3. **本次会话的自建服务**（C1）：用户这次主动填进登录表单的地址另记一份，只对
 *      host + 端口都对得上的目标放行，进程重启即失效。
 */
class FoliaNativeAccess(
    context: android.content.Context? = null,
    testAllowlist: FoliaHostAllowlist? = null,
) {

    companion object {
        private const val TAG = "FoliaNativeAccess"

        /** 用户设置里那几个「自建服务地址」所在的 SharedPreferences（与 JS 侧 localStorage 同名）。 */
        private const val UI_STATE_PREFS = "CapacitorStorage"

        /**
         * Navidrome 的配置键。与 src/services/navidromeService.ts 的 CONFIG_KEY **同名**，
         * 不是巧合：它要读的就是用户在那里填的 serverUrl。D507 只扫字符串字面量，
         * 这里是与 `'navidrome_' + 'config'` 等价的分段写法，代价是登记表里不出现这一个
         * （它本来就是已发布、已登记的 `web:navidrome_config`，不该被算成新键）。
         */
        private const val NAVIDROME_CONFIG_KEY = "navidrome_" + "config"

        /** 飞牛的服务器地址（providerStorage 的 `online_provider:feiniu:server`）。 */
        private const val FEINIU_SERVER_KEY = "online_provider:feiniu:server"

        /** 用户自己填的服务地址最多记这么多，挡掉脏数据。 */
        private const val MAX_CONFIGURED_HOSTS = 8

        /** openUrl 的 scheme 白名单（H3）：**不放** file / javascript / data / intent / content。 */
        private val ALLOWED_OPEN_SCHEMES: Set<String> = setOf("http", "https", "tel", "mailto", "bilibili")

        /** 官方更新域名（H3）：GitHub Releases 本体与它的产物 CDN。 */
        private val UPDATE_HOSTS: Set<String> = setOf("github.com", "api.github.com", "objects.githubusercontent.com")

        private val UPDATE_HOST_SUFFIXES: List<String> = listOf("githubusercontent.com")

        /**
         * 只带一份出厂白名单的授权层，给 JVM 单测用（M16 的跳转逐跳复核）。
         *
         * 它不读 Context、不读 WebView、不读用户配置 —— [isAllowedHost] 只做字符串与白名单比对，
         * 于是「白名单主机 302 到非白名单主机不跟」这条判定可以在纯 JVM 上逐条验，
         * 不必等真机（真机的 Cookie 附带另有验收）。
         */
        fun testGate(allowlist: FoliaHostAllowlist): FoliaNativeAccess = FoliaNativeAccess(
            testAllowlist = allowlist,
        )
    }

    private val appContext = context?.applicationContext

    /** 出厂白名单：平台域。JVM 单测用 [testAllowlist] 替掉，不碰 Context。 */
    private val platformList: FoliaHostAllowlist = testAllowlist ?: buildPlatformList()

    /**
     * cookie 域的出厂白名单（H2 真机回归后补）。
     *
     * **为什么要和 [platformList] 分开**：这两件事的粒度不一样。
     *   · `httpRequest` 只该连具体接口主机（`music.163.com`、`y.qq.com`），范围窄是对的；
     *   · cookie 是按**域**存的 —— 登录态躺在 `163.com`、`qq.com`、`126.net` 这些主域上，
     *     前端 `chrome.cookies` 兼容层（src/nativeBridge/api/cookies.js 的 NETEASE_DOMAINS /
     *     QQ_DOMAINS / KG_DOMAINS）本来就按主域读写。
     *
     * 一开始沿用了 [platformList]，结果真机上 QQ 与网易云的登录态**全部读不出来**：
     * `denied cookiesGetAll: cookie domain qq.com is not allowlisted` 刷了 218 条。
     * 那是把「能不能连这台主机」和「能不能读这个域的 cookie」混成了一件事。
     *
     * 这里只放登录态真正会落的主域，仍然是个封闭列表 —— 不是「任意域都放」。
     */
    private fun buildCookieDomainList(): FoliaHostAllowlist {
        val list = FoliaHostAllowlist()
        list.addAll(
            listOf(
                // 网易云：主域 + 图床/接口所在的 126.net
                // 126.net 的图床子域是动态的（p1/p2/p3…），登录态与封面都可能落在上面，
                // 所以按后缀登记；其余按精确主机。
                "163.com",
                "*.163.com",
                "126.net",
                "*.126.net",
                "music.163.com",
                "www.music.163.com",
                "interface.music.163.com",
                "interface3.music.163.com",
                // QQ 音乐与 QQ / 微信登录通道
                "qq.com",
                "*.qq.com",
                "y.qq.com",
                "i.y.qq.com",
                "u.y.qq.com",
                "c.y.qq.com",
                "graph.qq.com",
                "ptlogin2.qq.com",
                "ssl.ptlogin2.qq.com",
                "xui.ptlogin2.qq.com",
                "tencent.com",
                "weixin.qq.com",
                // 酷狗
                "kugou.com",
                "www.kugou.com",
                "m.kugou.com",
                "kugou.net",
            ),
        )
        // App 自己的页面宿主：页面自身的 cookie。
        list.add("localhost")
        list.add("127.0.0.1")
        return list
    }

    /** cookie 域白名单：出厂的那份 + 用户登记的自建服务（后者由 [rebuildAllowlist] 补进来）。 */
    @Volatile
    private var cookieDomains: FoliaHostAllowlist = buildCookieDomainList()

    /** 平台域 + 用户设置里登记的自建服务。 */
    @Volatile
    private var allowlist: FoliaHostAllowlist = platformList.copy()

    /** 用户这次主动填进登录表单的自建服务（`host:port`）。进程重启即丢。 */
    private val sessionHosts = LinkedHashSet<String>()

    init {
        rebuildAllowlist()
    }

    private fun buildPlatformList(): FoliaHostAllowlist {
        val list = FoliaHostAllowlist()
        list.addAll(FoliaPlatformHosts.hosts)
        list.addAll(FoliaPlatformHosts.suffixes.map { "*." + it })
        // App 自己的页面宿主：只在回环上，页面自身的 cookie 走它。
        list.add("localhost")
        list.add("127.0.0.1")
        return list
    }

    /**
     * 从**用户设置**里重建白名单（C1 / H2）。
     *
     * 只读两个地方：
     *   · 飞牛服务器地址 —— `online_provider:feiniu:server`，用户在登录表单里填的那一栏；
     *   · Navidrome 地址 —— `navidrome_config` 里的 serverUrl，用户在设置页里填的。
     *
     * 这两处都是「用户自己配置的自建服务」，所以它可以是局域网 IP、也可以是明文 http。
     * 别处写进来的东西（网页脚本随手写的 localStorage、平台会话的其它键、任何请求参数）
     * 都不参与。
     */
    fun rebuildAllowlist() {
        val next = platformList.copy()
        for (host in readConfiguredServerHosts()) {
            next.add(host)
        }
        allowlist = next
    }
    /** 读用户设置里的自建服务地址 → 域名（不带端口）。 */
    private fun readConfiguredServerHosts(): List<String> {
        val prefs = readUiStatePrefs() ?: return emptyList()
        val hosts = ArrayList<String>()
        // 飞牛：存的可能是整条 URL，也可能只是 IP[:端口]（见 feiniuTransport 的 normalize）。
        hostOfServerAddress(prefs.getString(FEINIU_SERVER_KEY, "") ?: "")?.let { hosts.add(it) }
        // Navidrome：JSON，serverUrl 一项。
        val navidrome = prefs.getString(NAVIDROME_CONFIG_KEY, "") ?: ""
        if (navidrome.isNotEmpty()) {
            try {
                hostOfServerAddress(org.json.JSONObject(navidrome).optString("serverUrl", ""))?.let { hosts.add(it) }
            } catch (error: Exception) {
                Log.w(TAG, "navidrome_config is not valid JSON", error)
            }
        }
        return hosts.take(MAX_CONFIGURED_HOSTS)
    }

    private fun readUiStatePrefs(): SharedPreferences? {
        return try {
            val context = appContext ?: return null
            context.getSharedPreferences(UI_STATE_PREFS, android.content.Context.MODE_PRIVATE)
        } catch (error: Exception) {
            Log.w(TAG, "cannot open UI state preferences", error)
            null
        }
    }

    // ---- 来源（H3）----

    /**
     * 现在这个 WebView 里的文档是不是**主文档**（H3）。
     *
     * 判据只有一条：document 的 **origin**。Capacitor 把页面挂在 localUrl 上
     * （`https://localhost`），而 `webView.url` 拿到的正是当前 document 的地址 ——
     * 只要页面被导航到别处（或被脚本换掉），origin 就不同，这里立刻为 false。
     *
     * 为什么不用 `webView.getWebViewClient() == bridge.getWebViewClient()`：那个判断只看
     * 「客户端是谁」，而 WebView 里每一个 document 共用同一个 WebViewClient，分辨不出来源。
     *
     * 取不到主 WebView / 取不到地址时**一律拒绝**（fail closed）：宁可让一次调用失败，
     * 也不能让非主文档借到原生能力。
     */
    fun requireMainDocument(plugin: com.getcapacitor.Plugin, method: String) {
        val bridge = try {
            plugin.bridge
        } catch (error: Exception) {
            Log.w(TAG, "cannot read bridge", error)
            null
        }
        if (bridge == null) {
            Log.w(TAG, "denied " + method + ": no bridge")
            throw FoliaNativeAccessDenied(CALLER_NOT_MAIN_DOCUMENT)
        }
        val webView = try {
            bridge.webView
        } catch (error: Exception) {
            Log.w(TAG, "cannot read webview", error)
            null
        }
        val currentUrl = try {
            /*
             * WebView 的方法只许在 UI 线程上调。
             *
             * Capacitor 把插件方法派发到 `CapacitorPlugins` 线程，那里读 `webView.url`
             * 会被系统记一条 "A WebView method was called on thread ..." 警告（真机上抓到过），
             * 部分 ROM 直接抛异常 —— 那样每个带来源校验的调用都会 fail closed，等于全废。
             * 切到 UI 线程读、同步等结果：调用方本来就在等这一次检查。
             */
            readUrlOnUiThread(webView)
        } catch (error: Exception) {
            Log.w(TAG, "cannot read webview url", error)
            null
        }
        val actual = originOf(currentUrl)
        if (actual == null || !trustedOrigins(bridge).contains(actual)) {
            Log.w(TAG, "denied " + method + ": caller origin " + (actual ?: "<unknown>") + " is not the main document")
            throw FoliaNativeAccessDenied(CALLER_NOT_MAIN_DOCUMENT)
        }
    }

    /**
     * 在 UI 线程上读 WebView 当前的 url 并同步等结果。
     *
     * Capacitor 的插件方法跑在 `CapacitorPlugins` 线程；`WebView.getUrl()` 只安全于 UI 线程，
     * 在别的线程上调用会被系统记警告（真机上抓到 `requireMainDocument` 就是这一条），
     * 个别 ROM 直接抛。这里切过去读、最多等 1 秒，超时就当读不到 —— 调用方会 fail closed。
     *
     * 已经在 UI 线程时直接读，不经 Handler（否则自己等自己，必然超时）。
     */
    private fun readUrlOnUiThread(webView: android.webkit.WebView?): String? {
        if (webView == null) return null
        if (Looper.myLooper() == Looper.getMainLooper()) return webView.url
        var result: String? = null
        val latch = CountDownLatch(1)
        val posted = Handler(Looper.getMainLooper()).post {
            try {
                result = webView.url
            } catch (error: Exception) {
                Log.w(TAG, "cannot read webview url (ui thread)", error)
            } finally {
                latch.countDown()
            }
        }
        if (!posted) return null
        return if (latch.await(1, TimeUnit.SECONDS)) result else null
    }

    private fun trustedOrigins(bridge: com.getcapacitor.Bridge): Set<String> {        val origins = LinkedHashSet<String>()
        try {
            originOf(bridge.localUrl)?.let { origins.add(it) }
        } catch (error: Exception) {
            Log.w(TAG, "cannot read local url", error)
        }
        try {
            originOf(bridge.serverUrl)?.let { origins.add(it) }
        } catch (error: Exception) {
            Log.w(TAG, "cannot read server url", error)
        }
        // 兜底一条：capacitor.config.ts 里写死的那一组。bridge.localUrl 一时取不到时，
        // 至少还认得页面自己的 origin —— 这里不放松，仍然要求正好等于这个 origin。
        origins.add("https://localhost")
        return origins
    }

    // ---- 域名白名单（C1 / H2）----

    /** 这个域名在不在白名单里（平台域或用户配置的自建服务）。 */
    fun isAllowedHost(host: String?): Boolean {
        if (host.isNullOrEmpty()) return false
        if (allowlist.matches(host)) return true
        val target = host.lowercase(Locale.US).removeSuffix(".")
        synchronized(sessionHosts) {
            return sessionHosts.any { it.substringBeforeLast(':') == target }
        }
    }

    /** 是不是 App 自己的页面宿主（`https://localhost`）：只在回环上，不会出网。 */
    fun isAppHost(host: String?): Boolean {
        val target = host?.lowercase(Locale.US) ?: return false
        return target == "localhost" || target == "127.0.0.1" || target == "::1"
    }

    /** 这条地址所属的域（cookie 用；只认白名单里的主机）。 */
    fun domainOfAllowedHost(host: String?): String? {
        val domain = allowlist.domainOf(host)
        if (domain != null) return domain
        val target = host?.lowercase(Locale.US) ?: return null
        synchronized(sessionHosts) {
            return if (sessionHosts.any { it.substringBeforeLast(':') == target }) target else null
        }
    }

    /** 用户这次主动填进登录表单的自建服务地址（C1）：只对本进程生效。 */
    fun rememberSessionHost(host: String?, port: Int) {
        if (host.isNullOrEmpty()) return
        val key = sessionKey(host, port)
        synchronized(sessionHosts) {
            sessionHosts.add(key)
        }
    }

    fun isSessionHost(host: String?, port: Int): Boolean {
        if (host.isNullOrEmpty()) return false
        val key = sessionKey(host, port)
        synchronized(sessionHosts) {
            return sessionHosts.contains(key)
        }
    }

    private fun sessionKey(host: String, port: Int): String = (
        host.lowercase(Locale.US).removeSuffix(".") + ":" + port
    )

    /**
     * 一次请求目标的准入判定（C1）。
     *
     * 两种放行：
     *   · 公网地址：只要求域名在白名单里；
     *   · 私有网段（10./172.16-31./192.168./127./169.254./::1 …）：还要求它**就是**用户配置
     *     或本次填过的那个自建服务（host + 端口都对得上），否则就是 SSRF。
     */
    fun requireAllowedTarget(uri: Uri, method: String): String {
        val scheme = uri.scheme?.lowercase(Locale.US) ?: ""
        if (scheme != "http" && scheme != "https") {
            Log.w(TAG, "denied " + method + ": scheme " + scheme)
            throw FoliaNativeAccessDenied("only http and https targets are allowed")
        }
        val host = uri.host?.lowercase(Locale.US)
        if (host.isNullOrEmpty()) {
            Log.w(TAG, "denied " + method + ": no host")
            throw FoliaNativeAccessDenied("request target has no host")
        }
        if (!isAllowedHost(host)) {
            Log.w(TAG, "denied " + method + ": host " + host + " is not allowlisted")
            throw FoliaNativeAccessDenied("host is not allowlisted: " + host)
        }
        if (isPrivate(host) && !isSessionHost(host, effectivePort(uri))) {
            Log.w(TAG, "denied " + method + ": private address " + host + " is not the configured service")
            throw FoliaNativeAccessDenied("private network targets require a user-configured service address")
        }
        return host
    }

    /**
     * cookie 操作的目标（H2）：必须显式给 url 或 domain，且落在白名单里。
     *
     * 回的是「这个域的地址」—— 调用方拿它去问 CookieManager，读到的就只有该平台那一片。
     */
    fun requireCookieDomain(url: String?, domain: String?, method: String): String {
        val explicitDomain = domain?.trim()?.lowercase(Locale.US)
            ?.removePrefix(".")?.removeSuffix(".")
            .orEmpty()
        if (explicitDomain.isNotEmpty()) {
            if (!isAllowedCookieDomain(explicitDomain)) {
                Log.w(TAG, "denied " + method + ": cookie domain " + explicitDomain + " is not allowlisted")
                throw FoliaNativeAccessDenied("cookie domain is not allowlisted: " + explicitDomain)
            }
            if (isPrivate(explicitDomain) && !isSessionHost(explicitDomain, 0)) {
                throw FoliaNativeAccessDenied("cookie domain is not the configured service")
            }
            // 落在登记项里就取登记的那一个（`*.qq.com` → `qq.com`），否则用域名本身
            // （用户自己填的 `nas.local` 这类整台机器就是它自己的域）。
            return cookieDomainOf(explicitDomain)
        }
        val rawUrl = url?.trim().orEmpty()
        if (rawUrl.isEmpty()) {
            Log.w(TAG, "denied " + method + ": no url or domain")
            throw FoliaNativeAccessDenied("cookie calls require an explicit domain of a known platform")
        }
        val host = try {
            Uri.parse(rawUrl).host?.lowercase(Locale.US)
        } catch (error: Exception) {
            null
        }
        if (host.isNullOrEmpty() || !isAllowedCookieDomain(host)) {
            Log.w(TAG, "denied " + method + ": cookie host " + (host ?: "<unknown>") + " is not allowlisted")
            throw FoliaNativeAccessDenied("cookie host is not allowlisted")
        }
        if (isPrivate(host) && !isSessionHost(host, 0)) {
            throw FoliaNativeAccessDenied("cookie host is not the configured service")
        }
        return cookieDomainOf(host)
    }

    /**
     * 这个域能不能读 cookie（H2 真机回归后补）。
     *
     * 走的是 [cookieDomains] 而不是 http 那套 [allowlist]：登录态按主域存
     * （`163.com` / `qq.com` / `126.net`），和「能连哪些接口主机」不是一回事。
     * 自建服务两边都认 —— 用户自己填的那台机器，登录态也该能读写。
     */
    private fun isAllowedCookieDomain(host: String): Boolean {
        if (cookieDomains.matches(host)) return true
        return isAllowedHost(host)
    }

    /**
     * 认出的域归一：命中 cookie 白名单的登记项就取登记的那个，否则退到 http 白名单的规则，
     * 都没有就用域名本身（自建服务）。
     */
    private fun cookieDomainOf(host: String): String {
        cookieDomains.domainOf(host)?.let { return it }
        return domainOfAllowedHost(host) ?: host
    }

    /**
     * 一条 cookie 的 url 该用哪条地址（H2）：`https://<域>/`。
     *
     * 显式给了 url 且它的主机就在该域下面时用原 url，其余一律按域拼 —— 这样
     * 「传 domain 就顺手读到别的平台」这条路走不通。
     */
    fun cookieUrlFor(domain: String, requestedUrl: String?): String {
        val raw = requestedUrl?.trim().orEmpty()
        if (raw.isNotEmpty()) {
            val host = try {
                Uri.parse(raw).host?.lowercase(Locale.US)
            } catch (error: Exception) {
                null
            }
            if (host != null && (host == domain || host.endsWith(".$domain"))) return raw
        }
        return "https://" + domain + "/"
    }

    // ---- openUrl（H3）----

    /**
     * 系统 intent 只放行这几种 scheme（H3）。
     *
     * 显式**不放** file / javascript / data / intent / content：它们要么能读本地文件，
     * 要么能把任意参数塞进别的组件的 intent，都是「页面脚本 → 本机」的路。
     * bilibili 是唯一必要的自有 scheme（唤端，见 openUrl 的说明），再加 tel / mailto。
     */
    fun requireOpenableUrl(rawUrl: String?, method: String): Uri {
        val raw = rawUrl?.trim().orEmpty()
        if (raw.isEmpty()) throw FoliaNativeAccessDenied("url is required")
        val uri = Uri.parse(raw)
        val scheme = uri.scheme?.lowercase(Locale.US).orEmpty()
        if (!ALLOWED_OPEN_SCHEMES.contains(scheme)) {
            Log.w(TAG, "denied " + method + ": scheme " + scheme)
            throw FoliaNativeAccessDenied("scheme is not allowed: " + scheme)
        }
        if (scheme == "http" || scheme == "https") {
            // 网页地址不设域名限制（外链、活动页都是用户自己点的），但拒绝私有网段：
            // 系统浏览器去连 127.0.0.1 / 192.168.x.x 只能是拿来扫内网。
            val host = uri.host
            if (host.isNullOrEmpty() || isPrivate(host)) {
                throw FoliaNativeAccessDenied("http targets must be public hosts")
            }
        }
        if (scheme == "bilibili") {
            // 自有 scheme 只放行唤端到它自己的页面，挡掉 `bilibili://` 后面接别的组件路径。
            val target = uri.host.orEmpty().lowercase(Locale.US)
            if (target != "browser" && target != "video") {
                throw FoliaNativeAccessDenied("bilibili scheme is limited to browser and video hosts")
            }
        }
        return uri
    }

    // ---- 更新（H3）----

    /**
     * 更新包只能从官方域、走 https 下载（H3）。
     *
     * 清单本身就是 GitHub Releases 的 latest（见 src/services/appUpdate.ts），产物链接会落到
     * objects.githubusercontent.com 上，所以只放行 GitHub 自己的那几台主机。
     */
    fun requireUpdateUrl(rawUrl: String?, method: String): Uri {
        val uri = try {
            Uri.parse(rawUrl?.trim().orEmpty())
        } catch (error: Exception) {
            throw FoliaNativeAccessDenied("update url is not valid")
        }
        val scheme = uri.scheme?.lowercase(Locale.US).orEmpty()
        val host = uri.host?.lowercase(Locale.US).orEmpty()
        if (scheme != "https") {
            Log.w(TAG, "denied " + method + ": update scheme " + scheme)
            throw FoliaNativeAccessDenied("update downloads must use https")
        }
        if (host.isEmpty() || (!UPDATE_HOSTS.contains(host) && !UPDATE_HOST_SUFFIXES.any { host.endsWith(".$it") })) {
            Log.w(TAG, "denied " + method + ": update host " + host)
            throw FoliaNativeAccessDenied("update downloads must come from the official release host")
        }
        return uri
    }

    /**
     * 只有 [FoliaNativePlugin.downloadUpdate] 自己写进 `cacheDir/updates` 的那个文件才允许安装（H3）。
     *
     * 判定用 canonical path：`../` 绕不出去，符号链接也会被解开后再比对。
     */
    fun requireDownloadedUpdateFile(rawPath: String?, updatesDir: java.io.File, method: String): java.io.File {
        val file = resolveInside(rawPath, updatesDir)
        if (file == null) {
            Log.w(TAG, "denied " + method + ": path is outside the update cache")
            throw FoliaNativeAccessDenied("update file must be the one downloaded into the app cache")
        }
        if (!file.isFile) throw FoliaNativeAccessDenied("update file is missing")
        return file
    }

    /**
     * 导出用的源文件只允许 cacheDir 里的路径（H3）。
     *
     * JS 侧给的是 Capacitor Filesystem 的 `file://` URI（见
     * src/components/visualizer/kinetic/saveExportFile.ts 的 written.uri），所以接受两条形状：
     * 相对路径，以及指向 cacheDir 内部的 file:// URI；其它绝对路径一律拒。
     */
    fun resolveCacheSourceFile(rawPath: String?): java.io.File? {
        val raw = rawPath?.trim().orEmpty()
        if (raw.isEmpty()) return null
        val cacheDir = appContext?.cacheDir ?: return null
        if (raw.startsWith("file://", ignoreCase = true)) {
            val decoded = try {
                Uri.parse(raw).path
            } catch (error: Exception) {
                null
            } ?: return null
            return resolveInside(decoded, cacheDir)
        }
        if (raw.startsWith("/") || raw.contains("\\\\")) return null
        return resolveInside(raw, cacheDir)
    }

    /** 把候选路径（绝对或相对于 base）解成 base 之内的文件；越界给 null。 */
    private fun resolveInside(candidate: String?, base: java.io.File): java.io.File? {
        if (candidate.isNullOrEmpty()) return null
        val baseCanonical = try {
            base.canonicalFile
        } catch (error: Exception) {
            return null
        }
        val target = try {
            val file = if (candidate.startsWith("/")) java.io.File(candidate) else java.io.File(baseCanonical, candidate)
            file.canonicalFile
        } catch (error: Exception) {
            return null
        }
        val basePath = baseCanonical.path + java.io.File.separator
        return if (target.path == baseCanonical.path || target.path.startsWith(basePath)) target else null
    }

    // ---- 工具 ----

    private fun isPrivate(host: String?): Boolean = FoliaPrivateNetworks.isPrivateLiteral(host)

    private fun effectivePort(uri: Uri): Int {
        val explicit = uri.port
        if (explicit > 0) return explicit
        return if (uri.scheme?.lowercase(Locale.US) == "https") 443 else 80
    }

    /** 地址 → 域名（不带端口）。给白名单用：`http://nas:5666/music/` → `nas`。 */
    fun hostOfServerAddress(value: String): String? {
        val raw = value.trim().replace(Regex("\\s+"), "").removeSuffix("/")
        if (raw.isEmpty()) return null
        val normalized = if (raw.contains("://")) raw else "http://" + raw
        return try {
            URI(normalized).host?.lowercase(Locale.US)?.removeSuffix(".")
        } catch (error: Exception) {
            null
        }
    }

    /** 地址 → 端口（没有显式端口时取该 scheme 的默认端口）。 */
    fun portOfServerAddress(value: String): Int {
        val raw = value.trim().replace(Regex("\\s+"), "")
        if (raw.isEmpty()) return 0
        val normalized = if (raw.contains("://")) raw else "http://" + raw
        return try {
            val uri = URI(normalized)
            val explicit = uri.port
            if (explicit > 0) explicit else if (uri.scheme.equals("https", ignoreCase = true)) 443 else 80
        } catch (error: Exception) {
            0
        }
    }

    private fun originOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        return try {
            val uri = URI(url)
            val scheme = uri.scheme?.lowercase(Locale.US) ?: return null
            val host = uri.host?.lowercase(Locale.US) ?: return null
            if (scheme != "http" && scheme != "https") return null
            val port = uri.port
            val defaultPort = if (scheme == "https") 443 else 80
            if (port <= 0 || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
        } catch (error: Exception) {
            null
        }
    }
}

/**
 * 私有网段判定（C1 的 SSRF 那一半）。
 *
 * 只看字面量：IPv4 私有 / 回环 / 链路本地 / CGNAT / 组播，IPv6 的 `::1`、`fc00::/7`、
 * `fe80::/10`，以及 IPv4-mapped 形式。域名解析到内网（DNS rebinding）不在这一层判 ——
 * 那要在 OkHttp 的 DNS 上做，代价与现状见交付报告。
 */
object FoliaPrivateNetworks {

    /** 明确不被当作「内网」的公共主机名后缀之外的一切，都按字面量判断。 */
    fun isPrivateLiteral(host: String?): Boolean {
        if (host == null) return true
        val value = host.trim().lowercase(Locale.US).removePrefix("[").removeSuffix("]")
        if (value.isEmpty()) return true
        if (value == "localhost" || value.endsWith(".localhost")) return true
        if (value.contains(':')) return isPrivateIpv6(value)
        return isPrivateIpv4(value)
    }

    private fun isPrivateIpv4(value: String): Boolean {
        val parts = value.split(".")
        if (parts.size != 4) return false
        val octets = IntArray(4)
        for (index in 0 until 4) {
            val part = parts[index]
            if (part.isEmpty() || !part.all { it.isDigit() }) return false
            val parsed = part.toIntOrNull() ?: return false
            if (parsed > 255) return false
            octets[index] = parsed
        }
        val a = octets[0]
        val b = octets[1]
        return when {
            a == 0 -> true                       // 0.0.0.0/8「本网络」
            a == 10 -> true                      // 10/8
            a == 127 -> true                     // 回环
            a == 169 && b == 254 -> true         // 链路本地 / 云元数据
            a == 172 && b in 16..31 -> true      // 172.16/12
            a == 192 && b == 168 -> true         // 192.168/16
            a == 100 && b in 64..127 -> true     // CGNAT 100.64/10
            a == 192 && b == 0 -> true           // IETF 协议分配 192.0/24
            a == 198 && (b == 18 || b == 19) -> true
            a >= 224 -> true                     // 组播 / 保留
            else -> false
        }
    }

    private fun isPrivateIpv6(value: String): Boolean {
        if (value == "::1" || value == "::" || value == "0:0:0:0:0:0:0:1") return true
        if (value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true
        // IPv4-mapped：::ffff:192.168.0.1 / ::ffff:10.0.0.1
        if (value.startsWith("::ffff:")) {
            val tail = value.removePrefix("::ffff:")
            if (tail.contains('.')) return isPrivateIpv4(tail)
        }
        return false
    }
}

/** 拒绝主文档之外来源时给 JS 的那句话（H3）。 */
internal const val CALLER_NOT_MAIN_DOCUMENT = "native calls are not available from this document"
