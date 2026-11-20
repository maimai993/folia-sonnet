package top.izuna.foliamajor

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress

/**
 * 投送相关日志行里怎么写出「地址」和「凭证」。
 *
 * 为什么单独一份（issue M24）：投送这条路上的日志有两个会随用户反馈泄漏出去的值 ——
 * 局域网令牌（拿着它就能在有效期内拉走正在投送的音频）与设备的完整地址（含局域网 IP 与端口，
 * 能拼出用户的网络拓扑）。但排查投送问题又恰恰需要线索：是哪一段网段的设备、凭证是什么形态。
 * 所以这里不是「删日志」，而是把值换成照样能用的线索：
 *
 *  - 地址只留网段：`http://192.168.1.20:8080/desc.xml` → `16 字节 / desc.xml`；
 *    主机名只留后缀（`livingroom.speaker.local` 只留 `.speaker.local`），路径只留文件名，
 *    查询串整个丢掉（它常常就是签名）。
 *  - 令牌只留形态：长度 + 前 4 位 + 是否只含字母数字 —— 「有没有拿到、两边是不是同一个、
 *    前缀对不对」都还看得出来，原文看不出。
 *
 * 这些函数只负责拼字符串，不解析 DNS。纯 JVM，可直接在单测里逐条核对。
 */
internal object LanCastLogText {

    /** 令牌日志里最多留几位原文。前 4 位足够比对「两边是不是同一份」，剩下的长度单独记。 */
    private const val TOKEN_PREFIX_LENGTH = 4

    /** 设备描述路径最多留多长：只留文件名就够了，再长就不是正常设备。 */
    private const val MAX_PATH_HINT_LENGTH = 48

    /**
     * 一个地址的排查线索，不含主机与端口。
     *
     * 输出形如 `16 字节 / desc.xml`：前半段是「设备描述体量」，后半段是「资源名」——
     * 这两样在排「设备描述读不下来」时正是需要的那点信息（空体、报错页、404 页面一眼能分）。
     */
    fun deviceHint(raw: String?): String = urlHint(raw) { path -> resourceHint(path) }

    /**
     * 控制地址的线索。
     *
     * 控制地址的路径本身就是「这台设备的哪一种服务」（`/upnp/control/AVTransport1`），
     * 但对端控制服务的地址往往就是主机加一个短名，所以这里同样只留资源名：
     * 判断「是不是 AVTransport 那条」看的是请求动作（`play` / `stop`），不靠路径。
     */
    fun controlHint(raw: String?): String = urlHint(raw) { path -> resourceHint(path) }

    /** 「网段 + 资源名」的共同部分；解析不了也绝不回退成原文（回退就等于漏了）。 */
    private fun urlHint(raw: String?, tail: (String) -> String): String {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return "无地址"
        val parsed = try {
            java.net.URL(text)
        } catch (error: Exception) {
            return "无法解析的地址（${text.length} 字符）"
        }
        val host = parsed.host?.removePrefix("[")?.removeSuffix("]").orEmpty()
        return hostHint(host) + " / " + tail(parsed.path.orEmpty())
    }

    /**
     * 主机只留「是哪一类、哪一段」：IP 留网段（`192.168.1.x`），IPv6 留前缀，主机名只留后缀。
     *
     * 为什么不干脆不记：投送最常见的两个问题正是「发现到的地址不在同一个网段」和
     * 「拿到的是一台 `.local` 主机而不是 IP」—— 留网段后缀能看出这两件事，留完整 IP 不能。
     */
    fun hostHint(rawHost: String?): String {
        val host = rawHost?.trim()?.removePrefix("[")?.removeSuffix("]").orEmpty()
        if (host.isEmpty()) return "无主机"
        if (host.endsWith(".local", ignoreCase = true)) {
            // mDNS 名字：只留最后两段（`.speaker.local`），前面是房间名 —— 那属于用户自己的信息。
            val parts = host.trimEnd('.').split('.')
            return if (parts.size >= 3) "…" + parts.takeLast(2).joinToString(".").let { ".$it" } else "…local"
        }
        val literal = inetLiteral(host) ?: return "主机名（${host.length} 字符）"
        val bytes = literal.address
        if (literal is Inet4Address) {
            // 家用网络的实际粒度就是 /24：同一段里的哪一台设备，对排查没有区别。
            return "${bytes[0].toInt() and 0xFF}.${bytes[1].toInt() and 0xFF}.${bytes[2].toInt() and 0xFF}.x"
        }
        if (literal is Inet6Address) {
            // IPv6 留前 4 组（/64 的常见写法），后面的接口标识属于设备身份。
            val groups = (0 until 4).map { index ->
                val high = bytes[index * 2].toInt() and 0xFF
                val low = bytes[index * 2 + 1].toInt() and 0xFF
                Integer.toHexString((high shl 8) or low)
            }
            return groups.joinToString(":") + ":…"
        }
        return "主机名（${host.length} 字符）"
    }

    /** 只解析 IP 字面量；含字母又不是 IPv6 形态的一律当主机名，不查 DNS。 */
    private fun inetLiteral(host: String): InetAddress? {
        val looksV4 = host.count { it == '.' } == 3 && host.all { it.isDigit() || it == '.' }
        val looksV6 = host.contains(':')
        if (!looksV4 && !looksV6) return null
        return try {
            InetAddress.getByName(host)
        } catch (error: Exception) {
            null
        }
    }

    /** 路径只留资源名（最后一段）；查询串不上日志。 */
    private fun resourceHint(path: String): String {
        val withoutQuery = path.substringBefore('?')
        val name = withoutQuery.trimEnd('/').substringAfterLast('/')
        if (name.isEmpty()) return "根路径"
        return if (name.length > MAX_PATH_HINT_LENGTH) name.take(MAX_PATH_HINT_LENGTH) + "…" else name
    }

    /**
     * 令牌的排查线索：`长度 32、前缀 a1b2、字母数字`。原文一位都不留。
     *
     * 前缀只留 4 位：投送令牌是 32 位高熵串，4 位不足以猜出剩下的部分，
     * 但足够回答「Web 层发出来的和原生签发的到底是不是同一个」—— 这正是这类问题的第一问。
     */
    fun tokenHint(raw: String?): String {
        val token = raw.orEmpty()
        val shape = if (token.isEmpty()) {
            "空"
        } else if (token.all { it.isLetterOrDigit() || it == '-' || it == '_' }) {
            "字母数字"
        } else {
            "含特殊字符"
        }
        if (token.isEmpty()) return "空令牌"
        val prefix = token.take(TOKEN_PREFIX_LENGTH)
        return "长度 ${token.length}、前缀 $prefix、$shape"
    }

    /** 不含主机与端口的响应正文片段，给「音响到底回了什么」这类排查用（issue M22）。 */
    fun bodySnippet(raw: String?, maxLength: Int = BODY_SNIPPET_LENGTH): String {
        val text = raw?.trim()?.replace(WHITESPACE, " ").orEmpty()
        if (text.isEmpty()) return "空正文"
        return if (text.length > maxLength) {
            text.take(maxLength) + "…（共 ${text.length} 字符）"
        } else {
            text
        }
    }

    private const val BODY_SNIPPET_LENGTH = 240

    private val WHITESPACE = Regex("\\s+")
}
