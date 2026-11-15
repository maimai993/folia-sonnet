package top.izuna.foliamajor

import android.util.Log

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.HashMap
import java.util.LinkedHashMap
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * 汽水加密音频的本地回环代理 —— electron/qishuiApiBridge.cjs 里 loopback 音频代理
 * 的安卓版。上游直链带 `#auth=spade_a` 的，<audio> 解不开：这里在 127.0.0.1 上
 * 起一个一次性服务器，按 `?u=<cleanUrl>&a=<auth>` 下载上游、交给
 * {@link QishuiAudioDecryptor} 解密后按 Range 切给播放器。
 *
 * 与桌面端的差异只有缓存实现：LinkedHashMap(accessOrder) LRU，语义一致
 * （96MB 上限，整曲驻内存）。只绑回环 + 随机 token 路径，别的本地程序读不到。
 */
class QishuiAudioServer {

    companion object {
        private const val TAG = "QishuiAudioServer"
        private const val AUDIO_ROUTE = "audio"
        private const val CACHE_MAX_BYTES = 96L * 1024 * 1024
        private const val USER_AGENT = "Folia/0.7.20 (Qishui audio proxy)"
        private val CDN_HOST_HINTS = arrayOf("qishui.com", "byteimg.com", "douyin", "bytedance")

        private fun refererFor(audioUrl: String): String {
            try {
                val host = java.net.URL(audioUrl).host.lowercase(Locale.US)
                for (hint in CDN_HOST_HINTS) {
                    if (host.contains(hint)) return "https://www.qishui.com/"
                }
            } catch (ignored: Exception) {
            }
            return "https://music.163.com/"
        }

        /** 与桌面 qishuiSendAudioBuffer 一致：整段驻内存后按 RFC 7233 切。 */
        private fun sendAudio(output: BufferedOutputStream, method: String, entry: Entry, range: String?) {
            val total = entry.buffer.size
            val matcher = java.util.regex.Pattern
                .compile("^bytes=(\\d*)-(\\d*)$", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(if (range == null) "" else range)
            if (matcher.matches()) {
                val startText = matcher.group(1) ?: ""
                val endText = matcher.group(2) ?: ""
                var start = if (startText.isEmpty()) 0L else startText.toLong()
                var end = if (endText.isEmpty()) total - 1L else endText.toLong()
                if (start < 0) start = 0L
                if (end >= total) end = total - 1L
                if (start > end || start >= total) {
                    writeHead(output, 416, "Range Not Satisfiable",
                        "Content-Range: bytes */" + total + "\r\nContent-Length: 0\r\nConnection: close\r\n")
                    return
                }
                writeHead(output, 206, "Partial Content",
                    audioHeaders(entry.contentType) +
                        "Content-Length: " + (end - start + 1) + "\r\n" +
                        "Content-Range: bytes " + start + "-" + end + "/" + total + "\r\n" +
                        "Connection: close\r\n")
                if ("HEAD".equals(method, ignoreCase = true)) return
                output.write(entry.buffer, start.toInt(), (end - start + 1).toInt())
                output.flush()
                return
            }
            writeHead(output, 200, "OK",
                audioHeaders(entry.contentType) +
                    "Content-Length: " + total + "\r\nConnection: close\r\n")
            if ("HEAD".equals(method, ignoreCase = true)) return
            output.write(entry.buffer)
            output.flush()
        }

        private fun audioHeaders(contentType: String?): String {
            return "Content-Type: " + (if (contentType == null) "audio/mp4" else contentType) + "\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Accept-Ranges: bytes\r\n"
        }

        private fun writeHead(output: BufferedOutputStream, status: Int, reason: String, headers: String) {
            output.write(("HTTP/1.1 " + status + " " + reason + "\r\n" + headers + "\r\n")
                .toByteArray(StandardCharsets.US_ASCII))
            output.flush()
        }

        private fun parseQuery(query: String): Map<String, String> {
            val params = HashMap<String, String>()
            for (pair in query.split("&")) {
                val eq = pair.indexOf('=')
                if (eq <= 0) continue
                try {
                    params.put(URLDecoder.decode(pair.substring(0, eq), "UTF-8"),
                        URLDecoder.decode(pair.substring(eq + 1), "UTF-8"))
                } catch (ignored: Exception) {
                }
            }
            return params
        }

        private fun readLine(input: BufferedInputStream): String? {
            val builder = StringBuilder()
            var value = input.read()
            while (value >= 0) {
                if (value == '\n'.code) {
                    if (builder.length > 0 && builder[builder.length - 1] == '\r') {
                        builder.setLength(builder.length - 1)
                    }
                    return builder.toString()
                }
                builder.append(value.toChar())
                value = input.read()
            }
            return if (builder.length == 0) null else builder.toString()
        }

        private fun randomToken(): String {
            val bytes = ByteArray(24)
            java.security.SecureRandom().nextBytes(bytes)
            val builder = StringBuilder()
            for (value in bytes) builder.append(String.format("%02x", value))
            return builder.toString()
        }
    }

    private val executor: ExecutorService = Executors.newCachedThreadPool()
    private val client = OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    private var serverSocket: ServerSocket? = null
    private var port = 0
    private val audioToken = randomToken()

    /** 解密结果缓存：key = sha1(cleanUrl + '\n' + auth)。 */
    private val cache = LinkedHashMap<String, Entry>(64, 0.75f, true)
    private var cacheBytes = 0L

    private class Entry(val buffer: ByteArray, val contentType: String)

    /** 起服务器（端口交给系统分配）；已在跑就直接返回。返回是否成功。 */
    @Synchronized
    fun start(): Boolean {
        val existing = serverSocket
        if (existing != null && !existing.isClosed) return true
        val socket: ServerSocket
        try {
            socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        } catch (error: IOException) {
            Log.w(TAG, "failed to bind the loopback audio proxy", error)
            serverSocket = null
            port = 0
            return false
        }
        serverSocket = socket
        port = socket.localPort
        executor.execute {
            while (!socket.isClosed) {
                try {
                    val accepted = socket.accept()
                    executor.execute { handle(accepted) }
                } catch (ignored: IOException) {
                    break
                }
            }
        }
        Log.i(TAG, "loopback audio proxy on 127.0.0.1:" + port)
        return true
    }

    @Synchronized
    fun isRunning(): Boolean {
        val socket = serverSocket
        return socket != null && !socket.isClosed && port > 0
    }

    @Synchronized
    fun stop() {
        val socket = serverSocket
        try {
            if (socket != null) socket.close()
        } catch (ignored: IOException) {
        }
        serverSocket = null
        port = 0
        synchronized(cache) {
            cache.clear()
            cacheBytes = 0
        }
    }

    /**
     * 给签名页面的协议层用：把带 #auth= 的直链改写成 loopback 地址。
     * 服务器没起来时返回空串，页面侧会原样返回直链（与桌面「无本地代理」一致）。
     */
    @Synchronized
    fun buildProxyUrl(cleanUrl: String?, auth: String?): String {
        if (!isRunning() || cleanUrl == null || cleanUrl.isEmpty()) return ""
        try {
            return "http://127.0.0.1:" + port + "/" + audioToken + "/" + AUDIO_ROUTE +
                "?u=" + URLEncoder.encode(cleanUrl, "UTF-8") +
                (if (auth == null || auth.isEmpty()) "" else "&a=" + URLEncoder.encode(auth, "UTF-8"))
        } catch (error: Exception) {
            return ""
        }
    }

    private fun handle(socket: Socket) {
        try {
            socket.use { client ->
                BufferedInputStream(client.getInputStream()).use { input ->
                    BufferedOutputStream(client.getOutputStream()).use { output ->
                        val requestLine = readLine(input)
                        if (requestLine == null) return
                        val parts = requestLine.split(" ")
                        if (parts.size < 2) return

                        var range: String? = null
                        var line = readLine(input)
                        while (line != null && !line.isEmpty()) {
                            val separator = line.indexOf(':')
                            if (separator > 0 && "range".equals(line.substring(0, separator).trim(), ignoreCase = true)) {
                                range = line.substring(separator + 1).trim()
                            }
                            line = readLine(input)
                        }

                        if ("OPTIONS".equals(parts[0], ignoreCase = true)) {
                            writeHead(output, 204, "No Content",
                                "Access-Control-Allow-Origin: *\r\n" +
                                    "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
                                    "Access-Control-Allow-Headers: range\r\n" +
                                    "Content-Length: 0\r\nConnection: close\r\n")
                            return
                        }
                        if (!"GET".equals(parts[0], ignoreCase = true) && !"HEAD".equals(parts[0], ignoreCase = true)) {
                            writeHead(output, 405, "Method Not Allowed", "Content-Length: 0\r\nConnection: close\r\n")
                            return
                        }

                        val query = parts[1]
                        val queryStart = query.indexOf('?')
                        if (queryStart < 0) {
                            writeHead(output, 404, "Not Found", "Content-Length: 0\r\nConnection: close\r\n")
                            return
                        }
                        val params = parseQuery(query.substring(queryStart + 1))
                        val cleanUrl = params.get("u")
                        val auth = params.get("a")
                        if (cleanUrl == null || cleanUrl.isEmpty()) {
                            writeHead(output, 400, "Bad Request", "Content-Length: 0\r\nConnection: close\r\n")
                            return
                        }
                        if (auth == null || auth.isEmpty()) {
                            // 未加密直链本来就不该走代理；真被请求就让播放器自己直连。
                            writeHead(output, 302, "Found", "Location: " + cleanUrl.replace("\r", "").replace("\n", "") +
                                "\r\nContent-Length: 0\r\nConnection: close\r\n")
                            return
                        }

                        val entry = getDecrypted(cleanUrl, auth)
                        if (entry == null) {
                            writeHead(output, 502, "Bad Gateway",
                                "Content-Type: text/plain\r\nContent-Length: 0\r\nConnection: close\r\n")
                            return
                        }
                        sendAudio(output, parts[0], entry, range)
                    }
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "audio proxy request failed", error)
        }
    }

    private fun getDecrypted(cleanUrl: String, auth: String): Entry? {
        val key: String
        try {
            key = QishuiAudioDecryptor.cacheKey(cleanUrl, auth)
        } catch (error: Exception) {
            return null
        }
        synchronized(cache) {
            val cached = cache.get(key)
            if (cached != null) return cached
        }
        val encrypted: ByteArray
        try {
            encrypted = fetchUpstream(cleanUrl)
        } catch (error: Exception) {
            Log.w(TAG, "qishui encrypted audio fetch failed: " + error.message)
            return null
        }
        if (encrypted == null || encrypted.size == 0) return null
        try {
            val result = QishuiAudioDecryptor.decrypt(encrypted, auth)
            val entry = Entry(result.buffer, if (result.flac) "audio/flac" else "audio/mp4")
            remember(key, entry)
            return entry
        } catch (error: Exception) {
            Log.w(TAG, "qishui audio decrypt failed", error)
            return null
        }
    }

    private fun fetchUpstream(cleanUrl: String): ByteArray {
        val builder = Request.Builder().url(cleanUrl)
        builder.header("User-Agent", USER_AGENT)
        builder.header("Referer", refererFor(cleanUrl))
        client.newCall(builder.build()).execute().use { response ->
            val responseBody = response.body
            if (!response.isSuccessful || responseBody == null) {
                throw IOException("HTTP " + response.code)
            }
            val stream: InputStream = responseBody.byteStream()
            val out = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            var read = stream.read(chunk)
            while (read >= 0) {
                out.write(chunk, 0, read)
                read = stream.read(chunk)
            }
            return out.toByteArray()
        }
    }

    private fun remember(key: String, entry: Entry) {
        synchronized(cache) {
            cache.put(key, entry)
            cacheBytes += entry.buffer.size
            while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
                val oldest = cache.keys.iterator().next()
                val evicted = cache.remove(oldest)!!
                cacheBytes -= evicted.buffer.size
            }
        }
    }
}
