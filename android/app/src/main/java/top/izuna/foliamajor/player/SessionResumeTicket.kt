package top.izuna.foliamajor.player

// 只随 Web prepare 绑到实际 MediaItem；系统装源不会继承。只在播放器线程读写。
internal class SessionResumeTicket(private val sourceToken: String) {
    private var valid = true

    fun cancel() { valid = false }

    fun take(actualKey: String, expectedKey: String, expectedToken: String): Boolean {
        if (!valid || actualKey != expectedKey || expectedToken != sourceToken) return false
        cancel()
        return true
    }
}
