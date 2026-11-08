package top.izuna.foliamajor.player.transition

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.roundToLong

// android/app/src/main/java/top/izuna/foliamajor/player/transition/MusicalTime.kt
// 音乐单位：拍 / 小节 / 乐句取整、两曲速度关系、入场点对齐。
// 纯算术，对应 Web 侧 automix/musicalTime.ts，但不含任何 DOM / Web Audio 依赖。

enum class TempoRelation(val wire: String) {
    LOCKED("locked"),
    NEAR("near"),
    STRETCHABLE("stretchable"),
    DRIFTING("drifting"),
    FAR("far"),
    UNKNOWN("unknown"),
}

object MusicalTime {

    /** 变速上限：伸缩器涂抹感的边界，且需远离谐波比值。 */
    const val STRETCH_LIMIT = 0.12f
    /** 重叠上限：最短 blend 为 4 拍，漂满一整拍就从「没对齐」变成「打架」。 */
    const val DRIFT_LIMIT = 0.25f
    /** 硬切切口。 */
    const val BEAT_CUT_MS = 40L
    const val DEFAULT_BEATS_PER_BAR = 4

    fun beatMs(bpm: Float): Float = if (bpm > 0f) 60_000f / bpm else 0f

    fun barMs(bpm: Float, beatsPerBar: Int = DEFAULT_BEATS_PER_BAR): Float =
        beatMs(bpm) * beatsPerBar.coerceAtLeast(1)

    fun phraseMs(bpm: Float, bars: Int = 4, beatsPerBar: Int = DEFAULT_BEATS_PER_BAR): Float =
        barMs(bpm, beatsPerBar) * bars.coerceAtLeast(1)

    /**
     * 二倍速等价：70 与 140 BPM 是同一个网格，只是数拍的方式不同。
     * 把比值折回 [0.75, 1.5] 再比较，否则「半速」会被误判成 FAR。
     */
    fun foldOctave(ratio: Float): Float {
        if (ratio <= 0f || !ratio.isFinite()) return 1f
        var r = ratio
        var guard = 0
        while (r > 1.5f && guard++ < 16) r /= 2f
        guard = 0
        while (r < 0.75f && guard++ < 16) r *= 2f
        return r
    }

    /**
     * 两曲速度关系。判据与 Web 侧一致：能弯到一起（≤12%）与能叠在一起（≤25%）
     * 是两个阈值，中间那段叫 drifting —— 不变速，但照常重叠，只是较短。
     */
    fun relation(fromBpm: Float?, toBpm: Float?): TempoRelation {
        if (fromBpm == null || toBpm == null || fromBpm <= 0f || toBpm <= 0f) {
            return TempoRelation.UNKNOWN
        }
        val diff = abs(1f - foldOctave(toBpm / fromBpm))
        return when {
            diff <= 0.02f -> TempoRelation.LOCKED
            diff <= 0.06f -> TempoRelation.NEAR
            diff <= STRETCH_LIMIT -> TempoRelation.STRETCHABLE
            diff <= DRIFT_LIMIT -> TempoRelation.DRIFTING
            else -> TempoRelation.FAR
        }
    }

    /**
     * 把出场曲的速度弯向进场曲，只弯出场曲，且不超过 ±12%。
     * 返回出场曲应设的 playbackRate（1 = 不变速）。
     */
    fun outgoingStretch(fromBpm: Float?, toBpm: Float?): Float {
        if (fromBpm == null || toBpm == null || fromBpm <= 0f || toBpm <= 0f) return 1f
        if (relation(fromBpm, toBpm) != TempoRelation.STRETCHABLE) return 1f
        val ratio = foldOctave(toBpm / fromBpm)
        return ratio.coerceIn(1f - STRETCH_LIMIT, 1f + STRETCH_LIMIT)
    }

    /** 下一个 [bars] 小节线的绝对时间（毫秒）。没有网格时原样返回。 */
    fun nextBarBoundary(
        positionMs: Long,
        bpm: Float,
        beatsPerBar: Int = DEFAULT_BEATS_PER_BAR,
        bars: Int = 1,
    ): Long {
        val unit = barMs(bpm, beatsPerBar) * bars.coerceAtLeast(1)
        if (unit <= 0f || !unit.isFinite()) return positionMs
        val n = ceil(positionMs.toDouble() / unit.toDouble()).toLong()
        return (n * unit.toDouble()).roundToLong()
    }

    /** 下一个拍点。 */
    fun nextBeatBoundary(positionMs: Long, bpm: Float): Long {
        val unit = beatMs(bpm)
        if (unit <= 0f || !unit.isFinite()) return positionMs
        val n = ceil(positionMs.toDouble() / unit.toDouble()).toLong()
        return (n * unit.toDouble()).roundToLong()
    }

    /**
     * 把一段任意毫秒数按小节取整（向上），并夹在 [min, max] 里。
     * 这是「按 8 小节接」而不是「按 5 秒接」的关键。
     */
    fun snapToBars(
        durationMs: Int,
        bpm: Float,
        minMs: Int,
        maxMs: Int,
        beatsPerBar: Int = DEFAULT_BEATS_PER_BAR,
    ): Int {
        val bar = barMs(bpm, beatsPerBar)
        if (bar <= 0f) return durationMs.coerceIn(minMs, maxMs)
        val bars = ceil(durationMs.toDouble() / bar.toDouble()).toLong().coerceAtLeast(1)
        // 优先 4 / 8 / 16 小节，听感上比 5 小节自然。
        val musical = listOf(1L, 2L, 4L, 8L, 16L).firstOrNull { it >= bars } ?: 16L
        return (musical * bar.toDouble()).roundToLong().toInt().coerceIn(minMs, maxMs)
    }

    /** 入场点对齐：让进场曲的第 [bars] 小节线落在出场曲的交接点上。 */
    fun alignInStart(
        inStartMs: Long,
        toBpm: Float?,
        beatsPerBar: Int = DEFAULT_BEATS_PER_BAR,
    ): Long {
        val bpm = toBpm ?: return inStartMs
        val bar = barMs(bpm, beatsPerBar)
        if (bar <= 0f) return inStartMs
        return ((inStartMs / bar).toLong() * bar.toDouble()).roundToLong()
    }
}
