package top.izuna.foliamajor

import android.util.Log
import android.webkit.CookieManager

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

import java.io.IOException

import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

import java.util.concurrent.TimeUnit

/**
 * bilibili 请求的原生桥。
 *
 * 为什么需要它：api.bilibili.com 不给任意来源 CORS 头，WebView 里直连一定被拦下
 * （桌面端是靠 electron/bilibili.cjs 在主进程里转发解决的）。安卓没有那个主进程，
 * 于是借 OkHttp 代发 —— 和 FoliaNative.httpRequest 是同一套思路。
 *
 * 只做**只读 GET**：搜索、取详情、取播放地址这三件事。不碰登录，不带 cookie：
 * 实测 nav / search / playurl 在未登录时都回 code=0，只有画质上限会停在 480p
 * （1080p 要大会员）。所以这个桥不需要任何账号状态。
 *
 * 响应体一律以**字符串**回给渲染层，由 JS 自己去 JSON.parse —— Capacitor 的嵌套
 * 对象转换在个别版本上会把内层对象丢成 null，字符串零歧义（同 FoliaNative 的教训）。
 */
@CapacitorPlugin(name = "FoliaBilibili")
class FoliaBilibiliPlugin : Plugin() {
    companion object {
        private const val TAG = "FoliaBilibili"

        /**
         * bilibili 的接口要一个像浏览器的 UA 和一个 bilibili 的 Referer。
         *
         * 不补这两个时接口会回 -352（风控）。实测视频 CDN 直链反而不校验 Referer，
         * 但接口层是校验的。
         */
        private const val USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/120.0.0.0 Mobile Safari/537.36"
        private const val REFERER = "https://www.bilibili.com/"
    }

    /** 读超时放宽到 30 秒：搜索接口偶尔慢，但不该像 AI 那样给到 150 秒。 */
    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }

    /**
     * 发一次 GET，把状态码和响应体原文带回去。
     *
     * 参数：
     * - `url`：完整地址（带查询串），由渲染层拼好；
     * - `headers`：可选的额外请求头。
     *
     * 回 `{ ok, status, bodyText }`。`ok` 只表示 HTTP 通不通，业务码由渲染层解析 ——
     * 这样「bilibili 回 -404 说没有这条视频」和「网络断了」在 JS 那边分得开。
     */
    @PluginMethod
    fun request(call: PluginCall) {
        val url = call.getString("url")
        if (url == null || url.isEmpty()) {
            call.reject("url is required")
            return
        }
        if (!url.startsWith("https://")) {
            // 只允许 https：这个桥是通用 GET，别让它变成任意协议的手脚。
            call.reject("only https urls are allowed")
            return
        }

        val builder = Request.Builder()
            .url(url)
            .get()
            .header("User-Agent", USER_AGENT)
            .header("Referer", REFERER)
            .header("Accept", "application/json, text/plain, */*")

        /*
         * 带上 CookieManager 里的 bilibili cookie。
         *
         * 登录是可选的：没登录时这里什么都不会带上，接口照常回 480p 的流。
         * 登录过（扫码）之后，大会员账号就能拿到 1080p。
         *
         * cookie 由登录流程写进 CookieManager，这里只读 —— 插件本身不发登录请求，
         * 也不持有任何凭据，重启 App 后仍在。
         */
        val cookie = CookieManager.getInstance().getCookie(REFERER)
        if (!cookie.isNullOrEmpty()) {
            builder.header("Cookie", cookie)
        }

        val extra = call.getObject("headers", null)
        if (extra != null) {
            for (key in extra.keys()) {
                val value = extra.getString(key)
                if (!key.isNullOrEmpty() && value != null) {
                    // 不允许调用方覆盖 UA / Referer：风控就靠这两个。
                    if (key.equals("user-agent", ignoreCase = true) || key.equals("referer", ignoreCase = true)) {
                        continue
                    }
                    builder.header(key, value)
                }
            }
        }

        // 等待交给 OkHttp 的线程池，别占着桥线程（见 FoliaNativePlugin 那条教训）。
        call.setKeepAlive(true)
        try {
            client.newCall(builder.build()).enqueue(object : Callback {
                override fun onFailure(httpCall: Call, error: IOException) {
                    Log.w(TAG, "request failed: ${error.message}")
                    call.reject(error.message ?: "network error", error)
                }

                override fun onResponse(httpCall: Call, response: Response) {
                    try {
                        response.use { it ->
                            val text = it.body?.string() ?: ""
                            val result = JSObject()
                            result.put("ok", it.isSuccessful)
                            result.put("status", it.code)
                            result.put("bodyText", text)
                            /*
                             * 把 Set-Cookie 原样带回去，扫码登录要用。
                             *
                             * bilibili 的登录 cookie 不在响应体里，全在 Set-Cookie 头上；
                             * 换 cookie 那一步的响应体还是个跨域跳转页。所以这里必须把头带出去，
                             * 否则前端拿不到 SESSDATA。
                             */
                            val setCookies = JSArray()
                            for (header in it.headers.values("Set-Cookie")) {
                                setCookies.put(header)
                            }
                            result.put("setCookies", setCookies)
                            call.resolve(result)
                        }
                    } catch (error: IOException) {
                        call.reject(error.message ?: "unreadable response", error)
                    } catch (error: IllegalArgumentException) {
                        call.reject(error.message ?: "unreadable response", error)
                    }
                }
            })
        } catch (error: IllegalArgumentException) {
            call.reject(error.message ?: "bad url", error)
        }
    }

    /**
     * 取出当前 bilibili 登录态：有没有 cookie、DedeUserID 是谁。
     *
     * 只回「有没有登录」和 uid，**不回 cookie 本身** —— 渲染层不需要，也不该碰。
     */
    @PluginMethod
    fun authStatus(call: PluginCall) {
        val cookie = CookieManager.getInstance().getCookie(REFERER) ?: ""
        val sessdata = cookieValue(cookie, "SESSDATA")
        val uid = cookieValue(cookie, "DedeUserID")
        val result = JSObject()
        result.put("signedIn", !sessdata.isNullOrEmpty())
        result.put("uid", uid ?: "")
        call.resolve(result)
    }

    /**
     * 把登录拿到的 cookie 写进 CookieManager。
     *
     * 扫码登录由 bilibili 官方的二维码接口完成（前端调 request 打那套接口），
     * 登录成功后官方会回一组 Set-Cookie。这里负责把它们落进 CookieManager，
     * 之后所有 request 都会自动带上（见 request 里的 CookieManager.getCookie）。
     *
     * 传入的形状是 `name=value; name=value`，和 Set-Cookie 拼起来的样子一致。
     */
    @PluginMethod
    fun setCookies(call: PluginCall) {
        val raw = call.getString("cookie")
        if (raw == null || raw.isEmpty()) {
            call.reject("cookie is required")
            return
        }
        val manager = CookieManager.getInstance()
        manager.setAcceptCookie(true)
        for (pair in raw.split(';')) {
            val trimmed = pair.trim()
            if (trimmed.isEmpty() || !trimmed.contains('=')) continue
            // 逐条写：Domain 用 .bilibili.com，Path=/，这样 api 与 www 两边都带得上。
            manager.setCookie(
                REFERER,
                "$trimmed; Domain=.bilibili.com; Path=/; Secure",
            )
        }
        manager.flush()
        val result = JSObject()
        result.put("ok", true)
        call.resolve(result)
    }

    /** 清掉 bilibili 的登录 cookie（注销）。 */
    @PluginMethod
    fun clearCookies(call: PluginCall) {
        val manager = CookieManager.getInstance()
        for (name in listOf("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid")) {
            manager.setCookie(REFERER, "$name=; Domain=.bilibili.com; Path=/; Max-Age=0")
        }
        manager.flush()
        val result = JSObject()
        result.put("ok", true)
        call.resolve(result)
    }

    /** 从 cookie 串里取一个值；没有就回 null。 */
    private fun cookieValue(cookie: String, name: String): String? {
        for (pair in cookie.split(';')) {
            val trimmed = pair.trim()
            val eq = trimmed.indexOf('=')
            if (eq <= 0) continue
            if (trimmed.substring(0, eq) == name) return trimmed.substring(eq + 1)
        }
        return null
    }
}
