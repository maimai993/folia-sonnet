package top.izuna.foliamajor.wallpaper

import android.util.Log

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * 从字体站的下载包里取出可用的字体文件。
 *
 * 为什么放在原生做：字体包是几 MB 的 zip，解压要读中央目录、要解 deflate，
 * WebView 里既没有文件系统也扛不住这个内存。原生这边下完解完，只回一个结果。
 *
 * 下载接口必须带会话 cookie（PHPSESSID），而这个 cookie 是访问详情页时才发的 ——
 * 原生没有共享 WebView 的 cookie jar，所以这里**自己先取一遍详情页**再调接口。
 * 这条链路就是 `docs/fonts-net-cn-api.md` 里记录的那套。
 */
object FontArchiveDownloader {

    private const val TAG = "FoliaFontMarket"
    private const val BASE = "https://www.fonts.net.cn"

    /** 字体包上限：实测几 MB，留足余量到 64 MB。 */
    private const val MAX_ARCHIVE_BYTES = 64L * 1024L * 1024L

    /** 单个字体文件上限，防解压炸弹。 */
    private const val MAX_FONT_BYTES = 48L * 1024L * 1024L

    /**
     * 后缀优先级。
     *
     * 实测字体天下的包几乎全是 ttf，但不能指望这一点 —— 站点换打包方式、
     * 或者换成别的源，就可能出现 otf / ttc / woff2。
     * 顺序的道理：ttf/otf 是原生渲染和 Canvas 都能吃的；ttc 是集合，取第一个；
     * woff/woff2 是网页专用，只能给 WebView 用，排最后。
     *
     * 注意：注释里不要写 Markdown 的星号粗体。Kotlin 会把斜杠加星号当成注释结束，
     * 之前这里写了两颗星，直接导致整个文件编译不过。
     */
    private val FONT_EXTENSIONS = listOf("ttf", "otf", "ttc", "woff2", "woff")

    /**
     * 下载时用的 UA。
     *
     * 站点会按 UA 拦程序请求，用桌面 Chrome 的串最稳。
     */
    private const val USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

    /** 下载结果。失败时 [error] 是给用户看的原因。 */
    data class Result(
        val fontFile: File?,
        val fileName: String,
        val error: String?,
    )

    /**
     * 下载并解出字体。
     *
     * @param fontId 字体天下的数字 ID
     * @param targetDirectory 落盘目录（用应用的 filesDir）
     */
    @JvmStatic
    @JvmOverloads
    fun download(
        fontId: String,
        targetDirectory: File,
        onProgress: ((downloaded: Long, total: Long) -> Unit)? = null,
    ): Result {
        val detailUrl = "$BASE/font-$fontId.html"
        return try {
            val session = openSession(detailUrl)
            val archiveRef = requestArchiveUrl(fontId, detailUrl, session)
                ?: return Result(null, "", "RequestFailed")
            // 接口明确拒绝（需购买 / 需授权 / 已停用）：把 code 带出去让界面如实提示。
            if (archiveRef.startsWith(ERROR_PREFIX)) {
                return Result(null, "", archiveRef.removePrefix(ERROR_PREFIX))
            }

            val archive = downloadArchive(archiveRef, detailUrl, session, onProgress)
                ?: return Result(null, "", "ArchiveDownloadFailed")

            val picked = pickFontEntry(archive)
                ?: return Result(null, "", "NoFontInArchive")

            // 文件名带字体 id，换字体时不会串。
            val fontFile = File(targetDirectory, "folia_market_font_$fontId.${picked.second}")
            fontFile.writeBytes(picked.third)
            Log.i(TAG, "Font archive extracted: ${picked.first} -> ${fontFile.name}")
            Result(fontFile, picked.first, null)
        } catch (error: Throwable) {
            Log.w(TAG, "Failed to download font archive", error)
            Result(null, "", "DownloadFailed:" + (error.message ?: error.javaClass.simpleName))
        }
    }

    /** 打开详情页拿 Set-Cookie。 */
    private fun openSession(detailUrl: String): String {
        val connection = openConnection(detailUrl)
        try {
            connection.requestMethod = "GET"
            connection.inputStream.use { it.skipBytesFully() }
            val cookies = connection.headerFields["Set-Cookie"] ?: emptyList()
            return cookies.mapNotNull { it?.substringBefore(';') }.joinToString("; ")
        } catch (error: Throwable) {
            Log.w(TAG, "Failed to open session on the font detail page", error)
            return ""
        } finally {
            connection.disconnect()
        }
    }

    /**
     * 调下载接口换 zip 地址。
     *
     * 参数必须走 form-urlencoded —— 发 JSON 服务端解不出来，会报 FontNotFound。
     *
     * @return 成功是地址；接口明确拒绝时是 `ERR:<code>`；其它情况是 null。
     */
    private fun requestArchiveUrl(fontId: String, referer: String, cookie: String): String? {
        val connection = openConnection("$BASE/api/font-download/url")
        try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty(
                    "Content-Type",
                    "application/x-www-form-urlencoded; charset=UTF-8",
            )
            connection.setRequestProperty("X-Requested-With", "XMLHttpRequest")
            connection.setRequestProperty("Referer", referer)
            if (cookie.isNotEmpty()) {
                connection.setRequestProperty("Cookie", cookie)
            }
            val body = "fontId=" + java.net.URLEncoder.encode(fontId, "UTF-8")
            connection.outputStream.use { it.write(body.toByteArray()) }

            val text = connection.inputStream.use { it.readTextSafely() }
            if (!text.contains("\"success\":true")) {
                // 失败码在 code 字段里，原样回给 Web 侧去翻译。
                val code = Regex("\"code\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1)
                Log.w(TAG, "Font download rejected: $code")
                return if (code.isNullOrEmpty()) null else ERROR_PREFIX + code
            }
            val url = Regex("\"url\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.get(1)
                ?: return null
            val decoded = unescapeJsonString(url)
            return if (decoded.startsWith("//")) "https:$decoded" else decoded
        } catch (error: Throwable) {
            Log.w(TAG, "Failed to request the archive url", error)
            return null
        } finally {
            connection.disconnect()
        }
    }

    private fun downloadArchive(
        url: String,
        referer: String,
        cookie: String,
        onProgress: ((Long, Long) -> Unit)? = null,
    ): ByteArray? {
        val connection = openConnection(url)
        try {
            connection.setRequestProperty("Referer", referer)
            if (cookie.isNotEmpty()) {
                connection.setRequestProperty("Cookie", cookie)
            }
            if (connection.responseCode !in 200..299) return null
            // 长度可能是 0（分块传输），界面上就退化成不确定进度。
            val total = connection.contentLengthLong.coerceAtLeast(0L)
            return connection.inputStream.use { stream ->
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(64 * 1024)
                var written = 0L
                var read = stream.read(buffer)
                while (read > 0) {
                    written += read
                    if (written > MAX_ARCHIVE_BYTES) {
                        Log.w(TAG, "The font archive is too large")
                        return null
                    }
                    out.write(buffer, 0, read)
                    onProgress?.invoke(written, total)
                    read = stream.read(buffer)
                }
                out.toByteArray()
            }
        } catch (error: Throwable) {
            Log.w(TAG, "Failed to download the font archive", error)
            return null
        } finally {
            connection.disconnect()
        }
    }

    /**
     * 在 zip 里挑字体文件。
     *
     * 按 [FONT_EXTENSIONS] 的优先级取；同一优先级有多个时取**路径最短**的那个
     * （包里的字体通常在顶层目录，而预览图/说明在子目录里）。
     *
     * 必须校验文件头（[looksLikeFont]）：包里偶尔会有扩展名对、内容却是
     * 文本/HTML 的文件，光看后缀会把它当字体存下来，
     * 到 Web 侧 FontFace 解析时才报 Invalid font data —— 那时已经离现场很远了。
     *
     * @return (文件名, 后缀, 内容)；没有可用字体时返回 null。
     */
    private fun pickFontEntry(archive: ByteArray): Triple<String, String, ByteArray>? {
        val candidates = mutableListOf<Triple<String, String, ByteArray>>()
        ZipInputStream(archive.inputStream()).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                if (!entry.isDirectory) {
                    val name = entry.name
                    val baseName = name.substringAfterLast('/')
                    val extension = baseName.substringAfterLast('.', "").lowercase()
                    if (extension in FONT_EXTENSIONS && baseName.isNotEmpty()) {
                        val bytes = zip.readEntrySafely() ?: return@use
                        if (bytes.isNotEmpty() && looksLikeFont(bytes)) {
                            candidates.add(Triple(baseName, extension, bytes))
                        } else if (bytes.isNotEmpty()) {
                            Log.w(TAG, "Skipping non-font payload: $name (${bytes.size} bytes)")
                        }
                    }
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }

        if (candidates.isEmpty()) return null
        return candidates.sortedWith(
                compareBy({ FONT_EXTENSIONS.indexOf(it.second) }, { it.first.length }),
        ).first()
    }

    /**
     * 文件头判断这是不是一个真字体。
     *
     * 覆盖四种实际会遇到的格式：
     *   · `00 01 00 00` / `74 72 75 65` — TrueType
     *   · `4F 54 54 4F`（OTTO）— CFF 轮廓的 OpenType
     *   · `74 74 63 66`（ttcf）— 字体集合
     *   · `77 4F 46 32`（wOF2）/ `77 4F 46 46`（wOFF）— Web 字体
     *
     * 判不过就不收：宁可报「包里没有字体」，也不要塞一个坏文件到 FontFace。
     */
    private fun looksLikeFont(bytes: ByteArray): Boolean {
        if (bytes.size < 4) return false
        fun at(index: Int) = bytes[index].toInt() and 0xFF
        // TrueType：00 01 00 00，或旧式的 'true'
        if (at(0) == 0x00 && at(1) == 0x01 && at(2) == 0x00 && at(3) == 0x00) return true
        if (at(0) == 0x74 && at(1) == 0x72 && at(2) == 0x75 && at(3) == 0x65) return true
        // OTTO
        if (at(0) == 0x4F && at(1) == 0x54 && at(2) == 0x54 && at(3) == 0x4F) return true
        // ttcf
        if (at(0) == 0x74 && at(1) == 0x74 && at(2) == 0x63 && at(3) == 0x66) return true
        // wOFF / wOF2
        if (at(0) == 0x77 && at(1) == 0x4F && at(2) == 0x46 && (at(3) == 0x46 || at(3) == 0x32)) return true
        return false
    }

    private fun openConnection(url: String): HttpURLConnection {
        return (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 30_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", USER_AGENT)
            setRequestProperty("Accept", "*/*")
        }
    }

    /** 失败码用这个前缀回传，Web 侧据此区分「接口拒绝」和「网络挂了」。 */
    private const val ERROR_PREFIX = "ERR:"

    /**
     * 解 JSON 字符串里的转义。
     *
     * 站点返回的下载地址是照 JSON 转义过的：
     *   `\/\/fileres.fonts.net.cn\/font-...zip?...\u0026auth_key=...`
     * 其中 `\/` 是斜杠、`\u0026` 是 &（签名参数靠它连着）。
     *
     * 直接拿正则抓出来的原始文本是个非法 URL，请求必然失败 ——
     * 用户只会看到一句 DownloadFailed，看不出真正原因。所以必须解转义。
     */
    private fun unescapeJsonString(raw: String): String {
        if (!raw.contains('\\')) return raw
        val out = StringBuilder(raw.length)
        var index = 0
        while (index < raw.length) {
            val current = raw[index]
            if (current != '\\' || index == raw.length - 1) {
                out.append(current)
                index += 1
                continue
            }
            when (val next = raw[index + 1]) {
                'u' -> {
                    // \uXXXX
                    val hex = raw.substring(index + 2, minOf(index + 6, raw.length))
                    val code = hex.toIntOrNull(16)
                    if (code != null) {
                        out.append(code.toChar())
                        index += 6
                    } else {
                        out.append(next)
                        index += 2
                    }
                }
                '"', '\\', '/' -> {
                    out.append(next)
                    index += 2
                }
                'b' -> { out.append('\b'); index += 2 }
                'f' -> { out.append('\u000C'); index += 2 }
                'n' -> { out.append('\n'); index += 2 }
                'r' -> { out.append('\r'); index += 2 }
                't' -> { out.append('\t'); index += 2 }
                else -> {
                    out.append(next)
                    index += 2
                }
            }
        }
        return out.toString()
    }

    private fun InputStream.skipBytesFully() {
        val buffer = ByteArray(8 * 1024)
        while (read(buffer) > 0) {
            // 只为把连接读完，让服务端把 cookie 发全。
        }
    }

    private fun InputStream.readTextSafely(): String {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        var read = read(buffer)
        var total = 0
        while (read > 0 && total < 512 * 1024) {
            out.write(buffer, 0, read)
            total += read
            read = read(buffer)
        }
        return out.toString("UTF-8")
    }

    /** 读一个 zip 条目；超过上限就放弃（防解压炸弹）。 */
    private fun ZipInputStream.readEntrySafely(): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var written = 0L
        var read = read(buffer)
        while (read > 0) {
            written += read
            if (written > MAX_FONT_BYTES) {
                Log.w(TAG, "A font entry in the archive is too large")
                return null
            }
            out.write(buffer, 0, read)
            read = read(buffer)
        }
        return out.toByteArray()
    }
}
