package top.izuna.foliamajor.player

import kotlin.math.cos
import kotlin.math.sin

// android/app/src/main/java/top/izuna/foliamajor/player/CrossfadeCurve.kt
// 交叉淡化的音量曲线：纯函数，不碰播放器、不碰 Handler，所以能直接单测。
//
// 为什么需要它：两首歌重叠时，音量不是简单的「一个升一个降」。两条都走直线的话，
// 中点处各是 0.5，合成功率只有一半（-3 dB），听感就是过渡中间「塌一下」再起来 ——
// 这是线性交叉的固有问题，不是错觉。
//
// 三条曲线：
//   · 等功率（默认）：sin / cos，两者平方和恒为 1，中点各 0.707，功率不塌。
//   · 线性：两条直线，旧行为。留着是为了能 A/B 出那 3 dB 的差别确实来自这里。
//   · 快切：1-(1-p)² 与 (1-p)²，先快后慢，更早完成交接，缩短「两首同时明显可闻」的时间。
//
// 名字与 Web 侧 `CROSSFADE_CURVES`（src/services/automix/crossfadePlanner.ts）一一对应，
// 改一边要改另一边。

object CrossfadeCurve {

    const val EQUAL_POWER = 0
    const val LINEAR = 1
    const val FAST = 2

    /** 弧度制的 π/2：progress 0..1 映射到 0..π/2。 */
    private val HALF_PI = (Math.PI / 2).toFloat()

    /**
     * 设置里存的名字 → 曲线编号。
     *
     * 认不出来的一律回等功率：过渡正在跑的时候改这一项，不该把音量抛到别处去。
     */
    fun fromName(name: String?): Int = when (name) {
        "linear" -> LINEAR
        "fast" -> FAST
        else -> EQUAL_POWER
    }

    /** 进来的那首在 [progress] 处的音量（0..1）。 */
    fun incoming(curve: Int, progress: Float): Float {
        val p = progress.coerceIn(0f, 1f)
        return when (curve) {
            LINEAR -> p
            FAST -> 1f - (1f - p) * (1f - p)
            else -> sin(p * HALF_PI)
        }
    }

    /** 出去的那首在 [progress] 处的音量（0..1）。 */
    fun outgoing(curve: Int, progress: Float): Float {
        val p = progress.coerceIn(0f, 1f)
        return when (curve) {
            LINEAR -> 1f - p
            FAST -> (1f - p) * (1f - p)
            else -> cos(p * HALF_PI)
        }
    }
}
