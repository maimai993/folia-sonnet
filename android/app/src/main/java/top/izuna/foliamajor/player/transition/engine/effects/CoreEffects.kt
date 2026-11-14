package top.izuna.foliamajor.player.transition.engine.effects

import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.engine.BandGains
import top.izuna.foliamajor.player.transition.engine.BaseTransitionEffect
import top.izuna.foliamajor.player.transition.engine.EffectFrame
import top.izuna.foliamajor.player.transition.engine.EffectOutput

// 基础四接法：兜底、硬切、先出后进、平台混音。

/** 兜底：纯等功率交叉。听感签名是「一次淡入淡出」，没有平台、没有换手。 */
class PlainBlendEffect : BaseTransitionEffect(EffectId.PLAIN_BLEND) {
    override fun apply(frame: EffectFrame): EffectOutput = base(frame)
}

/**
 * 硬切：40 ms 内旧歌保持满音量、新歌静音，到点整条换过去。
 * 不是「两条斜坡跑得快」——那仍是淡入淡出，只是很短；切口要的是不重叠。
 */
class HardCutEffect : BaseTransitionEffect(EffectId.HARD_CUT) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        return if (frame.progress < 0.92f) {
            b.copy(incomingGain = 0f, outgoingGain = 1f)
        } else {
            b.copy(incomingGain = 1f, outgoingGain = 0f)
        }
    }
}

/**
 * 先出后进：前半段只淡出、留一小段呼吸，后半段只淡入。
 * 两段之间有一小截真静音，这是它和「短交叉淡化」的区别。
 */
class FadeOutInEffect : BaseTransitionEffect(EffectId.FADE_OUT_IN) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val p = frame.progress.coerceIn(0f, 1f)
        val b = base(frame)
        return when {
            p < 0.46f -> b.copy(incomingGain = 0f, outgoingGain = lerp(1f, 0f, p / 0.46f))
            p < 0.54f -> b.copy(incomingGain = 0f, outgoingGain = 0f)
            else -> b.copy(incomingGain = lerp(0f, 1f, (p - 0.54f) / 0.46f), outgoingGain = 0f)
        }
    }
}

/**
 * 平台混音：中段两曲等强（曲线已由 PLATEAU 把进度压在 0.5），低频在这段换手。
 * 这就是 DJ 动作「低频同一时刻只属于一方」，也是它不糊的原因。
 */
class PlateauBlendEffect : BaseTransitionEffect(EffectId.PLATEAU_BLEND) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        val swap = when {
            p < 0.42f -> BandGains(low = 0f, mid = 1f, high = 1f)
            p > 0.58f -> BandGains(low = 1f, mid = 1f, high = 1f)
            else -> BandGains(low = lerp(0f, 1f, (p - 0.42f) / 0.16f), mid = 1f, high = 1f)
        }
        val outLow = 1f - swap.low
        return b.copy(
            bandIn = swap,
            bandOut = BandGains(low = outLow, mid = 1f, high = 1f),
        )
    }
}
