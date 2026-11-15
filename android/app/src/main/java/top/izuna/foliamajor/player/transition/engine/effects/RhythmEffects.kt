package top.izuna.foliamajor.player.transition.engine.effects

import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.engine.BandGains
import top.izuna.foliamajor.player.transition.engine.BaseTransitionEffect
import top.izuna.foliamajor.player.transition.engine.EffectFrame
import top.izuna.foliamajor.player.transition.engine.EffectOutput

// 节奏三接法：都依赖 BeatGrid。没有拍点网格时 StyleChooser 不会选到它们，
// 这里也不做任何「假装对齐」的兜底。

/** 拍点切：与硬切同形，但落点由规划层对齐到小节线（切口仍是 40 ms）。 */
class BeatCutEffect : BaseTransitionEffect(EffectId.BEAT_CUT) {
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
 * 小节对齐：长度按 4 / 8 / 16 小节取整，重拍处低频换手。
 * 听感签名是「一直在，然后走掉」，而不是「自始至终连续下滑」。
 */
class BarAlignedBlendEffect : BaseTransitionEffect(EffectId.BAR_ALIGNED_BLEND) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        val inLow = lerp(0f, 1f, (p - 0.45f) / 0.12f)
        return b.copy(
            bandIn = BandGains(low = inLow, mid = 1f, high = 1f),
            bandOut = BandGains(low = 1f - inLow, mid = 1f, high = 1f),
        )
    }
}

/**
 * 变速对齐：只弯出场曲，绝不弯进场曲。
 * 进场曲即将被听三分钟，弯了它就得在它独自响着时把速度扳回来 —— 那是整段过渡中
 * 唯一没有东西可以遮掩的时刻。出场曲只剩几秒，没有未来可错。
 */
class TempoBendEffect : BaseTransitionEffect(EffectId.TEMPO_BEND) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        // 变速在过渡一开始就生效并维持到交接完成；出场曲随后被 release，不需要回速。
        return b.copy(
            tempoOut = frame.plan.stretch,
            bandIn = BandGains(low = lerp(0f, 1f, (frame.progress - 0.35f) / 0.3f), mid = 1f, high = 1f),
        )
    }
}
