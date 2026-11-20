package top.izuna.foliamajor

import java.security.SecureRandom
import java.util.Locale

/**
 * 投送期间的局域网音频租约。
 *
 * 为什么要有它：投送时 LocalAudioServer 会对局域网开放 `/remote-audio/` 这一路，而过去的
 * 准入只有一个全局布尔加路径前缀 —— 同网段任何设备（访客、被入侵的 IoT）拿到或猜到 URL
 * 就能拉走正在投送的音频字节，而且收回只靠 Web 层一处调用。
 *
 * 现在改成「带截止时间的一次性租约」：
 *  - 开租约时生成一个高熵的 pairCode 和一个「局域网只读令牌」；
 *  - 音响按 pairCode 来 `GET /remote-audio/...`，路径里的 token 必须正是本次租约签发的
 *    那一个（其它会话注册的 token 一律不认）；
 *  - 租约到期自动作废，收回（release）立即作废；
 *  - 租约登记永远保存在进程内存里：进程重启后旧 URL 自然失效。
 *
 * 这个类只做纯判定，不碰 socket 与 Android，方便在 JVM 单测里逐条验证。
 */
class LanCastLeaseRegistry(
    private val random: SecureRandom = SecureRandom(),
    /** 默认租约时长。长到能放完一首歌，短到中途出事也不至于一直开着。 */
    private val leaseMillis: Long = DEFAULT_LEASE_MS,
) {
    companion object {
        /** 一次开闸默认 3 小时：足够放完一整张专辑，没人续就会自己关。 */
        const val DEFAULT_LEASE_MS = 3L * 60 * 60 * 1000

        /** pairCode 的字符集：去掉了容易看混的 0/O/1/I，配对时要念给用户听。 */
        private const val PAIR_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679"
        private const val PAIR_LENGTH = 8

        /** 令牌长度（字节）。26 字节 base32 编出来 40+ 个字符，穷举不可行。 */
        private const val TOKEN_BYTES = 26

        /** 签发出来的局域网令牌前缀，便于日志里一眼认出来，也避免与普通 UUID 混淆。 */
        const val LAN_TOKEN_PREFIX = "lc-"
    }

    /** 一条租约。[pairCode] 给人看，[lanToken] 是音响要带上的凭证。 */
    class Lease(val pairCode: String, val lanToken: String, val expiresAtMillis: Long) {
        fun isExpired(nowMillis: Long): Boolean = nowMillis >= expiresAtMillis
    }

    private var active: Lease? = null

    /** 当前有效的租约，过期即清。 */
    @Synchronized
    fun current(nowMillis: Long = System.currentTimeMillis()): Lease? {
        val lease = active ?: return null
        if (lease.isExpired(nowMillis)) {
            active = null
            return null
        }
        return lease
    }

    /**
     * 续期或新开。已有未过期的租约时复用同一对凭证并顺延截止时间：
     * 切歌、换音响时 Web 层会反复 prepare，每次都换 token 会让音响手上那份立刻失效。
     */
    @Synchronized
    fun ensure(nowMillis: Long = System.currentTimeMillis()): Lease {
        val existing = current(nowMillis)
        if (existing != null) {
            val renewed = Lease(existing.pairCode, existing.lanToken, nowMillis + leaseMillis)
            active = renewed
            return renewed
        }
        val lease = Lease(newPairCode(), newLanToken(), nowMillis + leaseMillis)
        active = lease
        return lease
    }

    /** 收回：之后的局域网请求一律拒绝。 */
    @Synchronized
    fun release() {
        active = null
    }

    /**
     * 这次局域网请求能不能拿字节。
     *
     * 两条同时成立才放行：租约有效、路径里的 token 正是本次租约签发的。
     * 来源判断（局域网、非浏览器页面）在 HTTP 层，见 LocalAudioServer.handle。
     */
    @Synchronized
    fun admitsLanToken(token: String, nowMillis: Long = System.currentTimeMillis()): Boolean {
        val lease = current(nowMillis) ?: return false
        return constantTimeEquals(lease.lanToken, token)
    }

    private fun newPairCode(): String {
        val builder = StringBuilder(PAIR_LENGTH)
        repeat(PAIR_LENGTH) { builder.append(PAIR_ALPHABET[random.nextInt(PAIR_ALPHABET.length)]) }
        return builder.toString()
    }

    private fun newLanToken(): String {
        val bytes = ByteArray(TOKEN_BYTES)
        random.nextBytes(bytes)
        return LAN_TOKEN_PREFIX + base32(bytes)
    }

    /** RFC 4648 的 base32（去掉填充），只用小写字母与数字，方便塞进 URL。 */
    private fun base32(bytes: ByteArray): String {
        val alphabet = "abcdefghijklmnopqrstuvwxyz234567"
        val builder = StringBuilder((bytes.size * 8 + 4) / 5)
        var buffer = 0
        var bits = 0
        for (byte in bytes) {
            buffer = (buffer shl 8) or (byte.toInt() and 0xFF)
            bits += 8
            while (bits >= 5) {
                builder.append(alphabet[(buffer shr (bits - 5)) and 0x1F])
                bits -= 5
            }
        }
        if (bits > 0) builder.append(alphabet[(buffer shl (5 - bits)) and 0x1F])
        return builder.toString().lowercase(Locale.ROOT)
    }

    /** 比较凭证时不要提前返回：让耗时与「第几个字符不同」无关。 */
    private fun constantTimeEquals(left: String, right: String): Boolean {
        if (left.length != right.length) return false
        var diff = 0
        for (index in left.indices) diff = diff or (left[index].code xor right[index].code)
        return diff == 0
    }
}
