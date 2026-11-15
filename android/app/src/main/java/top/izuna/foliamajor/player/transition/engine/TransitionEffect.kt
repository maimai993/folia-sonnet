package top.izuna.foliamajor.player.transition.engine

import top.izuna.foliamajor.player.transition.EffectId
import top.izuna.foliamajor.player.transition.GainCurve
import top.izuna.foliamajor.player.transition.TrackProfile
import top.izuna.foliamajor.player.transition.TransitionPlan

// android/app/src/main/java/top/izuna/foliamajor/player/transition/engine/TransitionEffect.kt
// 执行层契约：一次过渡的每一拍，效果只需要回答「两台播放器 + DSP 链这一帧该是什么状态」。
//
// 效果不碰 ExoPlayer、不碰 Handler、不碰线程 —— 全是纯函数，可 JVM 单测。
// 新增一种接法 = 新建一个 TransitionEffect 实现 + 在 EffectRegistry 注册一行，
// 规划层与播放器一行不改（与 Web 侧 README §5 的纪律一致）。

data class BandGains(val low: Float = 1f, val mid: Float = 1f, val high: Float = 1f) {
    companion object { val UNIT = BandGains() }
}

/** 一帧的输入。progress 0..1 由 TransitionEngine 按墙钟给出。 */
data class EffectFrame(
    val progress: Float,
    val elapsedMs: Long,
    val totalMs: Int,
    val plan: TransitionPlan,
    val from: TrackProfile? = null,
    val to: TrackProfile? = null,
)

/** 一帧的输出。0 表示该滤波器不启用。 */
data class EffectOutput(
    val incomingGain: Float,
    val outgoingGain: Float,
    val bandIn: BandGains = BandGains.UNIT,
    val bandOut: BandGains = BandGains.UNIT,
    val lowPassInHz: Float = 0f,
    val highPassInHz: Float = 0f,
    val lowPassOutHz: Float = 0f,
    val highPassOutHz: Float = 0f,
    val echoMix: Float = 0f,
    val reverbTail: Float = 0f,
    val tempoOut: Float = 1f,
    val tiltDbIn: Float = 0f,
    val riserLevel: Float = 0f,
    val limiterDrive: Float = 1f,
) {
    val needsDsp: Boolean
        get() = bandIn != BandGains.UNIT || bandOut != BandGains.UNIT
            || lowPassInHz > 0f || highPassInHz > 0f
            || lowPassOutHz > 0f || highPassOutHz > 0f
            || echoMix > 0f || reverbTail > 0f || tiltDbIn != 0f || riserLevel > 0f
}

interface TransitionEffect {
    val id: EffectId
    fun apply(frame: EffectFrame): EffectOutput
}

/**
 * 所有效果的起点：按 plan 的曲线算出两条增益，再把计划里已有的音色 / 变速 / 空间参数带上。
 * 子类只覆写自己要改的那几项，避免每个效果都重复一遍曲线逻辑。
 */
abstract class BaseTransitionEffect(override val id: EffectId) : TransitionEffect {

    protected fun base(frame: EffectFrame): EffectOutput {
        val p = frame.progress.coerceIn(0f, 1f)
        val plan = frame.plan
        val incoming = GainCurve.incoming(plan.curve, p, plan.together)
        val outgoing = GainCurve.outgoing(plan.curve, p, plan.together)
        return EffectOutput(
            incomingGain = incoming,
            outgoingGain = outgoing,
            tempoOut = plan.stretch,
            tiltDbIn = plan.tiltDb,
            limiterDrive = 1f + 0.15f * plan.intensity,
        )
    }

    /** 常用插值：从 a 线性走到 b。 */
    protected fun lerp(a: Float, b: Float, p: Float): Float = a + (b - a) * p.coerceIn(0f, 1f)

    /** 平滑开关：0→1→0 的钟形，用于手势 / 扫频。 */
    protected fun bell(p: Float): Float {
        val x = p.coerceIn(0f, 1f).toDouble()
        return kotlin.math.sin(x * Math.PI).toFloat()
    }
}
