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

    /** 最多留多少条流；超了从头开始丢（见 pruneIfCrowded）。 */
    private const val MAX_ENTRIES = 24

    /** 一条要代理的流：一主多备。 */
    private class Entry(
        val urls: List<String>,
        val headers: Map<String, String>,
    )

    /*
     * 用 LinkedHashMap 记插入顺序，而不是随便一张 ConcurrentHashMap。
     *
     * ★ 这是「B 站视频整块黑屏」的根因。
     *
     * pruneIfCrowded 以前是 entries.keys.take(overflow) —— 在无序的 map 上，
     * 这取到的是**任意**几条，包括正在播的那一条。队列预取会一口气登记十几条流
     * （每个 bvid × 清晰度 × cid 各一条），很容易超过 24 条上限；一旦把播放中的
     * 那条挤掉，播放器再读就是 404，<video> 报 MEDIA_ERR_SRC_NOT_SUPPORTED，
     * 画面上什么都没有 —— 用户看到的就是「切到 MV 之后整个应用黑屏」。
     *
     * 换成 LinkedHashMap：最早的排在最前，淘汰从头开始，也就是真正的 LRU 顺序。
     */
    private val entries = java.util.Collections.synchronizedMap(LinkedHashMap<String, Entry>())
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
                /*
                 * backlog 给足一些。
                 *
                 * 原来只有 8：拖动进度条的那一刻，播放器会把手上几条连接全部掐掉重开，
                 * 外加预读那条，瞬间就能把队列占满 —— 满了之后新连接直接被内核回绝，
                 * 播放器侧看到的就是「播放出现错误」，而且这条流后面再也接不上。
                 */
                val socket = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
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
        pruneIfCrowded()
        return "http://127.0.0.1:$listening/stream/$token"
    }

    /** 丢一条流（换片时清理，别让表一直涨）。 */
    fun forget(url: String) {
        val token = url.substringAfterLast("/stream/", "")
        if (token.isNotEmpty()) entries.remove(token)
    }

    /**
     * 本机中转地址 → 它背后那条真实地址（主地址）。
     *
     * 缓存、分离、分析这几条路都要**直接**从 CDN 取字节：拿中转地址去下载，下到的
     * 可能是一条已经过期、或者中转已经忘掉的流（那是一段 404 文本），而且中转本身
     * 是给播放器流式读的，不是给一次性整份下载用的。
     *
     * 不是中转地址（或者那条流已经不在表里）就回 null，调用方照原样用。
     */
    fun directUrlFor(url: String): String? {
        val prefix = "http://127.0.0.1:"
        if (!url.startsWith(prefix)) return null
        val token = url.substringAfterLast("/stream/", "")
        if (token.isEmpty() || token == url) return null
        return entries[token]?.urls?.firstOrNull()
    }

    /**
     * 表长了就清一批。
     *
     * 一条流一个 token，切歌不清理的话这张表会一直涨（每次换画质都会重新登记一条）。
     * 表不大时什么都不做：正常的播放会一直命中同一条，频繁清理反而让正在放的流断掉。
     */
    /** 正在被读的流：淘汰时跳过它们（见 pruneIfCrowded）。 */
    private val busyStreams = ConcurrentHashMap.newKeySet<String>()

    private fun pruneIfCrowded() {
        var overflow = entries.size - MAX_ENTRIES
        if (overflow <= 0) return
        /*
         * 从最早登记的往后丢，但**跳过正在被读的那几条**。
         *
         * 「正在被读」= 已经有连接挂在上面的（busyStreams）。一条 MV 会连着读好几分钟，
         * 而队列预取在这几分钟里会不断登记新流 —— 只按顺序淘汰，早晚轮到现在这条。
         */
        val snapshot = synchronized(entries) { entries.keys.toList() }
        val doomed = ArrayList<String>(overflow)
        for (token in snapshot) {
            if (overflow <= 0) break
            if (busyStreams.contains(token)) continue
            doomed += token
            overflow -= 1
        }
        doomed.forEach { entries.remove(it) }
        if (doomed.isNotEmpty()) Log.i(TAG, "video proxy dropped ${doomed.size} old streams")
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
                val parts = requestLine.split(' ')
                val method = parts.getOrNull(0)?.uppercase() ?: "GET"
                val path = parts.getOrNull(1) ?: return
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
                /*
                 * 这次请求在读它期间，这条流不许被淘汰（见 pruneIfCrowded）。
                 * 挂在这里而不是 register 里：真正「在用」的时刻是有人来读，
                 * 登记只是在表里占个位。用完（finally）立刻放开。
                 */
                busyStreams.add(token)
                /*
                 * HEAD 只回头，不回体。
                 *
                 * `<video preload="metadata">` 一开始发的就是 HEAD：以前这里把它当 GET，
                 * 照样把整段字节吐出去 —— 播放器只读头就关连接，剩下的字节全成了
                 * 「连接被重置」，日志里一片 read ECONNRESET，而元数据还是没能拿到。
                 */
                if (method == "HEAD") {
                    serveHead(entry, range, output)
                    return
                }
                /*
                 * 按候选顺序试：一台回 403 就换下一台。
                 *
                 * `responded` 说的是「这条连接上已经出现过一个 HTTP 响应了」。它一旦为真，
                 * 就**不能再补任何一个响应** —— 补上去就是两个响应叠在一条连接上，播放器
                 * 读到的是脏数据（拖进度条时报「播放出现错误」、之后这条流不再出声）。
                 * 传输中途断掉时唯一正确的做法是把连接关掉，让播放器自己重开一条。
                 */
                var responded = false
                var served = false
                try {
                    for (url in entry.urls) {
                        if (served) break
                        try {
                            served = relay(url, entry.headers, range, output, onHead = { responded = true })
                        } catch (error: Exception) {
                            Log.w(TAG, "relay failed, trying the next address", error)
                            // 已经把响应头吐出去的那条路不能再换地址重来（同一个连接上没法重开一个响应）。
                            if (responded) return
                            served = false
                        }
                    }
                    if (!served && !responded) writeSimple(output, "502 Bad Gateway", "no address answered")
                } finally {
                    // 这一次读完了，这条流可以重新参与淘汰（见 pruneIfCrowded）。
                    busyStreams.remove(token)
                }
            }
        } catch (error: Exception) {
            // 播放器主动断开（拖进度条、切歌）也是这条路径：Debug 级别就够了，别刷屏。
            Log.d(TAG, "video proxy connection closed: ${error.message}")
        }
    }

    /**
     * HEAD：只回头，不带字节。
     *
     * `<video>` 拿元数据（时长、能不能按字节跳）走的就是它；回一个 JSON 或者一段
     * 文本会让播放器认为这条源不可用，于是画面一整块黑。
     */
    private fun serveHead(entry: Entry, range: String?, output: OutputStream) {
        // 按候选顺序试，第一个回头的就是答案。
        for (url in entry.urls) {
            val builder = Request.Builder().url(url).head()
            entry.headers.forEach { (name, value) -> builder.header(name, value) }
            if (range != null) builder.header("Range", range)
            try {
                client.newCall(builder.build()).execute().use { opened ->
                    if (opened.code == 403 || opened.code >= 500) return@use
                    if (!opened.isSuccessful && opened.code != 206) return@use
                    val head = StringBuilder()
                    head.append("HTTP/1.1 200 OK\r\n")
                    head.append("Content-Type: ")
                        .append(opened.header("Content-Type") ?: "video/mp4").append("\r\n")
                    head.append("Accept-Ranges: bytes\r\n")
                    opened.header("Content-Length")?.let {
                        head.append("Content-Length: ").append(it).append("\r\n")
                    }
                    head.append("Access-Control-Allow-Origin: *\r\n")
                    head.append("Connection: close\r\n\r\n")
                    output.write(head.toString().toByteArray())
                    output.flush()
                    return
                }
            } catch (error: Exception) {
                Log.w(TAG, "head relay failed, trying the next address", error)
            }
        }
        writeSimple(output, "502 Bad Gateway", "no address answered")
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
        onHead: () -> Unit = {},
    ): Boolean {
        val builder = Request.Builder().url(url)
        headers.forEach { (name, value) -> builder.header(name, value) }
        if (range != null) builder.header("Range", range)

        val response: Response = client.newCall(builder.build()).execute()
        response.use { opened ->
            /*
             * 这一个地址拒绝了就让调用方换下一个 —— 但**必须在写响应头之前**判定。
             *
             * 一旦下面那行 output.write(head) 跑过，这条连接上就已经有一个 HTTP 响应了；
             * 此时再失败、再让调用方补一个 502，等于把两个响应的字节首尾相接塞给播放器。
             * 播放器按第一个响应的 Content-Length 读完就关连接，多出来那段成了脏数据 ——
             * 表现正是「拖进度条时报播放出错」，而且这次之后这条流彻底不出声。
             */
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
            // 从这一刻起这条连接上已经有一个响应了，调用方不许再补。
            onHead()

            body.byteStream().use { source ->
                /*
                 * 中途断流（CDN 那头超时 / 用户拖走了）时这里会抛。
                 *
                 * 抛出去的语义是「这条流没读完」—— 由调用方区分：**已经吐过响应头**
                 * 的话就不能再补任何东西了，直接把连接关掉（`connection.use` 会关），
                 * 让播放器自己重开一条带新 Range 的连接。这里不吞异常，正是为了让
                 * 调用方知道这条连接不能再用了。
                 */
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
