package top.izuna.foliamajor

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.util.Log

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * Spotify 登录的原生桥（FoliaSpotify）。
 *
 * 只做两件 WebView 做不了的事：
 *
 *  · **收 OAuth 回调** —— 桌面端是在 Node 里起 `http://127.0.0.1:5588` 等着 Spotify 把浏览器
 *    送回来（见 electron/spotify/signIn.cjs）。安卓 WebView 起不了服务器，所以由 Java 起。
 *    **端口保持 5588**：那个 client_id 量过的就是 5588，换端口 Spotify 未必认，而这个
 *    client_id 不是我们的、白名单改不了。
 *  · **换 token** —— `accounts.spotify.com/api/token` 从 WebView 里调会撞 CORS。
 *
 * 拿到 access token 之后，取数据（搜索 / 歌单 / 专辑）走公开 Web API，在主 WebView 里
 * 直接 fetch，不再经过原生 —— 所以这里**没有任何取数代码**，登录之外的一切都不归它管。
 *
 * 流程与桌面端逐字对齐（授权码 + PKCE，没有 client secret）：起本地端口 → 开系统浏览器去
 * 同意页 → 浏览器带着 code 回到 5588 → 用 code_verifier 换 token。
 *
 * ⚠️ 桥线程不许被占住：登录要等用户在浏览器里走完，最坏十分钟。所以方法一律异步
 * （`setKeepAlive` + 后台线程收连接 + OkHttp 的 enqueue），等的那段时间里桥是空的 ——
 * 否则其它平台的登录与二维码会集体超时（见 FoliaNativePlugin 那条教训）。
 */
@CapacitorPlugin(name = "FoliaSpotify")
class FoliaSpotifyPlugin : Plugin() {
    companion object {
        private const val TAG = "FoliaSpotify"

        /** 与桌面端同一个 client：开源播放器共用的那个桌面客户端身份（见 electron/spotify/signIn.cjs）。 */
        private const val CLIENT_ID = "65b708073fc0480ea92a077233ca87bd"
        private const val PORT = 5588
        private const val REDIRECT_URI = "http://127.0.0.1:" + PORT + "/login"
        private const val AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
        private const val TOKEN_URL = "https://accounts.spotify.com/api/token"
        /** 一次登录最多等这么久，与桌面端一致。 */
        private const val ATTEMPT_MS = 10 * 60 * 1000
        /** 换 token 这个请求本身的上限；没有上限就可能永远等下去。 */
        private const val REQUEST_LIMIT_MS = 30 * 1000
        /** 桌面端照 librespot 的那份清单要的权限，一个字不改：少要一个，取数就会 403。 */
        private const val SCOPES =
            "app-remote-control playlist-modify playlist-modify-private playlist-modify-public playlist-read " +
                "playlist-read-collaborative playlist-read-private streaming ugc-image-upload user-follow-modify " +
                "user-follow-read user-library-modify user-library-read user-modify user-modify-playback-state " +
                "user-modify-private user-personalized user-read-birthdate user-read-currently-playing user-read-email " +
                "user-read-play-history user-read-playback-position user-read-playback-state user-read-private " +
                "user-read-recently-played user-top-read"

        /** 浏览器最后停在的那一页。它是这个应用唯一显示在窗口之外的文字。 */
        private const val PAGE_DONE = "已登录 Spotify，可以回到 Folia 了。"
        private const val PAGE_REFUSED = "未授权。请回到 Folia 重试。"
        private const val PAGE_FAILED = "登录未完成。请回到 Folia 重试。"

        /** 从 token 那份 JSON 里取一个字符串字段。不引第三方 JSON：就三个字段，正则足够。 */
        private fun field(body: String, name: String): String? {
            val matcher = java.util.regex.Pattern
                .compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"")
                .matcher(body)
            return if (matcher.find()) matcher.group(1) else null
        }

        private fun failure(code: String, message: String): JSObject {
            val error = JSObject()
            error.put("code", code)
            error.put("message", message)
            val result = JSObject()
            result.put("ok", false)
            result.put("error", error)
            return result
        }

        private fun pageOf(text: String): String {
            return ("<!doctype html><meta charset=\"utf-8\"><title>Folia</title><body style=\"margin:0;display:grid;" +
                "place-items:center;height:100vh;background:#121212;color:#fff;font:16px system-ui,sans-serif\">" +
                text + "</body>")
        }

        private fun query(raw: String): MutableMap<String, String> {
            val map = java.util.HashMap<String, String>()
            if (raw.isEmpty()) return map
            for (pair in raw.split("&")) {
                val split = pair.indexOf('=')
                if (split <= 0) continue
                map.put(
                    URLDecoder.decode(pair.substring(0, split), StandardCharsets.UTF_8),
                    URLDecoder.decode(pair.substring(split + 1), StandardCharsets.UTF_8))
            }
            return map
        }

        private fun queryOf(pairs: Array<Array<String>>): String {
            val out = StringBuilder()
            for (pair in pairs) {
                if (out.length > 0) out.append('&')
                out.append(Uri.encode(pair[0])).append('=').append(Uri.encode(pair[1]))
            }
            return out.toString()
        }

        private fun base64url(bytes: ByteArray): String {
            return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        }

        private fun sha256(bytes: ByteArray): ByteArray {
            return try {
                MessageDigest.getInstance("SHA-256").digest(bytes)
            } catch (error: Exception) {
                throw IllegalStateException("SHA-256 is missing", error)
            }
        }

        private fun close(socket: Socket) {
            try {
                socket.close()
            } catch (ignored: IOException) {
                // 已经断了。
            }
        }
    }

    private val random = SecureRandom()
    private val http = OkHttpClient.Builder()
        .callTimeout(REQUEST_LIMIT_MS.toLong(), java.util.concurrent.TimeUnit.MILLISECONDS)
        .build()

    /** 一次只能有一次登录在等：回调地址只有一个。 */
    private var listening: ServerSocket? = null

    @PluginMethod
    fun status(call: PluginCall) {
        val result = JSObject()
        result.put("ready", true)
        call.resolve(result)
    }

    /**
     * 起一次登录并等到出结果。
     *
     * 答 `{ ok: true, session: { accessToken, refreshToken, expiresInMs } }`；
     * 没走通（取消 / 拒绝 / 超时 / 端口被占）是 `{ ok: false, error: { code, message } }`
     * —— **不是** reject：reject 到 JS 侧会被统一折成 `unavailable`，真正的原因就没了。
     */
    @PluginMethod
    fun signIn(call: PluginCall) {
        stopListening()

        val verifier = base64url(randomBytes(64))
        val state = base64url(randomBytes(16))
        val challenge = base64url(sha256(verifier.toByteArray(StandardCharsets.UTF_8)))

        val server: ServerSocket
        try {
            server = ServerSocket(PORT, 1, InetAddress.getByName("127.0.0.1"))
        } catch (error: IOException) {
            Log.w(TAG, "could not listen on " + PORT, error)
            // 'cannot-listen' 是桌面端对「端口没起来」用的那个词：界面上那句「端口被占用」
            // 的提示挂在它上面（spotifyProvider.auth.getLoginTexts 的 caseNotes）。
            call.resolve(failure("cannot-listen", "Spotify sign-in could not listen for the answer"))
            return
        } catch (error: SecurityException) {
            Log.w(TAG, "could not listen on " + PORT, error)
            // 'cannot-listen' 是桌面端对「端口没起来」用的那个词：界面上那句「端口被占用」
            // 的提示挂在它上面（spotifyProvider.auth.getLoginTexts 的 caseNotes）。
            call.resolve(failure("cannot-listen", "Spotify sign-in could not listen for the answer"))
            return
        }
        // 等满这一次登录的时间就自己退出，别让端口一直挂着。
        try {
            server.soTimeout = ATTEMPT_MS
        } catch (ignored: Exception) {
            // 设不上超时就等下去：下面的 cancel / destroy 仍然收得回来。
        }
        listening = server

        val page = AUTHORIZE_URL + "?" + queryOf(arrayOf(
            arrayOf("response_type", "code"),
            arrayOf("client_id", CLIENT_ID),
            arrayOf("redirect_uri", REDIRECT_URI),
            arrayOf("scope", SCOPES),
            arrayOf("code_challenge_method", "S256"),
            arrayOf("code_challenge", challenge),
            arrayOf("state", state)))

        call.setKeepAlive(true)
        val settled = AtomicBoolean(false)
        val kept = call

        val thread = Thread({
            try {
                while (!settled.get()) {
                    val socket: Socket
                    try {
                        socket = server.accept()
                    } catch (expired: SocketTimeoutException) {
                        if (settled.compareAndSet(false, true)) {
                            kept.resolve(failure("sign-in-failed", "The Spotify sign-in was not finished in time"))
                        }
                        return@Thread
                    } catch (closed: IOException) {
                        // stopListening() 关掉了端口（换了一次登录 / 组件销毁）：不是失败。
                        return@Thread
                    }
                    try {
                        handle(socket, state, verifier, kept, settled)
                    } catch (ignored: IOException) {
                        // 浏览器那边断了（用户切走了、连被重置）：继续等下一次。
                    } finally {
                        close(socket)
                    }
                }
            } finally {
                // 只关自己这一次开的那个端口（见 closeServer 的说明）。
                closeServer(server)
            }
        }, "folia-spotify-signin")
        thread.isDaemon = true
        thread.start()

        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(page))
            intent.addCategory(Intent.CATEGORY_BROWSABLE)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (error: ActivityNotFoundException) {
            Log.w(TAG, "no browser to open Spotify's page", error)
            if (settled.compareAndSet(false, true)) {
                // 'browser-unfinished'：桌面端对「浏览器那边没走完」用的那个词，caseNotes 有它。
                kept.resolve(failure("browser-unfinished", "No browser could be opened for the Spotify sign-in"))
            }
            return
        } catch (error: SecurityException) {
            Log.w(TAG, "no browser to open Spotify's page", error)
            if (settled.compareAndSet(false, true)) {
                // 'browser-unfinished'：桌面端对「浏览器那边没走完」用的那个词，caseNotes 有它。
                kept.resolve(failure("browser-unfinished", "No browser could be opened for the Spotify sign-in"))
            }
            return
        }
        Log.i(TAG, "sign-in is waiting on 127.0.0.1:" + PORT)
    }

    /** 用 refresh token 换一对新的。 */
    @PluginMethod
    fun refresh(call: PluginCall) {
        val refreshToken = call.getString("refreshToken")
        if (refreshToken == null || refreshToken.isEmpty()) {
            call.resolve(failure("auth-required", "Spotify refresh needs the token it gave before"))
            return
        }
        val fields = FormBody.Builder()
            .add("client_id", CLIENT_ID)
            .add("grant_type", "refresh_token")
            .add("refresh_token", refreshToken)
        call.setKeepAlive(true)
        requestTokens(fields, refreshToken, call)
    }

    /**
     * 浏览器回来的那一次请求。
     *
     * 任何人都可能在这个端口开着的时候敲一下（也包括请求行不是合法地址的情况），一律按
     * 「陌生人」答 404，绝不因为解析失败把这次登录判死。
     */
    @Throws(IOException::class)
    private fun handle(socket: Socket, state: String, verifier: String, call: PluginCall, settled: AtomicBoolean) {
        val reader = BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
        val requestLine = reader.readLine()
        // 请求头读到空行为止：不读完，浏览器会认为这一次响应不完整。
        var header: String? = reader.readLine()
        while (header != null && header.isNotEmpty()) { /* drained */
            header = reader.readLine()
        }
        if (requestLine == null || !requestLine.startsWith("GET ")) {
            write(socket, 404, "")
            return
        }
        val path = requestLine.split(" ".toRegex())[1]
        val split = path.indexOf('?')
        val pathname = if (split < 0) path else path.substring(0, split)
        if ("/login" != pathname) {
            write(socket, 404, "")
            return
        }
        val query = query(if (split < 0) "" else path.substring(split + 1))

        // state 对不上：多半是上一次登录留在某个标签页里的回答，跟当前这次无关。
        if (state != query["state"]) {
            write(socket, 200, pageOf(PAGE_FAILED))
            return
        }
        if (!settled.compareAndSet(false, true)) {
            write(socket, 404, "")
            return
        }
        val code = query["code"]
        if (code == null || code.isEmpty()) {
            val said = query["error"]
            val reason = if ("access_denied" == said) "access-denied"
                else if ("server_error" == said) "unreachable"
                else if ("temporarily_unavailable" == said) "asked-to-wait"
                else if (said != null) "refused" else "sign-in-failed"
            Log.w(TAG, "sign-in was not completed: " + reason)
            write(socket, 200, pageOf(if ("access-denied" == reason) PAGE_REFUSED else PAGE_FAILED))
            // 到这里 settled 已经由上面那次 CAS 拿下，直接结掉即可。
            call.resolve(failure(reason, "The Spotify sign-in was not completed"))
            return
        }
        write(socket, 200, pageOf(PAGE_DONE))
        requestTokens(FormBody.Builder()
            .add("client_id", CLIENT_ID)
            .add("grant_type", "authorization_code")
            .add("code", code)
            .add("redirect_uri", REDIRECT_URI)
            .add("code_verifier", verifier), null, call)
    }

    /** 换 token。两种情况共用：授权码换第一次，refresh token 换以后每一次。 */
    private fun requestTokens(fields: FormBody.Builder, keptRefreshToken: String?, call: PluginCall) {
        val request = Request.Builder()
            .url(TOKEN_URL)
            .post(fields.build())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .build()
        // enqueue 而不是 execute：等的那段时间必须把桥线程让出来。
        http.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(httpCall: okhttp3.Call, error: IOException) {
                Log.w(TAG, "the token request did not go through", error)
                call.resolve(failure("network", "Spotify could not be reached to issue a token"))
            }

            override fun onResponse(httpCall: okhttp3.Call, response: Response) {
                var body = ""
                try {
                    body = response.body?.string() ?: ""
                } catch (ignored: IOException) {
                    // 读不出来就按下面「没有 access_token」处理。
                } finally {
                    response.close()
                }
                val accessToken = field(body, "access_token")
                // 刷新时 Spotify 可以不给新的 refresh token（它仍然有效），那时留着旧的。
                var refreshToken = field(body, "refresh_token")
                if (refreshToken == null || refreshToken.isEmpty()) refreshToken = keptRefreshToken
                val error = field(body, "error")
                if (!response.isSuccessful || accessToken == null || refreshToken == null) {
                    // 授权本身被收回，或者过了 Spotify 给那半年：只能重新登录。
                    if ("invalid_grant" == error) {
                        call.resolve(failure("auth-required", "Spotify no longer accepts the sign-in"))
                        return
                    }
                    Log.w(TAG, "no token: HTTP " + response.code + " " + error)
                    call.resolve(failure("invalid-response", "Spotify did not issue a token"))
                    return
                }
                var seconds = 3600L
                try {
                    seconds = java.lang.Long.parseLong(field(body, "expires_in"))
                } catch (ignored: NumberFormatException) {
                    // 没给就按一小时算。
                } catch (ignored: NullPointerException) {
                    // 没给就按一小时算。
                }
                val session = JSObject()
                session.put("accessToken", accessToken)
                session.put("refreshToken", refreshToken)
                // 提前一分钟到期：宁可早续，也不要在取数的中途撞上过期。
                session.put("expiresInMs", Math.max(60L, seconds) * 1000)
                val result = JSObject()
                result.put("ok", true)
                result.put("session", session)
                call.resolve(result)
            }
        })
    }

    private fun write(socket: Socket, status: Int, html: String) {
        val body = html.toByteArray(StandardCharsets.UTF_8)
        val out: OutputStream = socket.getOutputStream()
        val head = (if (status == 200)
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
        else
            "HTTP/1.1 404 Not Found\r\n") +
            "Content-Length: " + body.size + "\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        out.write(head.toByteArray(StandardCharsets.UTF_8))
        if (body.size > 0) out.write(body)
        out.flush()
    }

    private fun randomBytes(size: Int): ByteArray {
        val bytes = ByteArray(size)
        random.nextBytes(bytes)
        return bytes
    }

    /**
     * 关掉这一次登录自己开的那个端口。
     *
     * 必须是「哪个端口归谁就关哪个」，不能写成「关掉当前那个」：换一次登录时，上一次那条
     * 收连接的线程是**被关端口这一下唤醒**的，它的 finally 才接着跑 —— 那时字段上已经是
     * 新开的端口了，一句 `listening.close()` 会把新的一次登录一起关掉（表现为第二次登录
     * 永远收不到回调）。所以这里只在字段仍指向自己时才把它清掉。
     */
    private fun closeServer(server: ServerSocket?) {
        if (server == null) return
        if (listening === server) listening = null
        try {
            server.close()
        } catch (ignored: IOException) {
            // 已经关了。
        }
    }

    private fun stopListening() {
        closeServer(listening)
    }

    /**
     * 组件销毁时必须把端口放掉，否则下一次登录会撞「端口已被占用」。
     *
     * 这里**不需要**在 onPause / onStop 里收：用户点了登录之后本来就要离开应用去浏览器，
     * 那时端口必须继续开着等回调 —— 收掉的后果就是「登录走完了，App 这边永远在转」。
     */
    override fun handleOnDestroy() {
        stopListening()
    }
}
