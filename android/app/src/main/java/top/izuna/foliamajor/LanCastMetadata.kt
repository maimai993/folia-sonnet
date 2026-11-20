package top.izuna.foliamajor

import java.util.Locale

/*
 * 投送给音响时声明的媒体元数据（issue M23）。
 *
 * 两件过去写死、写着写着就成了兼容性缺陷的事：
 *
 * 1. `protocolInfo` 一律声明成 MP3。投送源却可以是任意格式 —— 本地文件、无损流、别的平台
 *    直链都会走到这里 —— 而部分音响**按 protocolInfo 选解码器**，声明与实际不符时直接拒播，
 *    用户看到的却是一句「不支持 DLNA」。
 * 2. 时长用 `Int` 承载毫秒、`String.format` 不带 Locale。阿拉伯语等区域的默认 Locale 会
 *    产出非 ASCII 数字，而 DLNA 的 `duration` 必须是 `H+:MM:SS` 的 ASCII 形式；`Int` 在
 *    24 天以上的音频上还会溢出成负数。
 *
 * 这一层只做纯计算，不碰网络，所以判定都能在 JVM 单元测试里钉住。
 */
internal object LanCastMetadata {

    /** DLNA 认识的音频容器；`UNKNOWN` 表示认不出，回退 MP3。 */
    enum class Format(val mime: String, val profileName: String) {
        MP3("audio/mpeg", "MP3"),
        FLAC("audio/flac", "FLAC"),
        AAC("audio/mp4", "AAC_ISO"),
        WAV("audio/wav", "WAV"),
        OGG("audio/ogg", "OGG"),
        UNKNOWN("audio/mpeg", ""),
    }

    /** 认不出格式时的回退 MIME：绝大多数音响都至少认 MP3。 */
    private const val FALLBACK_MIME = "audio/mpeg"

    private val FORMAT_BY_EXTENSION = mapOf(
        "mp3" to Format.MP3,
        "mp2" to Format.MP3,
        "mpa" to Format.MP3,
        "flac" to Format.FLAC,
        "alac" to Format.AAC,
        "m4a" to Format.AAC,
        "mp4" to Format.AAC,
        "aac" to Format.AAC,
        "wav" to Format.WAV,
        "wave" to Format.WAV,
        "ogg" to Format.OGG,
        "oga" to Format.OGG,
        "opus" to Format.OGG,
    )

    /**
     * 从地址里认格式：参数里显式的 `type` / `format` 优先，其次看路径扩展名。认不出返回
     * `UNKNOWN` —— 不猜，回退 MP3 并让音响按内容自己判。
     */
    fun formatOf(url: String): Format {
        formatFromQuery(url)?.let { return it }
        val path = pathOf(url)
        val dot = path.lastIndexOf('.')
        if (dot < 0) return Format.UNKNOWN
        val extension = path.substring(dot + 1).lowercase(Locale.ROOT)
        return FORMAT_BY_EXTENSION[extension] ?: Format.UNKNOWN
    }

    /**
     * 要声明的 `protocolInfo`。
     *
     * 有 profile 就写成成套的 `http-get:*:<mime>:DLNA.ORG_PN=<pn>`；认不出格式时只声明通用
     * 的 MP3 MIME、profile 段写 `*` —— 不替音响断定它是哪一种 profile。
     */
    fun protocolInfo(url: String): String = protocolInfoFor(formatOf(url))

    fun protocolInfoFor(format: Format): String = when (format) {
        Format.UNKNOWN -> "http-get:*:$FALLBACK_MIME:*"
        else -> "http-get:*:${format.mime}:DLNA.ORG_PN=${format.profileName}"
    }

    /**
     * DLNA 的 `duration`：`H+:MM:SS`，**必须**是 ASCII 数字。小时位不补零（`H+`），
     * 分、秒各两位。负数与非数按 `00:00:00` 处理 —— 音响拿到负时长会停在上一条。
     */
    fun duration(durationMs: Long): String {
        val total = if (durationMs <= 0L) 0L else durationMs / 1000L
        val hours = total / 3600L
        val minutes = (total % 3600L) / 60L
        val seconds = total % 60L
        // Locale.ROOT 是这条的关键：默认 Locale 下 %02d 会给出非 ASCII 的本地数字。
        return String.format(Locale.ROOT, "%d:%02d:%02d", hours, minutes, seconds)
    }

    // ------------------------------------------------------------------ 内部

    private fun formatFromQuery(url: String): Format? {
        val queryStart = url.indexOf('?')
        if (queryStart < 0 || queryStart == url.length - 1) return null
        // 不引 android.net.Uri（JVM 单测里没有），自己拆：只要能取到参数值就够。
        val query = url.substring(queryStart + 1)
        for (pair in query.split('&')) {
            val eq = pair.indexOf('=')
            if (eq <= 0) continue
            val key = pair.substring(0, eq).lowercase(Locale.ROOT)
            if (key != "type" && key != "format" && key != "container" && key != "ext") continue
            val raw = pair.substring(eq + 1).lowercase(Locale.ROOT).removePrefix("audio/")
            // 显式写了 MIME（`type=audio/flac`）也认。
            FORMAT_BY_EXTENSION[raw]?.let { return it }
            mimeToFormat(raw)?.let { return it }
        }
        return null
    }

    private fun mimeToFormat(mime: String): Format? = when (mime.substringBefore(';').trim()) {
        "mpeg", "mp3" -> Format.MP3
        "flac", "x-flac" -> Format.FLAC
        "mp4", "m4a", "x-m4a", "aac", "alac" -> Format.AAC
        "wav", "x-wav", "wave" -> Format.WAV
        "ogg", "x-ogg", "opus" -> Format.OGG
        else -> null
    }

    /** 地址里的路径部分；地址本身不合法时退化成「问号 / 井号之前的那一段」。 */
    private fun pathOf(value: String): String {
        val cut = value.indexOfFirst { it == '?' || it == '#' }
        val path = if (cut >= 0) value.substring(0, cut) else value
        // 去掉 scheme://host 之后的部分，免得把主机名里的点当成扩展名分隔符。
        val schemeEnd = path.indexOf("://")
        if (schemeEnd < 0) return path
        val slash = path.indexOf('/', schemeEnd + 3)
        return if (slash < 0) "" else path.substring(slash)
    }
}
