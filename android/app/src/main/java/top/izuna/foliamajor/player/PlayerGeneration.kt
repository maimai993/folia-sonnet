package top.izuna.foliamajor.player

import java.util.concurrent.atomic.AtomicLong

// 播放器代数门：旧播放器（已释放 / 已被新插件实例取代）的事件与释放回调不得污染新播放器的全局桌面歌词状态（#314）。
/** 每建一个播放器取一个新代数；只有仍是当前代数的一方才能写全局状态。线程安全。 */
internal class PlayerGeneration {
    private val current = AtomicLong(0L)

    /** 新播放器创建时调用，返回它的代数；此后更早的代数全部失效。 */
    fun advance(): Long = current.incrementAndGet()

    fun isCurrent(generation: Long): Boolean = current.get() == generation

    /** 仅当 [generation] 仍是当前代数时执行 [block]；返回是否执行。 */
    inline fun runIfCurrent(generation: Long, block: () -> Unit): Boolean {
        if (!isCurrent(generation)) return false
        block()
        return true
    }
}
