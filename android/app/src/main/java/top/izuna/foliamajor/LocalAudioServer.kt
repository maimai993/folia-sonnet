package top.izuna.foliamajor
import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Log

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.ArrayList
import java.util.HashMap
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody

/**
 * 本地音频流服务器。
 *
 * 三种来源：
 *   /audio/<MediaStore id>          系统媒体库里的文件
 *   /audio/imported-<file name>     通过系统文件管理器挑选后复制进 App 私有目录的文件
 *   /video-layer/<anything>         歌词后方视频层那一个视频（VideoLayerFile 的私有副本）
 *
 * WebView 的 <audio> / <video> 播不了 content:// 这种 URI，也不认 App 私有目录里的路径，
 * 所以原生起一个小服务，把音频以 http 的形式喂回去。
 * 监听所有接口，但默认只让回环连接进来（见 handle() 里的 allowLanClients 收口）；
 * 投送到局域网音响时才临时放开 /remote-audio/ 一路。
 * 必须支持 Range：<audio> 拖进度、以及某些格式要先读文件尾部的元数据，都靠它。
 */
class LocalAudioServer(context: Context) {

    companion object {
        private const val TAG = "LocalAudioServer"

        /**
         * media-cache 目录的位置，由 [rememberMediaCacheDirectory] 记下。
         *
         * 播放器那边的坏缓存自愈入口是静态的（它没有 server 实例），但目录要 context
         * 才能算出来；server 一建目录就记下来，静态入口才定位得到。
         */
        @Volatile
        private var rememberedMediaCacheDirectory: File? = null

        /** server 建好缓存目录之后叫一声，静态入口（播放器那条路）才能定位到它。 */
        fun rememberMediaCacheDirectory(dir: File) {
            rememberedMediaCacheDirectory = dir
        }

        /**
         * 播放器说「这一条读不出来」时，把对应的那份缓存副本删掉。
         *
         * 为什么要这一手：缓存命中的判据过去只有「文件在不在」—— 一份写坏了的副本
         * （下到一半断了、来源本身是段错误页）会**永远**命中，于是永远播放错误：
         * 界面显示那一档，点了没声音，切分离又因为解码同一个坏源而立刻失败。
         * 用户看到的就是「播放错误 → 暂停 → 继续播放没声音」。
         *
         * 删掉之后下一次取源会回到网络，坏的那份不会自己长回来。
         *
         * ⚠️ 这是**静态**入口：调用它的是播放器那边（见 FoliaNativePlayer.onUnreadableSource），
         * 那里没有 server 实例。目录由 [rememberMediaCacheDirectory] 记着，没记过就
         * 什么都不做 —— 宁可让用户再点一次播放，也不要猜一个路径去删文件。
         *
         * @param url 播放器装的那条地址（`/media-cache/<名字>` 或原样回环地址）
         * @return 是否真的删掉了什么
         */
        fun dropBrokenMediaCacheFor(url: String?): Boolean =
            dropBrokenMediaCache(url, rememberedMediaCacheDirectory)

        /**
         * 按地址删掉一份读不出来的媒体缓存副本（见实例方法 [dropBrokenMediaCacheFor]）。
         *
         * 目录为 null 时什么都不做：宁可让用户再点一次播放，也不要猜一个路径去删文件。
         */
        private fun dropBrokenMediaCache(url: String?, dir: File?): Boolean {
            if (url == null || url.isEmpty() || dir == null) return false
            val marker = url.indexOf(MEDIA_CACHE_PATH_PREFIX)
            if (marker < 0) return false
            val rest = url.substring(marker + MEDIA_CACHE_PATH_PREFIX.length)
            // 地址里可能带 query（`?stored=...`）：名字到 ? 或 # 为止。
            val cut = rest.indexOfFirst { it == '?' || it == '#' }
            val rawName = if (cut >= 0) rest.substring(0, cut) else rest
            if (rawName.isEmpty()) return false
            val fileName = try {
                java.net.URLDecoder.decode(rawName, "UTF-8")
            } catch (_: Throwable) {
                rawName
            }
            if (!isMediaCacheNameAllowed(fileName)) return false
            val target = resolveMediaCacheFile(dir, fileName) ?: return false
            val size = target.length()
            val removed = target.delete()
            if (removed) {
                // 计数 sidecar 跟着走：留着的话同一 key 下次写进来会继承旧计数。
                File(target.parentFile, target.name + ".cnt").delete()
                Log.w(TAG, "dropped unreadable media cache: " + target.name + " (" + size + "B)")
            }
            return removed
        }

        /**
         * 这个名字算不算「那份缓存副本」本身（而不是挂在旁边的 sidecar 或残骸）。
         *
         * 副本命名是 `<key>.<扩展名>`，而命中计数（`.cnt`）与写入中的临时文件（`.part`）
         * 也是同一个前缀。按前缀找副本时必须跳过这两类 —— 否则会把一个 1 字节的计数
         * 文件当成音频发出去（播放器报「认不出格式」），或者把该删的坏副本换成它。
         */
        internal fun isMediaCachePayloadName(name: String): Boolean {
            if (name.endsWith(".cnt")) return false
            if (name.endsWith(".part")) return false
            return true
        }

        /** 与实例上的 `mediaCacheFile` 同一套规则，但目录由调用方给。 */
        private fun resolveMediaCacheFile(dir: File, fileName: String): File? {
            if (!isMediaCacheNameAllowed(fileName)) return null
            val direct = File(dir, fileName)
            if (direct.isFile) return direct
            if (fileName.indexOf('.') >= 0) return null
            val files = dir.listFiles() ?: return null
            for (file in files) {
                if (!file.isFile) continue
                if (!file.name.startsWith(fileName + ".")) continue
                if (!isMediaCachePayloadName(file.name)) continue
                return file
            }
            return null
        }

        /**
         * 手机在局域网里的 IPv4 地址。投送时音响要反过来连手机上的转发服务，
         * 127.0.0.1 对它是「自己」，必须换成这个地址。拿不到就返回 null，
         * 前端会退回「只推公网地址」的路径并给出提示。
         */
        fun lanIpv4(): String? {
            try {
                val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
                if (interfaces != null) {
                    for (candidate in interfaces) {
                        if (!candidate.isUp || candidate.isLoopback) continue
                        for (address in candidate.inetAddresses) {
                            if (address is java.net.Inet4Address && !address.isLoopbackAddress && address.isSiteLocalAddress) {
                                return address.hostAddress
                            }
                        }
                    }
                }
            } catch (error: Exception) {
                Log.w(TAG, "lan ipv4 lookup failed", error)
            }
            return null
        }
        private const val AUDIO_PATH_PREFIX = "/audio/"
        private const val REMOTE_AUDIO_PATH_PREFIX = "/remote-audio/"
        private const val VIDEO_LAYER_PATH_PREFIX = "/video-layer/"
        /*
         * 媒体缓存（在线歌的本地副本）存放的那一路。
         *
         * 以前这些字节躺在 WebView 的 IndexedDB 里，取出来只能变成 blob: 地址，而原生播放器
         * 吃不下 blob: —— 于是「有缓存的歌」恰恰是原生播放接管的那些，反而整首回落到 <audio>。
         * 现在副本写进 App 私有目录，播放时拿回环地址，ExoPlayer 和 <audio> 都能读。
         */
        private const val MEDIA_CACHE_PATH_PREFIX = "/media-cache/"
        private const val IMPORTED_PREFIX = "imported-"
        /**
         * 新格式导入副本的前缀：`local-<id>`。
         *
         * 不能直接用裸数字：MediaStore 那一路的 ref 就是纯数字媒体 id，两边会撞。
         */
        private const val LOCAL_IMPORTED_PREFIX = "local-"
        /** 直接按绝对路径流原文件的 ref 前缀（文件系统兜底扫描出来的歌，不复制进私有目录）。 */
        private const val FILE_PREFIX = "file-"
        /*
         * 只能代哪些主机的远端音频。
         *
         * 这个服务同网段也能连（投送时），放行任意 URL 就等于开了一个「任读全网」的口子，
         * 所以按主机白名单收口。目前只有 Kuwo（波点）需要它：
         * 它的 CDN 不下发 CORS 头，而 <audio> 带 crossOrigin="anonymous"，
         * 于是播放被同源策略挡掉（表现是 MEDIA_ELEMENT_ERROR: Format error）。
         */
        private val REMOTE_AUDIO_HOST_SUFFIXES = arrayOf("kuwo.cn", "music.126.net")
        private const val REMOTE_AUDIO_USER_AGENT =
            "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36"
        private const val REMOTE_AUDIO_REFERER = "https://www.kuwo.cn/"
        private const val NETEASE_REMOTE_AUDIO_REFERER = "https://music.163.com/"

        /** 裁剪最多这么久做一次。清兄弟文件不受这个限制 —— 那个必须当场清。 */
        private const val PRUNE_INTERVAL_MS = 30_000L

        /** 有些 CDN 看 Referer 决定给不给资源：不带时回的是一段 HTML 而不是音频。 */
        private fun remoteAudioReferer(value: String): String {
            return try {
                val host = URL(value).host
                if (host != null && (host == "music.126.net" || host.endsWith(".music.126.net"))) {
                    NETEASE_REMOTE_AUDIO_REFERER
                } else {
                    REMOTE_AUDIO_REFERER
                }
            } catch (ignored: Exception) {
                REMOTE_AUDIO_REFERER
            }
        }

        private fun isRemoteAudioHostAllowed(host: String): Boolean {
            if (host.isEmpty()) return false
            for (suffix in REMOTE_AUDIO_HOST_SUFFIXES) {
                if (host == suffix || host.endsWith(".$suffix")) return true
            }
            return false
        }

        /**
         * 缓存副本的文件名长什么样：`<key 的 base64url>.<扩展名>`。
         *
         * key 里可能有歌名（中文、空格、斜杠），所以不能直接拿它拼路径 —— Web 侧先编码成
         * base64url，这里再用白名单收口，路径穿越（`/`、`..`）在拼路径之前就被挡掉。
         */
        private fun isMediaCacheNameAllowed(name: String?): Boolean {
            if (name == null || name.isEmpty() || name.length > 220) return false
            if (name.contains("/") || name.contains("\\") || name.contains("..")) return false
            if (name.startsWith(".")) return false
            for (i in name.indices) {
                val c = name[i]
                val ok = (c in 'a'..'z') || (c in 'A'..'Z') || (c in '0'..'9')
                    || c == '-' || c == '_' || c == '.'
                if (!ok) return false
            }
            return true
        }

        /** 按 Content-Type 决定扩展名，只为让 writeResponse 能给出像样的 Content-Type。 */
        private fun extensionForMime(mime: String?): String {
            val lower = if (mime == null) "" else mime.lowercase(Locale.ROOT)
            if (lower.contains("flac")) return "flac"
            if (lower.contains("mp4") || lower.contains("m4a") || lower.contains("aac")) return "m4a"
            if (lower.contains("wav")) return "wav"
            if (lower.contains("ogg") || lower.contains("opus")) return "ogg"
            if (lower.contains("ape")) return "ape"
            if (lower.contains("wma")) return "wma"
            return "mp3"
        }

        /** 与 Web 侧 `cacheFileName` 一致：base64url 无 padding；超长退化为 `h<fnv1a>`。 */
        private fun mediaCacheFileNameOf(cacheKey: String?): String? {
            if (cacheKey == null || cacheKey.isEmpty()) return null
            val bytes = cacheKey.toByteArray(StandardCharsets.UTF_8)
            val encoded = android.util.Base64.encodeToString(bytes,
                    android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP).replace("=", "")
            return if (encoded.length <= 200) encoded else "h" + fnv1a36(cacheKey).toString(36)
        }

        /** Web 侧 fnv1a 的 Java 版：无符号 32 位，按 UTF-16 码元逐个喂（charCodeAt 语义）。 */
        private fun fnv1a36(value: String): Long {
            var hash = 0x811c9dc5.toInt()
            for (i in value.indices) {
                hash = hash xor value[i].code
                hash *= 0x01000193
            }
            return hash.toLong() and 0xFFFFFFFFL
        }

        /** 文件里第一条音频轨的时长（微秒）；探不出回 -1（那就放行，交 Web 侧的校验兜底）。 */
        private fun probeMediaDuration(file: File): Long {
            val extractor = android.media.MediaExtractor()
            try {
                extractor.setDataSource(file.absolutePath)
                for (i in 0 until extractor.trackCount) {
                    val format = extractor.getTrackFormat(i)
                    val mime = format.getString(android.media.MediaFormat.KEY_MIME)
                    if (mime != null && mime.startsWith("audio/")
                            && format.containsKey(android.media.MediaFormat.KEY_DURATION)) {
                        return format.getLong(android.media.MediaFormat.KEY_DURATION)
                    }
                }
                return -1L
            } catch (error: Throwable) {
                return -1L
            } finally {
                extractor.release()
            }
        }

        private fun parseLongOr(raw: String?, fallback: Long): Long {
            if (raw == null) return fallback
            return try {
                raw.trim().toLong()
            } catch (ignored: NumberFormatException) {
                fallback
            }
        }

        /** 从 `a=1&b=2` 里取一个数；没有或不是数就给 fallback。 */
        private fun queryParam(queryString: String?, key: String, fallback: Long): Long {
            if (queryString == null || queryString.isEmpty()) return fallback
            for (pair in queryString.split("&")) {
                val at = pair.indexOf('=')
                if (at <= 0 || key != pair.substring(0, at)) continue
                return parseLongOr(pair.substring(at + 1), fallback)
            }
            return fallback
        }

        /**
         * InputStream.skip 不保证一次跳够（它爱跳多少跳多少），文件流上偶尔也会短跳。
         * 之前直接一个 skip 了事，短跳时从错误的位置开始发 —— 解码器读到的就是一段
         * 被错位的数据，表现正是「MEDIA_ELEMENT_ERROR: Format error」这类莫名失败。
         */
        private fun skipFully(audio: InputStream, bytes: Long) {
            var remaining = bytes
            while (remaining > 0) {
                var skipped = audio.skip(remaining)
                if (skipped <= 0) {
                    // skip 返回 0 只能靠读来推进（可能已经到头）。
                    if (audio.read() == -1) return
                    skipped = 1
                }
                remaining -= skipped
            }
        }

        /** 路径是不是设备上常见的音频扩展名（文件系统兜底扫描与 file- 路由共用）。 */
        @JvmStatic
        fun isAudioFileName(fileName: String?): Boolean {
            val lower = if (fileName == null) "" else fileName.lowercase()
            return lower.endsWith(".mp3") || lower.endsWith(".flac") || lower.endsWith(".wav")
                || lower.endsWith(".m4a") || lower.endsWith(".aac") || lower.endsWith(".ogg")
                || lower.endsWith(".opus") || lower.endsWith(".ape") || lower.endsWith(".wma")
        }

        @JvmStatic
        fun guessMimeType(fileName: String?): String {
            val lower = if (fileName == null) "" else fileName.lowercase()
            if (lower.endsWith(".flac")) return "audio/flac"
            if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4"
            if (lower.endsWith(".wav")) return "audio/wav"
            if (lower.endsWith(".ogg") || lower.endsWith(".oga")) return "audio/ogg"
            if (lower.endsWith(".opus")) return "audio/opus"
            if (lower.endsWith(".aac")) return "audio/aac"
            if (lower.endsWith(".ape")) return "audio/ape"
            if (lower.endsWith(".wma")) return "audio/x-ms-wma"
            return "audio/mpeg"
        }

        private fun readLine(input: InputStream): String? {
            val line = StringBuilder()
            var value: Int
            while (input.read().also { value = it } != -1) {
                if (value == '\n'.code) break
                if (value != '\r'.code) line.append(value.toChar())
            }
            return if (value == -1 && line.length == 0) null else line.toString()
        }

        /**
         * 错误响应也一定要带 CORS 头。
         *
         * <audio> 带 crossOrigin="anonymous"，响应缺 Access-Control-Allow-Origin 时，
         * 浏览器把「CORS 被拒」和「文件不存在 / 空文件」报成一模一样的东西：
         * networkState=3、mediaErrorCode=4（MEDIA_ERR_SRC_NOT_SUPPORTED）——
         * 也就是那句毫无特征的 MEDIA_ELEMENT_ERROR: Format error。
         * 带上 ACAO 之后，上层用 fetch 探一次就能读到真实的 404/502，不用再猜。
         */
        private fun writeStatus(output: OutputStream, status: Int, message: String) {
            val response = "HTTP/1.1 $status $message\r\n" +
                "Content-Type: text/plain\r\n" +
                "Content-Length: 0\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Headers: range, content-range, content-length\r\n" +
                "Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n" +
                "Connection: close\r\n\r\n"
            output.write(response.toByteArray(StandardCharsets.US_ASCII))
            output.flush()
        }
    }

    private val context: Context = context.applicationContext
    private val executor: ExecutorService = Executors.newCachedThreadPool()
    private val remoteAudioClient: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        // OkHttp 默认 10s 读超时：音源/CDN 限速时两次数据间隔很容易超过它，
        // 一超时流就被掐断，WebView 看到的是「歌播到一半没了」。流式转发要用长读超时。
        .connectTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .build()
    /** 凭据类资源不放行重定向：跟着跳转走会把请求头里的凭据带往别的主机。 */
    private val credentialResourceClient: OkHttpClient = remoteAudioClient.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    private val remoteAudioRegistry = RemoteAudioRegistry()
    private var serverSocket: ServerSocket? = null
    private var _port = 0

    /**
     * 投送期间的局域网音频租约（见 LanCastLeaseRegistry）。
     *
     * 过去这里是一个全局布尔 `allowLanClients`：打开之后，同网段任何设备拿到或猜到
     * `/remote-audio/<token>` 就能匿名拉走正在投送的音频，而且只有 Web 层一处调用能关。
     * 现在换成带截止时间的一次性租约：局域网连接除了要「本次会话签发的 token」，
     * 还要过来源校验（见 handle()），租约到期或收回即失效。
     *
     * 本地文件 / 媒体缓存 / 导入音频这几路**永远**不对局域网开放。
     */
    private val lanCastLeases = LanCastLeaseRegistry()

    /** 是否处于投送期（局域网音频通道已打开）。 */
    fun isLanCastActive(): Boolean = lanCastLeases.current() != null

    /** 本次投送签发的凭证；没开投送时返回 null。 */
    fun currentLanCastLease(): LanCastLeaseRegistry.Lease? = lanCastLeases.current()

    /**
     * 打开（或续期）投送租约，返回本次的凭证。
     *
     * 幂等：投送期间反复调用不换凭证，只顺延截止时间 —— 切歌 / 换音响都会再 prepare 一次，
     * 每次都签新的会让音响手上那份立刻失效。
     */
    fun openLanCastLease(): LanCastLeaseRegistry.Lease {
        val lease = lanCastLeases.ensure()
        Log.i(TAG, "lan cast lease opened, expires in " + ((lease.expiresAtMillis - System.currentTimeMillis()) / 1000) + "s")
        return lease
    }

    /** 收回投送租约：局域网设备重新连不进来，本机回环播放不受影响。 */
    fun releaseLanCastLeases() {
        if (lanCastLeases.current() == null) {
            lanCastLeases.release()
            return
        }
        lanCastLeases.release()
        Log.i(TAG, "lan cast lease released")
    }

    @Synchronized
    @Throws(IOException::class)
    fun start(): Int {
        val socket = serverSocket
        if (socket != null && !socket.isClosed) return _port
        // 端口交给系统分配（0）：写死一个的话，被别的进程占了就起不来，
        // 而每次启动拿到的端口都可能不同，所以 URL 不能持久化，播放前要重新拼（见插件的 localAudioServerPort）。
        // 投送需要音响能连进来，所以监听所有接口；安全由 handle() 里的 allowLanClients 收口，
        // 不投送时对外部连接和以前只绑 127.0.0.1 等价。
        val server = ServerSocket(0, 50)
        serverSocket = server
        _port = server.localPort
        executor.execute {
            while (!serverSocket!!.isClosed) {
                try {
                    val socket = serverSocket!!.accept()
                    executor.execute { handle(socket) }
                } catch (ignored: IOException) {
                    Log.i(TAG, "server socket closed, stopping accept loop")
                    break
                }
            }
        }
        return _port
    }

    fun getPort(): Int {
        return _port
    }

    /**
     * 把一个远端音频地址挂到本地服务上，返回 `http://127.0.0.1:<_port>/remote-audio/<token>`。
     *
     * 为什么要绕这一圈：<audio> 带 crossOrigin="anonymous"，而 Kuwo（波点）的 CDN
     * 根本不下发 Access-Control-Allow-Origin —— 请求连字节都拿不到，报出来却是
     * 一句毫无特征的 "MEDIA_ELEMENT_ERROR: Format error" / "The element has no supported sources"。
     * 本地服务回包带 ACAO: *，同源检查就过了；Range 也照样转发，拖进度条不受影响。
     */
    @Synchronized
    @Throws(IOException::class)
    fun registerRemoteAudio(value: String): String {
        return registerRemoteAudio(value, null, false)
    }

    /**
     * 同 {@link #registerRemoteAudio(String)}，但多两个开关：转发时要附带的请求头，以及"允许任意主机"。
     *
     * 为什么要它们：飞牛（FNOS）这类自建服务的音频流只认 `Cookie: music-token=...`，
     * 而 <audio> 加不了任何请求头；它的地址又是用户在登录时自己填的局域网地址，
     * 不可能出现在 {@link #REMOTE_AUDIO_HOST_SUFFIXES} 那份白名单里。
     * 两个开关都由调用方显式打开，白名单那一路（Kuwo / 网易）行为不变。
     */
    @Synchronized
    @Throws(IOException::class)
    fun registerRemoteAudio(value: String, headers: Map<String, String>?, allowAnyHost: Boolean): String {
        return registerRemoteAudio(value, headers, allowAnyHost, true)
    }

    private fun registerRemoteAudio(
        value: String,
        headers: Map<String, String>?,
        allowAnyHost: Boolean,
        reusable: Boolean
    ): String {
        val url = URL(value)
        val host = url.host?.lowercase(Locale.ROOT) ?: ""
        if (!("http" == url.protocol || "https" == url.protocol)
            || !(allowAnyHost || isRemoteAudioHostAllowed(host))) {
            throw IOException("Unsupported remote audio host")
        }
        val localPort = start()
        val token = if (reusable) remoteAudioRegistry.registerReusable(value, headers)
        else remoteAudioRegistry.register(value, headers)
        return "http://127.0.0.1:" + localPort + REMOTE_AUDIO_PATH_PREFIX + token
    }

    /**
     * 带凭据的资源：地址必须落在 `credentialOrigin` 这个 origin 上，
     * 且每次注册都换一个 token（不复用、token 里也不含 URL）。
     */
    @Synchronized
    @Throws(IOException::class)
    fun registerScopedRemoteAudio(value: String, headers: Map<String, String>?, origin: String): String {
        RemoteAudioRegistry.validateOrigin(value, origin)
        return registerRemoteAudio(value, headers, true, false)
    }

    @Synchronized
    @Throws(IOException::class)
    fun unregisterRemoteAudio(value: String) {
        val url = URL(value)
        if (!("http" == url.protocol) || !("127.0.0.1" == url.host)
            || url.port != _port || !url.path.startsWith(REMOTE_AUDIO_PATH_PREFIX)) return
        remoteAudioRegistry.remove(url.path.substring(REMOTE_AUDIO_PATH_PREFIX.length))
    }

    /** 复制进私有目录的音频存放位置。 */
    fun importedAudioDirectory(): File {
        val dir = File(context.filesDir, "imported-audio")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    /** 媒体缓存副本存放位置（在线歌的字节，见 MEDIA_CACHE_PATH_PREFIX）。 */
    fun mediaCacheDirectory(): File {
        val dir = File(context.filesDir, "media-cache")
        if (!dir.exists()) dir.mkdirs()
        // 记给静态侧：播放器发现一条源读不出来时，要按地址删掉对应的那份副本。
        rememberMediaCacheDirectory(dir)
        return dir
    }

    /** `{总字节数, 份数}`。设置页的「媒体缓存」那一栏读它 —— 字节搬出 IndexedDB 之后，
     *  那边按数据库算出来的占用会恒为 0，看起来像「缓存没了」。 */
    @Synchronized
    fun mediaCacheStats(): LongArray {
        val files = mediaCacheDirectory().listFiles()
        var size: Long = 0
        var count: Long = 0
        if (files != null) {
            for (file in files) {
                if (!file.isFile || file.name.endsWith(".part")) continue
                // 命中计数 sidecar 不是缓存内容：不算大小也不算份数，不然设置页里
                // 「已缓存歌曲 32 份」会数出一堆看不见的计数文件。
                if (file.name.endsWith(".cnt")) continue
                size += file.length()
                count += 1
            }
        }
        return longArrayOf(size, count)
    }

    /** 清空整个媒体缓存目录（设置页的「清除媒体缓存」）。 */
    @Synchronized
    fun clearMediaCache() {
        val files = mediaCacheDirectory().listFiles()
        if (files == null) return
        for (file in files) {
            if (file.isFile) file.delete()
        }
    }

    /**
     * 局域网来源的准入：来源 + 租约 + 本次签发的 token，三者缺一不可。
     *
     * 为什么要来源校验：光有 token 还不够。响应带 `Access-Control-Allow-Origin: *`
     * 且接口无凭据时代，用户在浏览器里打开的任意页面都能直接 fetch 这条 URL 拿到字节。
     * 这里要求来源地址是局域网私有段（伪造的 SSDP 应答、公网扫描、组播转发都排除），
     * 并且拒绝带 `Origin` 头的请求 —— 浏览器跨源读流一定带 Origin，音响直接 GET 不带。
     */
    private fun admitsLanRequest(remoteHost: String?, headers: Map<String, String>, token: String?): Boolean {
        if (token == null) return false
        if (!isLanClientAddress(remoteHost)) {
            Log.w(TAG, "lan cast request from non-LAN client: " + remoteHost)
            return false
        }
        // 浏览器跨源请求一定带 Origin（同源 iframe 除外，那也已经不是「任意网页」）；
        // 音响的 DLNA 客户端直接 GET，不发 Origin。
        if (headers.containsKey("origin") || headers.containsKey("sec-fetch-mode")) {
            Log.w(TAG, "lan cast request with browser origin header")
            return false
        }
        if (!lanCastLeases.admitsLanToken(token)) {
            Log.w(TAG, "lan cast request with a token outside the current lease")
            return false
        }
        return true
    }

    /** 来源是不是局域网单播地址：与本机同段，或至少在一个私有段里。 */
    private fun isLanClientAddress(host: String?): Boolean {
        if (host.isNullOrEmpty()) return false
        val address = try {
            java.net.InetAddress.getByName(host)
        } catch (error: Exception) {
            return false
        }
        if (address.isAnyLocalAddress || address.isMulticastAddress || address.isLoopbackAddress) return false
        if (address is java.net.Inet4Address) {
            val b = address.address
            val first = b[0].toInt() and 0xFF
            val second = b[1].toInt() and 0xFF
            if (first == 10) return true
            if (first == 172 && second in 16..31) return true
            if (first == 192 && second == 168) return true
            return false
        }
        if (address is java.net.Inet6Address) {
            // 只认唯一本地地址 fc00::/7 与链路本地 fe80::/10。
            val b = address.address
            return (b[0].toInt() and 0xFE) == 0xFC || (b[0].toInt() == 0xFE.toByte().toInt() && (b[1].toInt() and 0xC0) == 0x80)
        }
        return false
    }

    private fun handle(socket: Socket) {        try {
            socket.use { client ->
                BufferedInputStream(client.getInputStream()).use { input ->
                    BufferedOutputStream(client.getOutputStream()).use { output ->
                        val requestLine = readLine(input)
                        if (requestLine == null) return
                        val requestParts = requestLine.split(" ").toTypedArray()
                        if (requestParts.size < 2) return

                        val headers = HashMap<String, String>()
                        var line = readLine(input)
                        while (line != null && !line.isEmpty()) {
                            val separator = line.indexOf(':')
                            if (separator > 0) {
                                headers[line.substring(0, separator).trim().lowercase()] =
                                    line.substring(separator + 1).trim()
                            }
                            line = readLine(input)
                        }

                        val rawPath = requestParts[1]
                        val queryAt = rawPath.indexOf('?')
                        val queryString = if (queryAt >= 0) rawPath.substring(queryAt + 1) else ""
                        val path = if (queryAt >= 0) rawPath.substring(0, queryAt) else rawPath
                        /*
                         * 投送时的对外边界，三层同时成立才放行（见 LanCastLeaseRegistry）：
                         *  1. 正在投送（租约未过期、未收回）—— 收回之后同网段第二台设备
                         *     访问旧 URL 只会拿到 403；
                         *  2. 只认 `/remote-audio/` 且只认**本次租约签发的**那一个 token ——
                         *     其它会话注册的 token（哪怕猜对了路径）一律不认；
                         *  3. 来源必须是局域网单播地址：拒绝任意公网来源、组播、以及
                         *     伪造 Referer 的网页 —— 这条把「局域网设备」和「用户浏览器里
                         *     打开的任意页面」分开。
                         * 本地曲库、媒体缓存、导入文件这几路永远拒绝，免得为了投一首歌
                         * 把整个手机曲库暴露到同一个 WiFi 上。
                         */
                        if (!client.inetAddress.isLoopbackAddress) {
                            val lanToken = if (path.startsWith(REMOTE_AUDIO_PATH_PREFIX)) {
                                path.substring(REMOTE_AUDIO_PATH_PREFIX.length)
                            } else null
                            if (!admitsLanRequest(client.inetAddress.hostAddress, headers, lanToken)
                                || requestParts[0] == "OPTIONS") {
                                Log.w(TAG, "rejected lan cast request: " + path + " from " + client.inetAddress.hostAddress)
                                val denied = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                output.write(denied.toByteArray(StandardCharsets.US_ASCII))
                                output.flush()
                                return
                            }
                        }
                        /*
                         * 预检（OPTIONS）必须自己答。
                         *
                         * 跨源请求只要带了 Range 之外的头、或者某些 WebView 版本对 Range 也走预检，
                         * 浏览器就会先发一个 OPTIONS —— 服务不答就是 CORS 失败，
                         * 而失败的表现和「文件不存在」一模一样（mediaErrorCode=4）。
                         * 答一个 204 并放行 Range，探测和播放两条路都才走得通。
                         *
                         * 注意只有回环连接会走到这里：局域网那一路在准入处就把 OPTIONS 挡了
                         * （见 admitsLanRequest），音响直接 GET 播放，不需要 CORS。
                         */
                        if ("OPTIONS" == requestParts[0]) {
                            val response = "HTTP/1.1 204 No Content\r\n" +
                                "Access-Control-Allow-Origin: *\r\n" +
                                "Access-Control-Allow-Methods: GET, HEAD, PUT, DELETE, OPTIONS\r\n" +
                                "Access-Control-Allow-Headers: range, content-range, content-length, content-type\r\n" +
                                "Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n" +
                                "Access-Control-Max-Age: 86400\r\n" +
                                "Content-Length: 0\r\nConnection: close\r\n\r\n"
                            output.write(response.toByteArray(StandardCharsets.US_ASCII))
                            output.flush()
                            return
                        }
                        if (path.startsWith(REMOTE_AUDIO_PATH_PREFIX)) {
                            streamRemoteAudio(
                                output,
                                requestParts,
                                headers,
                                path.substring(REMOTE_AUDIO_PATH_PREFIX.length),
                                // 只有本机回环连接才需要 CORS 头（见 streamRemoteAudio）。
                                corsHeaders = client.inetAddress.isLoopbackAddress,
                            )
                            return
                        }
                        if (path.startsWith(VIDEO_LAYER_PATH_PREFIX)) {
                            streamVideoLayerFile(output, requestParts, headers)
                            return
                        }
                        if (path.startsWith(MEDIA_CACHE_PATH_PREFIX)) {
                            val name = URLDecoder.decode(path.substring(MEDIA_CACHE_PATH_PREFIX.length), "UTF-8")
                            val method = requestParts[0]
                            if ("PUT" == method || "POST" == method) {
                                writeMediaCacheFile(input, output, headers, name, queryString)
                            } else if ("DELETE" == method) {
                                deleteMediaCacheFile(output, name, queryString)
                            } else {
                                streamMediaCacheFile(output, requestParts, headers, name)
                            }
                            return
                        }
                        if (!path.startsWith(AUDIO_PATH_PREFIX)) {
                            writeStatus(output, 404, "Not Found")
                            return
                        }

                        val token = URLDecoder.decode(path.substring(AUDIO_PATH_PREFIX.length), "UTF-8")
                        /*
                         * 新格式（导入副本）：token 是 `local-<id>`，如 `local-3`。
                         *
                         * 必须带这个前缀：MediaStore 那一路的 ref 是**纯数字**的媒体 id，
                         * 两边都用裸数字会撞车 —— 一首导入的歌会被当成媒体库里的另一首歌。
                         * 前缀把两个命名空间彻底分开。
                         *
                         * 老格式 `imported-<净化名>-<hash>.<ext>` 继续认 —— 用户升级上来的库里
                         * 还有一批那样的文件，不能让它们变成「升级后全不能播」。
                         * 两者都由 ImportedAudioIndex.resolve 统一按磁盘实际名字解出来。
                         */
                        if (token.startsWith(IMPORTED_PREFIX) || token.startsWith(LOCAL_IMPORTED_PREFIX)) {
                            /*
                             * 传**完整的** token，别先剥掉前缀再拼路径。
                             *
                             * 磁盘上的旧副本名本身就是 "imported-<稳定名>"（导入那边 safeName 就是这么起的，
                             * 删副本的 resolveImportedFile 也是按完整 ref 拼的），而这里剥掉前缀之后
                             * 拼出来的是 "imported-audio/<稳定名>" —— 少了一段，永远 isFile() == false，
                             * 于是每一首手动导入的歌都回 404：<audio> 报 Format error、
                             * 导入时抓封面和内嵌歌词的那次 fetch 也一起失败（封面/歌词全空）。
                             * 表现正是「扫描导入能播，手动导入一律播不了」。
                             */
                            streamImportedFile(output, requestParts, headers, token)
                            return
                        }
                        if (token.startsWith(FILE_PREFIX)) {
                            streamExternalFile(output, requestParts, headers, token.substring(FILE_PREFIX.length))
                            return
                        }
                        streamMediaStoreFile(output, requestParts, headers, token)
                    }
                }
            }
        } catch (error: Exception) {
            // 之前这里连日志都没有：流写到一半断掉，WebView 那边只会报一句
            // Format error，原生侧连发生了什么都不知道。
            Log.w(TAG, "audio request failed", error)
        }
    }

    @Throws(IOException::class)
    private fun streamMediaStoreFile(
        output: BufferedOutputStream,
        requestParts: Array<String>,
        headers: Map<String, String>,
        mediaId: String
    ) {
        val uri = Uri.withAppendedPath(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, mediaId)
        val resolver = context.contentResolver
        var size: Long = -1
        var mime = "audio/*"
        resolver.query(uri, arrayOf(
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.MIME_TYPE
        ), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                size = cursor.getLong(0)
                val queriedMime = cursor.getString(1)
                if (queriedMime != null && !queriedMime.isEmpty()) mime = queriedMime
            }
        }
        writeResponse(output, requestParts, headers, size, mime, StreamSupplier { resolver.openInputStream(uri) })
    }

    @Throws(IOException::class)
    private fun streamImportedFile(
        output: BufferedOutputStream,
        requestParts: Array<String>,
        headers: Map<String, String>,
        fileName: String
    ) {
        /*
         * 挡路径穿越，但**不能连正常文件名一起挡掉**。
         *
         * 以前这里写的是 `fileName.contains("..")`。可是旧副本名是
         * `imported-<净化后的原文件名>-<hash>.<ext>`，而净化只把 `[^A-Za-z0-9._-]`
         * 换成下划线 —— 点号是**允许**保留的。于是原文件名里只要有连续两个点
         * （`Pt.2..`、`A..B`、`歌名...` 这类），副本名里就带 `..`，
         * 每一首这样的歌都被当成攻击挡回去，回 404，播不出来还查不出原因
         * （用户看到的就是「文件明明在，就是播不了」）。
         *
         * 真正的穿越防护只需要：不带任何分隔符、名字不能是 `.` / `..`。
         * `..` 出现在名字中间完全无害 —— 解析出来的仍然是 imported-audio 下的一个文件。
         */
        val nameForCheck = fileName.trim()
        if (nameForCheck.contains("/") || nameForCheck.contains("\\")
            || nameForCheck == "." || nameForCheck == "..") {
            Log.w(TAG, "imported audio refused: " + fileName)
            writeStatus(output, 404, "Not Found")
            return
        }
        val directory = importedAudioDirectory()
        /*
         * 一次解析同时服务两种命名：
         *   · 新格式纯数字 id → 查 index.json 拿到真实文件名；
         *   · 老格式 imported-xxx → 直接当文件名。
         */
        val target = ImportedAudioIndex.resolve(directory, nameForCheck)
        if (target == null || !target.isFile) {
            /*
             * 只报一句 missing 根本查不出原因，这里把关键信息一次打全：
             * 收到的 token、目录里的实际内容、目录是否可读。
             * 「文件明明在却播不了」这种问题，靠这几行就能立刻定位。
             */
            val all = directory.listFiles()
            Log.w(
                TAG,
                "imported audio missing: token=" + fileName
                + " | dir=" + directory.absolutePath
                + " | dirExists=" + directory.isDirectory
                + " | count=" + (all?.size ?: -1)
                + " | files=" + (all?.take(20)?.joinToString(", ") { it.name }.orEmpty())
            )
            writeStatus(output, 404, "Not Found")
            return
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            guessMimeType(fileName),
            StreamSupplier { FileInputStream(target) }
        )
    }

    /**
     * 按绝对路径流用户自己的音频（文件系统兜底扫描的歌）。
     *
     * 只放行外存根目录下的音频文件，别的一律 404 —— 这个服务同网段也能连（投送时），
     * 不能让它变成一个任读全盘的口子。
     * 走这条路的歌要求已授予「所有文件访问」，没授权时读流会自己失败。
     */
    @Throws(IOException::class)
    private fun streamExternalFile(
        output: BufferedOutputStream,
        requestParts: Array<String>,
        headers: Map<String, String>,
        encodedPath: String
    ) {
        val filePath = URLDecoder.decode(encodedPath, "UTF-8")
        val target = File(filePath)
        val root = Environment.getExternalStorageDirectory()
        val insideRoot = root != null && filePath.startsWith(root.path + File.separator)
        if (!insideRoot || !target.isFile || !isAudioFileName(filePath)) {
            Log.w(TAG, "external audio refused: " + filePath)
            writeStatus(output, 404, "Not Found")
            return
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            guessMimeType(filePath),
            StreamSupplier { FileInputStream(target) }
        )
    }

    /**
     * 代转发一个远端音频（只有白名单主机能用，见 {@link #registerRemoteAudio}）。
     *
     * Range 原样往上带：拖进度条时 <audio> 会发 `bytes=xxx-`，上游回 206，
     * 我们也要回 206 并把它的 Content-Range 转给 WebView，否则播放器会认为
     * 服务端不支持拖动，重新整首下载一次。
     */
    @Throws(IOException::class)
    private fun streamRemoteAudio(
        output: BufferedOutputStream,
        requestParts: Array<String>,
        headers: Map<String, String>,
        token: String,
        corsHeaders: Boolean,
    ) {
        val entry = remoteAudioRegistry.get(token)
        if (entry == null) {
            Log.w(TAG, "remote audio token unknown: " + token)
            writeStatus(output, 404, "Not Found")
            return
        }

        val target = entry.url
        val extraHeaders: Map<String, String>? = entry.headers
        val request = Request.Builder().url(target)
        // 有些 CDN 看 UA / Referer 决定给不给资源，不带的话会回一段 HTML 而不是音频
        // —— 那种回包喂进 <audio> 正是「Format error」的经典来源。
        request.header("User-Agent", REMOTE_AUDIO_USER_AGENT)
        // 默认 Referer 只给白名单主机（酷我 / 网易）：那是它们 CDN 的防盗链要求。
        // 对任意主机（洛雪音源给出的地址）塞一个 kuwo 的 Referer 反而会被回 403，
        // 所以那边只用调用方带来的头，没带就不加。
        val host = try { URL(target).host?.lowercase(Locale.ROOT) ?: "" } catch (ignored: Exception) { "" }
        if (isRemoteAudioHostAllowed(host)) {
            request.header("Referer", remoteAudioReferer(target))
        }
        // 调用方带来的头（飞牛的 music-token、音源要求的 Referer）最后写：同名的以它为准。
        if (extraHeaders != null) {
            for ((key, headerValue) in extraHeaders) {
                request.header(key, headerValue)
            }
        }
        val range = headers["range"]
        if (range != null && range.startsWith("bytes=")) request.header("Range", range)

        val upstream = if (entry.allowsRedirects()) remoteAudioClient.newCall(request.build()).execute()
        else credentialResourceClient.newCall(request.build()).execute()
        try {
            val body = upstream.body
            if (!upstream.isSuccessful || body == null) {
                Log.w(TAG, "remote audio upstream " + upstream.code + " for " + target)
                writeStatus(output, 502, "Upstream Error")
                return
            }
            val contentType = body.contentType()?.toString() ?: "audio/mpeg"
            val contentRange = upstream.header("Content-Range")
            // 只信上游给的「本次响应体」长度。上游 chunked 时保持 -1（不写 Content-Length，
            // 靠 Connection: close 收尾）。绝不能拿 Content-Range 里的 total 冒充本次长度：
            // 206 分片时 body 只有那一段，写整首的长度会让 WebView 一直等剩余字节，
            // 连接一关就被判成流异常中断 —— 表现正是「一首歌播一半就停」。
            val size = body.contentLength()
            val partial = upstream.code == 206 || contentRange != null

            Log.i(TAG, "remote " + target + " -> " + upstream.code +
                " type=" + contentType + " size=" + size + " range=" + (if (contentRange == null) "-" else contentRange))

            val response = StringBuilder()
            response.append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
            response.append("Content-Type: ").append(contentType).append("\r\n")
            response.append("Accept-Ranges: bytes\r\n")
            /*
             * CORS 头只发给本机回环连接。
             *
             * 这一整条链路存在的唯一理由就是同源：WebView 里的 <audio crossOrigin="anonymous">
             * 读回环地址是跨源的，没有 ACAO 会被挡在门外。但同一份响应给到局域网连接时，
             * `ACAO: *` 等于对用户浏览器里打开的任意页面开放读取 —— 音响自己是直接 GET
             * 播放的，完全不需要这个头，所以投送那一路只回必要内容。
             */
            if (corsHeaders) {
                response.append("Access-Control-Allow-Origin: *\r\n")
                response.append("Access-Control-Allow-Headers: range, content-range, content-length\r\n")
                response.append("Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n")
            }
            response.append("Connection: close\r\n")
            if (size >= 0) {
                response.append("Content-Length: ").append(size).append("\r\n")
            }
            // Content-Range 必须独立转发：拖进度条、算总时长全靠它，
            // 即使上游 chunked（没有 Content-Length）也要给，否则播放器只认得「一小段」。
            if (contentRange != null) {
                response.append("Content-Range: ").append(contentRange).append("\r\n")
            }
            response.append("\r\n")
            output.write(response.toString().toByteArray(StandardCharsets.US_ASCII))

            if ("GET" == requestParts[0]) {
                body.byteStream().use { audio ->
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    while (audio.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                    }
                }
            }
            output.flush()
        } finally {
            upstream.close()
        }
    }

    /**
     * 歌词后方视频层那一个视频（私有目录里的副本，见 VideoLayerFile）。
     *
     * 不像音频那样拿 URL 里的名字去拼路径：这一层永远只有一份，名字不作数 ——
     * 这个服务同网段也能连（投送时），名字来自 URL 就别拿它拼路径。
     * <video> 一样吃 Range 与 CORS，所以走的是与音频同一条 writeResponse。
     */
    @Throws(IOException::class)
    private fun streamVideoLayerFile(
        output: BufferedOutputStream,
        requestParts: Array<String>,
        headers: Map<String, String>
    ) {
        val target = VideoLayerFile.file(context)
        if (target == null || !target.isFile || target.length() <= 0) {
            Log.w(TAG, "video layer file missing")
            writeStatus(output, 404, "Not Found")
            return
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            VideoLayerFile.mimeType(context),
            StreamSupplier { FileInputStream(target) }
        )
    }

    /**
     * 读一份媒体缓存副本。原生播放器与 <audio> 都从这里取字节，所以 Range 与 CORS
     * 一样都不能少 —— 复用 writeResponse 就是为了这两件事只写一遍。
     */
    @Throws(IOException::class)
    private fun streamMediaCacheFile(
        output: BufferedOutputStream,
        requestParts: Array<String>,
        headers: Map<String, String>,
        fileName: String
    ) {
        val target = mediaCacheFile(fileName)
        if (target == null) {
            // 不存在与「名字不合法」都走 404：名字来自 URL，不给它区别对待的理由。
            Log.w(TAG, "media cache copy missing: " + fileName)
            writeStatus(output, 404, "Not Found")
            return
        }
        /*
         * 命中计数 +1（LFU 清退的依据）。
         *
         * 以前清退按 lastModified（写入时间）排：一听就过的歌和新缓存的老歌一样待遇，
         * 常听的那首反而先被删。现在每次读都把计数 +1（`<名字>.cnt` 记着），超限清退时
         * **先删计数最小的**——没人听的那份让位给天天听的那份；计数并列时再比时间，
         * 同一批写进去的按老优先。
         *
         * 计数写在 sidecar 而不是改文件名：改名会让「按前缀找副本」那一层（mediaCacheFile）
         * 找不到已经放着的份，播放到一半就 404。
         *
         * 节流：ExoPlayer 播放是 range 请求流，一首歌几百个请求；每个都写盘的话
         * 计数文件被写成热点。10 秒一个 key 只 +1 一次 —— 计数表达「这份被放过」，
         * 不需要精确到每个请求。
         */
        try {
            val now = System.currentTimeMillis()
            val counter = File(target.parentFile, target.name + ".cnt")
            synchronized (hitCountGate) {
                val last = hitCountAtMs[target.name]
                if (last == null || now - last > 10_000L) {
                    hitCountAtMs[target.name] = now
                    if (hitCountAtMs.size > 256) {
                        // 内存里的节流表别无限涨：丢掉一半最旧的（HashMap 无序，随便抽一半即可）。
                        val drop = hitCountAtMs.keys.take(hitCountAtMs.size / 2)
                        drop.forEach { hitCountAtMs.remove(it) }
                    }
                    val next = (counter.takeIf { it.isFile }?.readText()?.trim()?.toLongOrNull() ?: 0L) + 1L
                    counter.writeText(next.toString())
                    // lastModified 一起刷：计数并列时它是「谁更早」，也是兜底的清退依据。
                    target.setLastModified(now)
                }
            }
        } catch (_: Exception) {
            // 计数写不上不影响播放 —— 清退退回按时间排，顶多不够聪明。
        }
        writeResponse(
            output,
            requestParts,
            headers,
            target.length(),
            guessMimeType(fileName),
            StreamSupplier { FileInputStream(target) }
        )
    }

    /**
     * 一份副本最短能有多长。
     *
     * 不是「音频必须有这么大」，而是「小于这个的一定不是音频」：ID3 头 + 至少一帧
     * 的有效载荷。写入是「先写 .part 再 rename」的，所以半截文件正常不会以正式名
     * 存在；这一条防的是老版本 / 异常中断留下的残骸 —— 那样一份文件交给播放器，
     * 结果就是「认不出格式」或者一直缓冲下去，永远不放。
     */
    private val MIN_MEDIA_CACHE_BYTES = 8L * 1024L

    /**
     * 定位一份副本。
     *
     * 名字是 key 的 base64url，**不带扩展名**：读的时候（播放）调用方并不知道那份副本
     * 当初是什么格式，只有写的时候知道。所以这里按 `<名字>.` 前缀找，找到谁就是谁 ——
     * 同一个 key 永远只有一份（写入时会清掉同 base 的别的格式）。
     *
     * 太小的不算命中（见 [MIN_MEDIA_CACHE_BYTES]）：交给播放器只会一直缓冲/报错，
     * 当成没有这份缓存，上层回去取网络反而是对的。
     */
    private fun mediaCacheFile(fileName: String): File? {
        val found = mediaCacheFileAnyone(fileName) ?: return null
        if (found.length() < MIN_MEDIA_CACHE_BYTES) {
            Log.w(TAG, "media cache copy too small, treating as absent: " + found.name + " (" + found.length() + "B)")
            return null
        }
        return found
    }

    /** 按名字找到那份副本，**不看大小**（写入路径清旧文件时要用，不能因为它小就找不到）。 */
    private fun mediaCacheFileAnyone(fileName: String): File? {
        if (!isMediaCacheNameAllowed(fileName)) return null
        val dir = mediaCacheDirectory()
        val direct = File(dir, fileName)
        if (direct.isFile) return direct
        if (fileName.indexOf('.') >= 0) return null
        val files = dir.listFiles()
        if (files == null) return null
        for (file in files) {
            if (!file.isFile) continue
            if (!file.name.startsWith(fileName + ".")) continue
            // 计数 sidecar 与写到一半的残骸不是那份副本本身（见 isMediaCachePayloadName）。
            if (!isMediaCachePayloadName(file.name)) continue
            return file
        }
        return null
    }

    /**
     * 存一份媒体缓存副本。
     *
     * 字节走 HTTP 请求体而不是 Capacitor 桥：桥只有一条，几 MB 的 base64 压上去，
     * 别的平台会集体超时（本地导入那边的拷贝也是因此被挪到别的线程上做的）。
     *
     * 先写 `.part` 再 rename：写一半被杀不能留下一份坏的副本，而坏副本正是下一次播放
     * 会读到的那份 —— 症状是「这首歌播到一半断了，之后永远播不了」。
     */
    @Throws(IOException::class)
    private fun writeMediaCacheFile(
        input: BufferedInputStream,
        output: BufferedOutputStream,
        headers: Map<String, String>,
        fileName: String,
        queryString: String
    ) {
        // 名字只认 key 的 base64url（无点）：扩展名由 Content-Type 决定，不给调用方拼的机会。
        if (!isMediaCacheNameAllowed(fileName) || fileName.indexOf('.') >= 0) {
            Log.w(TAG, "media cache name refused: " + fileName)
            writeStatus(output, 404, "Not Found")
            return
        }
        val declared = parseLongOr(headers["content-length"], -1)
        if (declared <= 0) {
            writeStatus(output, 411, "Length Required")
            return
        }
        val storedName = fileName + "." + extensionForMime(headers["content-type"])
        val dir = mediaCacheDirectory()
        val target = File(dir, storedName)
        val temp = File(dir, storedName + ".part")
        var written: Long = 0
        BufferedOutputStream(FileOutputStream(temp)).use { fileOut ->
            val buffer = ByteArray(64 * 1024)
            // Kotlin 2.2 起 while 条件里用 `.also {}` 给外层 var 赋值会被判
            // 「Variable must be initialized」，改成显式循环体内赋值。
            while (written < declared) {
                val read = input.read(buffer, 0, Math.min(buffer.size.toLong(), declared - written).toInt())
                if (read == -1) break
                fileOut.write(buffer, 0, read)
                written += read
            }
        }
        if (written != declared) {
            temp.delete()
            Log.w(TAG, "media cache write short: " + written + "/" + declared)
            writeStatus(output, 400, "Incomplete Body")
            return
        }
        if (!temp.renameTo(target)) {
            temp.delete()
            Log.w(TAG, "media cache rename failed: " + fileName)
            writeStatus(output, 500, "Store Failed")
            return
        }
        // 同一首歌换了个格式（扩展名不同）时旧的那一份要一起走，否则它永远占着地方，
        // 而且读的时候按 `<名字>.` 前缀找，找错的那一份就是它。
        maintainMediaCache(dir, storedName, queryParam(queryString, "limit", -1))
        Log.i(TAG, "media cache stored " + storedName + " (" + written + " bytes)")
        writeStatus(output, 200, "OK")
    }

    /**
     * 原生侧整首歌落盘：从 URL 直接下载进媒体缓存。
     *
     * 以前是 Web 抓完字节再 PUT 回来 —— 也就是说缓存这件事本身跑在 WebView 里，
     * 应用退后台 / WebView 冻结时整首播完了也没人写缓存。下载挪到原生之后，
     * 谁叫一声都能存。名字编码与 Web 侧 `cacheFileName` 完全一致（base64url 无
     * padding，超长退化为 fnv1a 哈希），两边写的是同一批文件。
     *
     * 整首歌校验与 Web 侧同一条规则：MediaExtractor 探出来的时长不足歌长一半
     * （且两边都报得出时长）的是试听片段，不存 —— 存了它，这首歌就永远播不了全的。
     *
     * @return 落盘文件的字节数；0 = 没存（下载失败 / 试听片段 / 名字不合法）。
     */
    fun storeMediaCacheFromUrl(cacheKey: String?, audioUrl: String?, limitBytes: Long, minDurationMs: Long): Long {
        val fileName = mediaCacheFileNameOf(cacheKey)
        if (fileName == null || audioUrl == null || audioUrl.isEmpty()) {
            return 0L
        }
        val dir = mediaCacheDirectory()
        var temp: File? = null
        var connection: java.net.HttpURLConnection? = null
        try {
            connection = java.net.URL(audioUrl).openConnection() as java.net.HttpURLConnection
            connection.connectTimeout = 8000
            connection.readTimeout = 15000
            connection.instanceFollowRedirects = true
            // 先给个兜底 UA，平台自己那份随后覆盖 —— 有的 CDN 对太短的 UA 直接回 403，
            // 而播放器和这里用不同 UA 就会出现「播得动却存不下来」（分离会因此退回 WebView）。
            connection.setRequestProperty("User-Agent", "Mozilla/5.0")
            // 飞牛这类「要会话 Cookie 才给字节」的源：网关认识自己的 URL，
            // 要带什么头由它说（见 MusicGateway.headersForPlaybackUrl）。
            // 视频站的 CDN 防盗链也走这里：它会给回 Referer / Origin / UA。
            val platformHeaders =
                top.izuna.foliamajor.online.MusicGateway.headersForPlaybackUrl(audioUrl)
            for ((key, headerValue) in platformHeaders) {
                connection.setRequestProperty(key, headerValue)
            }
            /*
             * 中转地址要跟到真实的那条。
             *
             * 视频站的音频是**经过本机中转**才到播放器的（VideoStreamProxy 里有几条候选
             * 地址，一台回 403 换下一台）。缓存这一侧如果直接把中转地址拿来当下载地址，
             * 下到的可能是「中转找不到这条流」的 404 文本 —— 于是缓存里躺着一份放不出来
             * 的东西，而清单上写着它已经缓存好了。这里先把中转地址换回真实地址。
             */
            val directUrl = VideoStreamProxy.directUrlFor(audioUrl)
            if (directUrl != null && directUrl != audioUrl) {
                connection.disconnect()
                connection = java.net.URL(directUrl).openConnection() as java.net.HttpURLConnection
                connection.connectTimeout = 8000
                connection.readTimeout = 15000
                connection.instanceFollowRedirects = true
                connection.setRequestProperty("User-Agent", "Mozilla/5.0")
                val directHeaders =
                    top.izuna.foliamajor.online.MusicGateway.headersForPlaybackUrl(directUrl)
                for ((key, headerValue) in directHeaders) {
                    connection.setRequestProperty(key, headerValue)
                }
            }
            val code = connection.responseCode
            if (code < 200 || code >= 300) {
                return 0L
            }
            val storedName = fileName + "." + extensionForMime(connection.contentType)
            val part = File(dir, storedName + ".part")
            temp = part
            var written: Long = 0
            BufferedInputStream(connection.inputStream).use { source ->
                BufferedOutputStream(FileOutputStream(part)).use { fileOut ->
                    val buffer = ByteArray(64 * 1024)
                    var read: Int
                    while (source.read(buffer).also { read = it } != -1) {
                        fileOut.write(buffer, 0, read)
                        written += read
                    }
                }
            }
            if (written <= 0L) {
                part.delete()
                return 0L
            }
            val durationUs = probeMediaDuration(part)
            /*
             * 试听片段的门槛：**不够歌长的一半**就不存。
             *
             * minDurationMs 是毫秒，durationUs 是微秒，所以要乘 1000；这里早先写的是
             * 500，等于要求「文件时长不得少于歌长的一半」，一旦探测出来的时长偏短就
             * 一律被判成试听片段删掉 —— 而视频站的音频是 DASH 分片（.m4s），它没有
             * 完整文件那种时长元数据，probeMediaDuration 探出来常常只有几十秒。
             * 结果就是：分离永远拿不到音频，退回 WebView 那条只分析混音的路
             * （鼓点、人声分离全部失效），而且**一点错都不报**。
             *
             * 探测不出时长（<= 0）时放行：宁可存一份可能不完整的副本，也别让整首歌
             * 的分析因为探测不到元数据而彻底没有文件可读。
             */
            /*
             * 只有「探测出来的时长明显偏短」才当试听片段 —— 但 DASH 分片会误伤。
             *
             * 视频站的音频是 .m4s 分片：它的 mvhd 里没有完整文件的时长，探出来常常
             * 只有几十秒，于是整首正常的歌被判成试听片段删掉，分离拿不到音频、
             * 悄悄退回 WebView（鼓点 / 人声分离全部失效，且不报错）。
             *
             * 所以给这一档单独放宽：地址带 ttl / deadline 这类取流签名的，一定是我们
             * 刚从 CDN 完整下载的那一份（分片不会有这种参数），跳过时长判定。
             */
            val signedStream = audioUrl.contains("deadline=") || audioUrl.contains("upsig=") ||
                audioUrl.contains("expires=")
            if (!signedStream && minDurationMs > 0L && durationUs > 0L &&
                durationUs < minDurationMs * 500L) {
                Log.i(TAG, "media cache refused a clip (" + (durationUs / 1000) + "ms of " +
                        minDurationMs + "ms): " + cacheKey)
                part.delete()
                return 0L
            }
            val target = File(dir, storedName)
            if (target.isFile && target.length() == written) {
                part.delete()
                return written
            }
            if (!part.renameTo(target)) {
                part.delete()
                Log.w(TAG, "media cache rename failed: " + fileName)
                return 0L
            }
            temp = null
            maintainMediaCache(dir, storedName, limitBytes)
            Log.i(TAG, "media cache stored from url " + storedName + " (" + written + " bytes)")
            return written
        } catch (error: Throwable) {
            Log.w(TAG, "storeMediaCacheFromUrl failed", error)
            if (temp != null) temp.delete()
            return 0L
        } finally {
            connection?.disconnect()
        }
    }

    private fun deleteMediaCacheFile(
        output: BufferedOutputStream,
        fileName: String,
        queryString: String
    ) {
        // 用 mediaCacheFileAnyone：删除是「把它从盘上清掉」，不该因为文件小就说没有。
        val target = mediaCacheFileAnyone(fileName)
        if (target == null) {
            writeStatus(output, 404, "Not Found")
            return
        }
        val size = queryParam(queryString, "size", -1)
        if (size > 0 && target.length() != size) {
            writeStatus(output, 409, "Conflict")
            return
        }
        val removed = target.delete()
        writeStatus(output, if (removed) 200 else 500, if (removed) "OK" else "Delete Failed")
    }

    private var lastPruneAtMs = 0L

    /** 命中计数节流表：key → 上次 +1 的时间。见 streamMediaCacheFile 的注释。 */
    private val hitCountAtMs = HashMap<String, Long>()
    private val hitCountGate = Object()

    /**
     * 写完一份副本之后的收尾，只做一次遍历。
     *
     * ⚠️ 原来这里跑了两遍目录：`removeSiblingCopies` 一遍、`pruneMediaCache` 一遍，
     * 而后者还要**排序 + 删文件**。缓存里攒到几百份时，每写完一首歌就要做一次
     * 全目录排序 —— 界面上正是「过一段时间卡一下」（一首歌播完写一次缓存）。
     *
     * 现在一次遍历里把三件事办完：清上次写一半的残骸、清同 base 的旧格式、累计总大小；
     * 只有**确实超了上限**才去排序删最旧的那几份，而且最多 30 秒做一次。
     */
    @Synchronized
    private fun maintainMediaCache(dir: File, storedName: String, limit: Long) {
        val files = dir.listFiles()
        if (files == null) return
        val base = storedName.substring(0, storedName.lastIndexOf('.'))
        val kept = ArrayList<File>()
        var total: Long = 0
        for (file in files) {
            val name = file.name
            if (!file.isFile) continue
            // 命中计数 sidecar：不是缓存内容，不计大小；它跟着自己的媒体文件走
            // （媒体文件被清时才清它），同 base 写新格式时旧计数就该扔了 —— 顺手清掉。
            if (name.endsWith(".cnt")) {
                if (!name.endsWith(storedName + ".cnt") && name.startsWith(base + ".")) file.delete()
                continue
            }
            // 写一半留下的残骸，永远不会被读，顺手清掉。
            if (name.endsWith(".part")) {
                file.delete()
                continue
            }
            // 同一首歌的旧格式：留着会让「按前缀找」找错那一份。
            if (name != storedName && name.startsWith(base + ".")) {
                file.delete()
                continue
            }
            kept.add(file)
            total += file.length()
        }
        if (limit <= 0 || total <= limit) return
        val now = System.currentTimeMillis()
        if (now - lastPruneAtMs < PRUNE_INTERVAL_MS) return
        lastPruneAtMs = now
        /*
         * 清退按「谁最不值得留」排：命中计数小的先走（没人听的副本让位），计数并列
         * 再按时间旧优先。计数读不到（sidecar 缺了、坏了）当 0 —— 那种份最先被清，
         * 也符合直觉：连计数都没有，说明它从来没被放过。
         */
        data class Victim(val file: File, val hits: Long)
        val victims = kept.map { file ->
            val hits = File(file.parentFile, file.name + ".cnt")
                .takeIf { it.isFile }
                ?.let { runCatching { it.readText().trim().toLongOrNull() }.getOrNull() }
                ?: 0L
            Victim(file, hits)
        }
        victims.sortedWith(
            compareBy({ it.hits }, { it.file.lastModified() })
        ).forEach { victim ->
            if (total <= limit) return
            val size = victim.file.length()
            if (victim.file.delete()) {
                total -= size
                // 计数 sidecar 一起清：留着的话同一个 key 下次写进来会继承旧计数。
                File(victim.file.parentFile, victim.file.name + ".cnt").delete()
            }
        }
    }

    private fun interface StreamSupplier {
        @Throws(IOException::class)
        fun open(): InputStream?
    }

    @Throws(IOException::class)
    private fun writeResponse(
        output: BufferedOutputStream,
        requestParts: Array<String>,
        headers: Map<String, String>,
        size: Long,
        mime: String,
        supplier: StreamSupplier
    ) {
        // 空文件喂给 <audio> 只会换来一句莫名的 MEDIA_ELEMENT_ERROR: Format error；
        // 这里直接 404 并把原因写进日志，下次一眼就能看出是"文件是空的"。
        if (size <= 0) {
            Log.w(TAG, "audio source is empty or unreadable (size=" + size + "): " + requestParts[1])
            writeStatus(output, 404, "Empty Audio")
            return
        }
        var start: Long = 0
        var end = if (size > 0) size - 1 else -1
        val range = headers["range"]
        var partial = false
        if (range != null && range.startsWith("bytes=")) {
            val parts = range.substring(6).split("-")
            try {
                if (!parts[0].isEmpty()) start = parts[0].toLong()
                if (parts.size > 1 && !parts[1].isEmpty()) end = parts[1].toLong()
                if (size > 0) end = Math.min(end, size - 1)
                partial = true
            } catch (ignored: NumberFormatException) {
                start = 0
                end = if (size > 0) size - 1 else -1
                partial = false
            }
        }

        val contentLength = if (end >= start) end - start + 1 else -1
        Log.i(TAG, requestParts[0] + " " + requestParts[1] +
            " range=" + (if (range == null) "-" else range) +
            " size=" + size + " partial=" + partial +
            (if (partial) " bytes=" + start + "-" + end else ""))
        val response = StringBuilder()
        response.append(if (partial) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
        response.append("Content-Type: ").append(mime).append("\r\n")
        response.append("Accept-Ranges: bytes\r\n")
        /*
         * 这些地址是「固定路径 + 换内容」的（视频层永远是 /video-layer/current）。
         *
         * 不显式禁用缓存的话，WebView 会按 URL 缓存上一次的响应体 —— 用户换了视频，
         * 地址没变，<video> 拿到手的还是旧字节，表现就是「换了没反应，重启才生效」
         * （重启后缓存没了、server 也重开）。no-store 让每次请求都真正读盘。
         */
        response.append("Cache-Control: no-store, no-cache, must-revalidate\r\n")
        response.append("Pragma: no-cache\r\n")
        response.append("Access-Control-Allow-Origin: *\r\n")
        // crossOrigin="anonymous" 的 <audio> 会带 CORS 语义，把 Range 相关头暴露出来，
        // 拖进度条（发 Range、读 Content-Range）才不会在 CORS 检查上被拦。
        response.append("Access-Control-Allow-Headers: range, content-range, content-length\r\n")
        response.append("Access-Control-Expose-Headers: range, content-range, content-length, accept-ranges\r\n")
        response.append("Connection: close\r\n")
        if (size > 0) {
            response.append("Content-Length: ").append(contentLength).append("\r\n")
            if (partial) {
                response.append("Content-Range: bytes ")
                    .append(start).append('-').append(end).append('/').append(size).append("\r\n")
            }
        }
        response.append("\r\n")
        output.write(response.toString().toByteArray(StandardCharsets.US_ASCII))

        // HEAD 只回头部：<audio> 在真正下载前会先探一次，那时不能把整首歌读一遍。
        if ("GET" == requestParts[0]) {
            val audio = supplier.open()
            if (audio != null) {
                audio.use {
                    skipFully(audio, start)
                    val buffer = ByteArray(64 * 1024)
                    var remaining = contentLength
                    var read: Int
                    while (audio.read(buffer).also { read = it } != -1 && (remaining < 0 || remaining > 0)) {
                        val writeLength = if (remaining < 0) read else Math.min(read.toLong(), remaining).toInt()
                        output.write(buffer, 0, writeLength)
                        if (remaining > 0) remaining -= writeLength
                    }
                }
            }
        }
        output.flush()
    }
}
