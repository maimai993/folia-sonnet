package top.izuna.foliamajor.player.transition.engine.effects

import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.engine.BandGains
import top.izuna.foliamajor.player.transition.engine.BaseTransitionEffect
import top.izuna.foliamajor.player.transition.engine.EffectFrame
import top.izuna.foliamajor.player.transition.engine.EffectOutput

// 频段四接法：这些是原生 PCM 链才做得出来的 —— WebView 里被 Web Audio 节点数量与
// 降级策略限制，Android 里直接复用 player/dsp/BiquadFilter 做三段分频。

/** 低频换手：整段重叠，但 250 Hz 以下同一时刻只属于一方。 */
class BassSwapEffect : BaseTransitionEffect(EffectId.BASS_SWAP) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        // 换手窗口压在平台中段，两侧留出过渡带，避免低频「咔」一下跳过去。
        val inLow = lerp(0f, 1f, (p - 0.40f) / 0.20f)
        return b.copy(
            bandIn = BandGains(low = inLow, mid = 1f, high = 1f),
            bandOut = BandGains(low = 1f - inLow, mid = 1f, high = 1f),
        )
    }
}

/**
 * 三频段接缝：高 / 中 / 低分三段错时交接。
 * 高频先换（人耳最敏感，先让出空间），低频最后换（保持地基不塌）。
 */
class ThreeBandSeamEffect : BaseTransitionEffect(EffectId.THREE_BAND_SEAM) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        fun ramp(start: Float, end: Float): Float = lerp(0f, 1f, (p - start) / (end - start))
        val high = ramp(0.18f, 0.48f)
        val mid = ramp(0.34f, 0.68f)
        val low = ramp(0.52f, 0.86f)
        return b.copy(
            bandIn = BandGains(low = low, mid = mid, high = high),
            bandOut = BandGains(low = 1f - low, mid = 1f - mid, high = 1f - high),
        )
    }
}

/**
 * 滤波扫入：进场曲从闷住的低通一路扫到全频，出场曲反向被低通吃掉。
 * 扫频用指数映射（听感上比线性均匀），两端都不碰增益曲线以外的东西。
 */
class FilterSweepInEffect : BaseTransitionEffect(EffectId.FILTER_SWEEP_IN) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        val inHz = 320f * Math.pow(20_000.0 / 320.0, p.toDouble()).toFloat()
        val outHz = 20_000f * Math.pow(600.0 / 20_000.0, p.toDouble()).toFloat()
        return b.copy(
            lowPassInHz = inHz.coerceIn(320f, 20_000f),
            lowPassOutHz = outHz.coerceIn(600f, 20_000f),
        )
    }
}

/**
 * 人声退场（需增强包）：出场曲中频凹陷让人声先走，其余频段继续垫着进场曲。
 * 凹陷深度随强度走，且只在过渡前 2/3 生效 —— 尾段要把中频还回去，
 * 否则出场曲会突然变成「只剩低音和高音」的空壳。
 */
class VocalRecedeEffect : BaseTransitionEffect(EffectId.VOCAL_RECEDE) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        val notch = 1f - 0.55f * frame.plan.intensity * bell((p / 0.7f).coerceAtMost(1f))
        return b.copy(
            bandOut = BandGains(low = 1f, mid = notch, high = 1f),
            bandIn = BandGains(low = 1f, mid = lerp(0.7f, 1f, p), high = 1f),
        )
    }
}
