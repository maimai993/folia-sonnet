package top.izuna.foliamajor

import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URL

/**
 * 投送目标（SSDP 的 LOCATION、设备描述里的 controlURL）的准入判定。
 *
 * 为什么要单独一份：SSDP 是无认证的明文 UDP，同网段任何设备都能伪造 M-SEARCH 应答，
 * 把 LOCATION 指向任意主机并在设备描述里声明任意 controlURL。过去 SOAP 直接拿调用方
 * 给的 controlUrl 当 POST 目标，于是伪造一份应答就能把 App 的 SOAP 指令（连同 SOAPACTION
 * 头）导向公网或内网任意端口 —— 一条 SSRF。这里把「什么样的主机与端口算合格目标」
 * 收成一份纯函数，发现与推送两条路共用，也才能在 JVM 单测里逐条验证。
 *
 * 规则：
 *  1. 只认 http/https，地址里不许带 userinfo；
 *  2. 端口必须是音频设备的常见端口（见 [ALLOWED_PORTS]），拒绝任意端口；
 *  3. 主机必须在局域网：IPv4 的私有段、IPv6 的 ULA / 链路本地，或 `.local` 的 mDNS 名字；
 *     公网地址、回环地址、0.0.0.0、组播一律拒绝；
 *  4. 设备自己声明的 controlURL 若是绝对地址，还必须与 LOCATION 同主机同段
 *     （见 [requireSameLanAs]）。
 *
 * 这里只做语法与网段判定，不解析 DNS（那样会引入一次出站请求，等于把 SSRF 换了个地方发）。
 */
internal object LanCastTargetPolicy {

    /** 允许的端口。DLNA 设备的控制端口基本落在这些值上；写死比「1..65535 全放」安全得多。 */
    val ALLOWED_PORTS = linkedSetOf(80, 443, 49152, 49153, 49154, 49155, 49156, 49157, 8080, 8443)

    /** 长度上限：设备描述里的路径不该有这么长，超了多半是伪造。 */
    private const val MAX_URL_LENGTH = 2048

    /**
     * 这个地址能不能作为投送目标。
     *
     * @param allowLoopback 只给「本机自己的转发服务」开的口子（投送时把控制指令发回自己）
     *   —— 目前没有任何调用方用它，参数留着是为了让调用方显式声明意图，不要隐式放行。
     * @throws IOException 不合格时抛出，消息直接可以给用户看。
     */
    @Throws(IOException::class)
    fun requireAllowedTarget(value: String?, what: String, allowLoopback: Boolean = false): URL {
        val url = parse(value, what)
        if (url.protocol != "http" && url.protocol != "https") throw IOException("$what 不是 http/https 地址")
        if (!url.userInfo.isNullOrEmpty()) throw IOException("$what 里不许带用户名密码")
        val effective = if (url.port == -1) url.defaultPort else url.port
        if (!ALLOWED_PORTS.contains(effective)) throw IOException("$what 的端口 ${effective} 不在允许范围")
        val host = url.host ?: throw IOException("$what 缺少主机")
        if (!isLanHost(host, allowLoopback)) throw IOException("$what 指向的不是局域网地址")
        return url
    }

    /**
     * 设备描述里声明的 controlURL 是否与 LOCATION 同主机同段。
     *
     * 允许「同网段另一台主机」：有些合规设备的 AVTransport 挂在同一台机器的另一个服务上，
     * 也有的把控制服务指向同段的桥接进程。不允许的是跨段、跨到公网。
     */
    @Throws(IOException::class)
    fun requireSameLanAs(target: URL, deviceUrl: URL) {
        val targetHost = target.host ?: throw IOException("控制地址缺少主机")
        val deviceHost = deviceUrl.host ?: throw IOException("设备地址缺少主机")
        if (targetHost.equals(deviceHost, ignoreCase = true)) return
        if (!sameLan(targetHost, deviceHost) && !sameMdnsSuffix(targetHost, deviceHost)) {
            throw IOException("控制地址与设备地址不在同一网段")
        }
    }

    /** 主机字符串是不是局域网地址（URL 的 host 可能带方括号，先剥掉）。 */
    fun isLanHost(rawHost: String, allowLoopback: Boolean = false): Boolean {
        val host = rawHost.trim().removePrefix("[").removeSuffix("]")
        if (host.isEmpty()) return false
        // 先把「看起来就不是 IP」的几种挡掉：这些解析成 InetAddress 会发 DNS 查询。
        if (host.endsWith(".local", ignoreCase = true)) return true
        val literal = parseLiteral(host) ?: return false
        return isLanAddress(literal, allowLoopback)
    }

    private fun parseLiteral(host: String): InetAddress? {
        // 只处理 IP 字面量：含字母又不是 IPv6 形态的一律当域名，不查 DNS。
        val looksV4 = host.count { it == '.' } == 3 && host.all { it.isDigit() || it == '.' }
        val looksV6 = host.contains(':')
        if (!looksV4 && !looksV6) return null
        return try {
            InetAddress.getByName(host)
        } catch (error: Exception) {
            null
        }
    }

    private fun isLanAddress(address: InetAddress, allowLoopback: Boolean): Boolean {
        if (address.isAnyLocalAddress || address.isMulticastAddress) return false
        if (address.isLoopbackAddress) return allowLoopback
        if (address.isLinkLocalAddress) return true
        if (address is Inet4Address) {
            val b = address.address
            val first = b[0].toInt() and 0xFF
            val second = b[1].toInt() and 0xFF
            // 10/8、172.16/12、192.168/16：RFC 1918 私有段。
            if (first == 10) return true
            if (first == 172 && second in 16..31) return true
            if (first == 192 && second == 168) return true
            // 100.64/10（运营商级 NAT）与 198.18/15（基准测试）也有人拿来做局域网，一并放行。
            if (first == 100 && second in 64..127) return true
            if (first == 198 && (second == 18 || second == 19)) return true
            return false
        }
        if (address is Inet6Address) {
            val b = address.address
            // fc00::/7（唯一本地地址）：合法家庭网络里音响唯一会用的 IPv6 段。
            val first = b[0].toInt() and 0xFE
            return first == 0xFC
        }
        return false
    }

    /** 两个 IP 字面量是否同段。IPv4 按 /24，IPv6 按 /64 —— 家用网络的实际粒度。 */
    private fun sameLan(a: String, b: String): Boolean {
        val left = parseLiteral(a.removePrefix("[").removeSuffix("]")) ?: return false
        val right = parseLiteral(b.removePrefix("[").removeSuffix("]")) ?: return false
        if (left.javaClass != right.javaClass) return false
        val leftBytes = left.address
        val rightBytes = right.address
        val keep = if (left is Inet4Address) 3 else 8
        for (index in 0 until keep) {
            if (leftBytes[index] != rightBytes[index]) return false
        }
        return true
    }

    /** 同一个 mDNS 后缀的 `.local` 名字也算同段（`livingroom.local` 与 `speaker.local`）。 */
    private fun sameMdnsSuffix(a: String, b: String): Boolean {
        val left = a.lowercase().trimEnd('.')
        val right = b.lowercase().trimEnd('.')
        if (!left.endsWith(".local") || !right.endsWith(".local")) return false
        // 只比较最后两段：`x.speaker.local` 与 `y.speaker.local` 同域。
        return left.substringAfterLast('.', "").let { suffix ->
            right.substringAfterLast('.', "") == suffix
                && left.substringBeforeLast('.').substringAfterLast('.') ==
                right.substringBeforeLast('.').substringAfterLast('.')
        }
    }

    private fun parse(value: String?, what: String): URL {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) throw IOException("缺少$what")
        if (text.length > MAX_URL_LENGTH) throw IOException("$what 过长")
        return try {
            URL(text)
        } catch (error: Exception) {
            throw IOException("$what 不是合法地址", error)
        }
    }
}
