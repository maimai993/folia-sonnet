package top.izuna.foliamajor.player

import java.util.concurrent.atomic.AtomicLong

// 播放器代数门：旧播放器（已释放 / 已被新插件实例取代）的事件与释放回调不得污染新播放器的全局桌面歌词状态（#314）。
// 这里同时承担「跨代清理」(#H8)：写入受代数门禁，清理不受 —— 旧一代留下的全局状态由新一代负责收。

/**
 * 每建一个播放器取一个新代数；只有仍是当前代数的一方才能**写**全局状态。线程安全。
 *
 * 两件事分开：
 * - **写**（[isCurrent] / [runIfCurrent]）：旧代的迟到事件不许改全局状态。
 * - **清理**（[advance] 的返回值、[clearForRetiredGeneration]）：旧代可能停在「stalled」里就走了，
 *   它排队的清理回调会因为代数过期被 [runIfCurrent] 挡下，于是没人清这条状态。所以清理
 *   **不能**跟写共用一道门禁：推进代数的一侧无条件清一次，新版装上源时再清一次。
 */
internal class PlayerGeneration {
    private val current = AtomicLong(0L)

    /**
     * 新播放器创建时调用，返回它的代数；此后更早的代数全部失效。
     *
     * 调用方拿到返回值之后必须无条件做一次跨代清理 —— 这就是「旧代停在哪、谁负责收」的答案：
     * 旧代的清理回调会被门禁挡下，而这里已经没有门禁了。
     */
    fun advance(): Long = current.incrementAndGet()

    fun isCurrent(generation: Long): Boolean = current.get() == generation

    /**
     * 仅当 [generation] 仍是当前代数时执行 [block]；返回是否执行。
     *
     * 返回值只在真的需要知道「这次写有没有落地」时接，例如日志 / 诊断。清理**不要**走这里：
     * 用 [clearForRetiredGeneration]。
     */
    inline fun runIfCurrent(generation: Long, block: () -> Unit): Boolean {
        if (!isCurrent(generation)) return false
        block()
        return true
    }

    /**
     * 跨代清理：不管调用来自哪一代，无条件执行一次。
     *
     * 只该放「清掉上一代留下的全局状态」这类动作。写成单独一个函数是为了让调用点一眼看出
     * 这是**清理**而不是**写入** —— 上一版的漏洞正是两者共用 `runIfCurrent`，清理被门禁挡掉。
     */
    inline fun clearForRetiredGeneration(block: () -> Unit) {
        block()
    }
}
