package top.izuna.foliamajor.player.transition.engine.effects

import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.engine.BaseTransitionEffect
import top.izuna.foliamajor.player.transition.engine.EffectFrame
import top.izuna.foliamajor.player.transition.engine.EffectOutput

// 空间三接法：把「断口」和「尾巴」交给延迟 / 混响，而不是靠音量斜坡硬盖。

/**
 * 尾巴骑行：长重叠，进场曲从出场曲的衰减尾巴底下缓慢浮上来。
 * 出场曲不是一路下滑 —— 前 60% 几乎保持，最后才走，这是它与淡出的区别。
 */
class TailRideEffect : BaseTransitionEffect(EffectId.TAIL_RIDE) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        val rideOut = if (p < 0.6f) lerp(1f, 0.85f, p / 0.6f) else lerp(0.85f, 0f, (p - 0.6f) / 0.4f)
        val riseIn = p * p * (3f - 2f * p) // smoothstep，浮起来而不是跳起来
        return b.copy(incomingGain = riseIn, outgoingGain = rideOut)
    }
}

/**
 * 回声抛掷：出场曲快速让出干声，同时被抛进延迟反馈里衰减。
 * echoMix 是 0→1→0 的钟形，避免尾巴一直挂在场上盖住进场曲。
 */
class EchoThrowEffect : BaseTransitionEffect(EffectId.ECHO_THROW) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        return b.copy(
            echoMix = 0.55f * frame.plan.intensity * bell(p),
            reverbTail = 0.2f * bell(p),
        )
    }
}

/**
 * 混响尾延续：复用已有 ReverbStage 的尾巴，出场曲断开时把空间感带过交接点。
 * 不需要 DSP 分频，因此在不支持 processor 的机型上也能用（对应 capabilities.dspChain=false）。
 */
class ReverbCarryEffect : BaseTransitionEffect(EffectId.REVERB_CARRY) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        return b.copy(reverbTail = 0.65f * frame.plan.intensity * bell(p))
    }
}
