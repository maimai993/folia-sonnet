package top.izuna.foliamajor.player.transition

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin

// android/app/src/main/java/top/izuna/foliamajor/player/transition/GainCurve.kt
// 增益曲线库：纯函数，不碰播放器、不碰 Handler，所以能直接跑 JVM 单测。
//
// 与旧 CrossfadeCurve.kt 的关系：那三条（equalPower / linear / fast）在这里保留同名同值，
// 老设置里的 crossfadeCurve 能原样读进来；新增的六条是「效果多样」的曲线维度。
// 旧文件不删，仍供 FoliaNativePlayer 的暂停淡入淡出使用 —— 那一处不需要整套曲线库。
//
// together（中段平台）见 Web 侧 README §6.5：淡出的听感签名是「出场曲自始至终连续下滑」，
// 混音的签名是「出场曲一直在，然后走掉」。平台让两曲在中段各停在 cos(π/4)=0.707，
// 低频在这一段换手。平台不消耗 headroom —— 它正落在 cos=sin 那一点，
// 中段合成功率与其它任何时刻相同。

enum class CurveId(val wire: String) {
    EQUAL_POWER("equalPower"),
    LINEAR("linear"),
    FAST_CUT("fast"),
    SLOW_START("slowStart"),
    S_CURVE("sCurve"),
    EXPONENTIAL("exponential"),
    LOGARITHMIC("logarithmic"),
    ASYMMETRIC("asymmetric"),
    PLATEAU("plateau"),
    ;

    companion object {
        private val BY_WIRE = values().associateBy { it.wire }
        fun fromWire(value: String?): CurveId = value?.let { BY_WIRE[it] } ?: EQUAL_POWER
    }
}

object GainCurve {

    private val HALF_PI = (PI / 2.0).toFloat()
    private const val EXP_K = 3.0f
    private const val LOG_K = 9.0f
    private val LOG_DENOM = ln(1.0 + LOG_K.toDouble()).toFloat()
    private val EXP_DENOM = exp(EXP_K.toDouble()).toFloat() - 1f

    /** 进场曲在 [progress] 处的音量 0..1。 */
    fun incoming(id: CurveId, progress: Float, together: Float = 0f): Float =
        shapeIn(id, remap(progress, together, id)).coerceIn(0f, 1f)

    /** 出场曲在 [progress] 处的音量 0..1。 */
    fun outgoing(id: CurveId, progress: Float, together: Float = 0f): Float =
        shapeOut(id, remap(progress, together, id)).coerceIn(0f, 1f)

    /**
     * 中段平台：把进度里 [start, end] 这一段压成固定的 0.5。
     * 左右两段线性压缩到 [0,0.5] / [0.5,1]，所以曲线仍然连续、首尾仍落在 0 / 1。
     */
    private fun remap(progress: Float, together: Float, id: CurveId): Float {
        val p = progress.coerceIn(0f, 1f)
        // PLATEAU 自己就带平台，哪怕调用方没传 together 也给一个，否则它退化成等功率。
        val requested = if (id == CurveId.PLATEAU) kotlin.math.max(together, 0.5f) else together
        if (requested <= 0f) return p
        val plateau = requested.coerceIn(0f, 0.8f)
        val side = (1f - plateau) * 0.5f
        if (side <= 0f) return 0.5f
        val start = side
        val end = 1f - side
        return when {
            p <= start -> p * 0.5f / side
            p >= end -> 0.5f + (p - end) * 0.5f / side
            else -> 0.5f
        }
    }

    private fun smoothstep(p: Float): Float = p * p * (3f - 2f * p)

    private fun shapeIn(id: CurveId, p: Float): Float = when (id) {
        CurveId.EQUAL_POWER, CurveId.PLATEAU -> sin(p * HALF_PI)
        CurveId.LINEAR -> p
        CurveId.FAST_CUT -> 1f - (1f - p) * (1f - p)
        CurveId.SLOW_START -> p * p
        CurveId.S_CURVE -> smoothstep(p)
        CurveId.EXPONENTIAL -> (exp(EXP_K * p) - 1f) / EXP_DENOM
        CurveId.LOGARITHMIC -> ln(1.0 + LOG_K * p.toDouble()).toFloat() / LOG_DENOM
        CurveId.ASYMMETRIC -> p.toDouble().pow(0.6).toFloat()
    }

    private fun shapeOut(id: CurveId, p: Float): Float = when (id) {
        CurveId.EQUAL_POWER, CurveId.PLATEAU -> cos(p * HALF_PI)
        CurveId.LINEAR -> 1f - p
        CurveId.FAST_CUT -> (1f - p) * (1f - p)
        CurveId.SLOW_START -> 1f - p * p
        CurveId.S_CURVE -> 1f - smoothstep(p)
        CurveId.EXPONENTIAL -> 1f - (exp(EXP_K * p) - 1f) / EXP_DENOM
        CurveId.LOGARITHMIC -> 1f - ln(1.0 + LOG_K * p.toDouble()).toFloat() / LOG_DENOM
        CurveId.ASYMMETRIC -> (1f - p).toDouble().pow(1.6).toFloat()
    }

    /**
     * 等功率校核：两条等功率曲线的平方和恒为 1（中点各 0.707）。
     * 单测直接断言它，防止以后有人「顺手」把 sin/cos 改成两条直线。
     */
    fun equalPowerSum(id: CurveId, progress: Float): Float {
        val i = incoming(id, progress)
        val o = outgoing(id, progress)
        return i * i + o * o
    }
}
