package top.izuna.foliamajor

import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * 视频流的中转。
 *
 * 为什么要它：画面是 `<video>` 标签放的，它发请求时**带不上自定义头**，
 * 出了问题也没法换地址重试 —— 它只认「这个 URL 能不能读」。
 * 所以把地址交给这里，由原生带着它们该带的头去取，再把字节原样吐回去。
 *
 * 三件只有原生做得到的事：
 *  1. 补请求头（那一站的部分节点对 Referer/Origin 敏感）；
 *  2. **多地址容错**：同一条流通常给了一串备用地址，一台回了 403 就换下一台。
 *     这是让「有的视频放不出来」不再成为死路的关键；
 *  3. 把 Range 原样转发，播放器的拖动/续播才正常。
 *
 * 一条流一个 token，只在内存里；进程结束就没了 —— 这些地址本来也是短命的
 * （地址里带 deadline，几小时就过期）。
 */
object VideoStreamProxy {
    private const val TAG = "FoliaBilibili"

    /** 一条要代理的流：一主多备。 */
    private class Entry(
        val urls: List<String>,
        val headers: Map<String, String>,
    )

    private val entries = ConcurrentHashMap<String, Entry>()
    private var server: ServerSocket? = null
    private val started = AtomicBoolean(false)

    /** 中转自己的端口；没起来就是 0。 */
    @Volatile
    private var port: Int = 0

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            // 视频是一段一段读的，读超时要宽：中间停一会儿不该被判成断流。
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .build()
    }

    /** 起服务；已经起来就什么都不做。回端口号（失败回 0）。 */
    fun ensureStarted(): Int {
        if (started.get() && port > 0) return port
        synchronized(this) {
            if (started.get() && port > 0) return port
            try {
                val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
                server = socket
                port = socket.localPort
                started.set(true)
                val worker = Thread({ acceptLoop(socket) }, "folia-video-proxy")
                worker.isDaemon = true
                worker.start()
                Log.i(TAG, "video proxy listening on 127.0.0.1:$port")
                return port
            } catch (error: Exception) {
                Log.w(TAG, "video proxy could not listen", error)
                port = 0
                return 0
            }
        }
    }

    /**
     * 登记一条流，回一个本机可读的地址。
     *
     * `urls` 是同一个流的候选地址（主地址在前）；`headers` 是取它时要带的头。
     */
    fun register(urls: List<String>, headers: Map<String, String>): String? {
        val usable = urls.filter { it.isNotBlank() }
        if (usable.isEmpty()) return null
        val listening = ensureStarted()
        if (listening <= 0) return null
        val token = Integer.toHexString((usable[0] + System.nanoTime()).hashCode()) +
            System.nanoTime().toString(36)
        entries[token] = Entry(usable, headers)
        return "http://127.0.0.1:$listening/stream/$token"
    }

    /** 丢一条流（换片时清理，别让表一直涨）。 */
    fun forget(url: String) {
        val token = url.substringAfterLast("/stream/", "")
        if (token.isNotEmpty()) entries.remove(token)
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val connection = try {
                socket.accept()
            } catch (error: IOException) {
                // 关服务时 accept 会抛，正常退出。
                return
            }
            // 每条连接一颗线程：播放器会同时开好几条（拖动、预读）。
            val thread = Thread({ serveOne(connection) }, "folia-video-proxy-conn")
            thread.isDaemon = true
            thread.start()
        }
    }

    private fun serveOne(connection: Socket) {
        try {
            connection.use { socket ->
                val input = socket.getInputStream()
                val requestLine = readLine(input) ?: return
                // 第一行是 `GET /stream/<token> HTTP/1.1`。
                val path = requestLine.split(' ').getOrNull(1) ?: return
                var range: String? = null
                // 把请求头读完（不读干净，后面的写会被 TCP 缓冲搅乱）。
                while (true) {
                    val line = readLine(input) ?: break
                    if (line.isEmpty()) break
                    if (line.startsWith("Range:", ignoreCase = true)) {
                        range = line.substringAfter(':').trim()
                    }
                }

                val token = path.substringAfterLast('/')
                val entry = entries[token]
                val output = socket.getOutputStream()
                if (entry == null) {
                    writeSimple(output, "404 Not Found", "stream gone")
                    return
                }
                // 按候选顺序试：一台回 403 就换下一台。
                var served = false
                for (url in entry.urls) {
                    if (served) break
                    served = try {
                        relay(url, entry.headers, range, output)
                    } catch (error: Exception) {
                        Log.w(TAG, "relay failed, trying the next address", error)
                        false
                    }
                }
                if (!served) writeSimple(output, "502 Bad Gateway", "no address answered")
            }
        } catch (error: Exception) {
            Log.w(TAG, "video proxy connection failed", error)
        }
    }

    /**
     * 从一个候选地址取字节并吐给播放器。
     *
     * 回 true 表示这一个地址把活干完了（含 206 分段）；回 false 表示这个地址不行，
     * 调用方应该换下一个。
     */
    private fun relay(
        url: String,
        headers: Map<String, String>,
        range: String?,
        output: OutputStream,
    ): Boolean {
        val builder = Request.Builder().url(url)
        headers.forEach { (name, value) -> builder.header(name, value) }
        if (range != null) builder.header("Range", range)

        val response: Response = client.newCall(builder.build()).execute()
        response.use { opened ->
            // 这一个地址拒绝了，让调用方换下一个。
            if (opened.code == 403 || opened.code >= 500) return false
            if (!opened.isSuccessful && opened.code != 206) return false

            val body = opened.body ?: return false
            val length = body.contentLength()
            // 状态行：206 要带上 Content-Range，播放器据此判断能不能接上。
            val statusLine = if (opened.code == 206) "HTTP/1.1 206 Partial Content" else "HTTP/1.1 200 OK"
            val head = StringBuilder()
            head.append(statusLine).append("\r\n")
            head.append("Content-Type: ").append(opened.header("Content-Type") ?: "video/mp4").append("\r\n")
            head.append("Accept-Ranges: bytes\r\n")
            if (length >= 0) head.append("Content-Length: ").append(length).append("\r\n")
            opened.header("Content-Range")?.let { head.append("Content-Range: ").append(it).append("\r\n") }
            // 允许 WebView 从本机读：不写这个，跨源会被挡下。
            head.append("Access-Control-Allow-Origin: *\r\n")
            head.append("Connection: close\r\n\r\n")
            output.write(head.toString().toByteArray())
            output.flush()

            body.byteStream().use { source ->
                copyStream(source, output)
            }
            output.flush()
            return true
        }
    }

    private fun copyStream(source: InputStream, target: OutputStream) {
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = source.read(buffer)
            if (read <= 0) break
            target.write(buffer, 0, read)
            target.flush()
        }
    }

    private fun writeSimple(output: OutputStream, status: String, text: String) {
        val bytes = text.toByteArray()
        val head = "HTTP/1.1 $status\r\n" +
            "Content-Type: text/plain\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Connection: close\r\n\r\n"
        output.write(head.toByteArray())
        output.write(bytes)
        output.flush()
    }

    /** 读到 CRLF 为止的一行（HTTP 头是 ASCII，按字节拼就行）。 */
    private fun readLine(input: InputStream): String? {
        val buffer = StringBuilder()
        while (true) {
            val byte = input.read()
            if (byte < 0) return if (buffer.isEmpty()) null else buffer.toString()
            if (byte == '\n'.code) break
            if (byte != '\r'.code) buffer.append(byte.toChar())
            if (buffer.length > 8192) return null
        }
        return buffer.toString()
    }
}
