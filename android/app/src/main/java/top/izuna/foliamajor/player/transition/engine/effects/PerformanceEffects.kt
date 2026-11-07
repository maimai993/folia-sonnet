package top.izuna.foliamajor.player.transition.engine.effects

import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.engine.BandGains
import top.izuna.foliamajor.player.transition.engine.BaseTransitionEffect
import top.izuna.foliamajor.player.transition.engine.EffectFrame
import top.izuna.foliamajor.player.transition.engine.EffectOutput
import kotlin.math.pow

// 表现四接法：最「抢耳」的一档。强度只由测量决定（plan.expansion / plan.intensity），
// 「要不要做」由设置决定 —— 这条分界沿用 Web 侧 README §6.7，避免把表现模式做成随机特效。

/**
 * Build-up：在交接点前按拍叠加抽拉 / 升调 / 甩盘的 riser 样本，
 * 到交接那一刻收掉。riserLevel 交给 TransitionDspProcessor 渲染成实际样本。
 */
class BuildUpEffect : BaseTransitionEffect(EffectId.BUILD_UP) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        val strength = (frame.plan.expansion ?: 0.5f) * frame.plan.intensity
        // 前 85% 一路爬升，最后 15% 立刻收掉（drop）。
        val riser = if (p < 0.85f) (p / 0.85f).toDouble().pow(1.6).toFloat() else 0f
        return b.copy(
            riserLevel = strength * riser,
            lowPassInHz = 20_000f * (0.35f + 0.65f * p),
        )
    }
}

/** 升调跌落：riser 爬到 0.85，然后进场曲第一拍整条落下。 */
class RiserDropEffect : BaseTransitionEffect(EffectId.RISER_DROP) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        val strength = (frame.plan.expansion ?: 0.75f) * frame.plan.intensity
        val riser = if (p < 0.85f) (p / 0.85f).toDouble().pow(2.0).toFloat() else 0f
        val gain = if (p < 0.85f) 0f else 1f
        return b.copy(
            incomingGain = gain,
            outgoingGain = if (p < 0.85f) 1f else 0f,
            riserLevel = strength * riser,
        )
    }
}

/**
 * 甩盘刹车：出场曲速度一路下行 + 低通下扫，像把唱片按住。
 * 这是唯一一个会显著改变 tempoOut 的表现效果，且只作用于即将被释放的出场曲。
 */
class VinylBrakeEffect : BaseTransitionEffect(EffectId.VINYL_BRAKE) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        return b.copy(
            tempoOut = lerp(1f, 0.35f, p.toDouble().pow(1.4).toFloat()),
            lowPassOutHz = 20_000f * Math.pow(320.0 / 20_000.0, p.toDouble()).toFloat(),
            bandOut = BandGains(low = 1f, mid = lerp(1f, 0.4f, p), high = lerp(1f, 0.15f, p)),
        )
    }
}

/**
 * 反向渐显：进场曲用反向包络渐显，高频先到、低频后到；出场曲留一条渐弱镜像。
 * 适合氛围 / ambient，不追求节奏冲击。
 */
class ReverseCrescendoEffect : BaseTransitionEffect(EffectId.REVERSE_CRESCENDO) {
    override fun apply(frame: EffectFrame): EffectOutput {
        val b = base(frame)
        val p = frame.progress.coerceIn(0f, 1f)
        val rise = (1f - (1f - p) * (1f - p))
        return b.copy(
            incomingGain = rise,
            outgoingGain = 1f - rise,
            bandIn = BandGains(
                low = lerp(0f, 1f, (p - 0.35f) / 0.65f),
                mid = lerp(0f, 1f, (p - 0.15f) / 0.85f),
                high = rise,
            ),
            reverbTail = 0.3f * bell(p),
        )
    }
}
