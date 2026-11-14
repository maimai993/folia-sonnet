package top.izuna.foliamajor.player.dsp

import kotlin.math.abs
import kotlin.math.pow

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/DspMath.kt
// 几个 DSP 阶段共用的算式与常量。
//
// 抽出来的理由不是「看着更短」，而是同一件事已经写了好几遍：
//   · 块长原先在 EqAudioProcessor、MultibandCompressor、LookaheadLimiter 里各定义一次，
//     改一处漏两处就会变成「包络按 128 更新、限幅器按 256 切片」这种查起来极费劲的错位；
//   · 软拐点曲线在 punch 与多段压缩里逐字重复，两者本该是**同一条**曲线；
//   · 块内增益斜坡有三处，任何一处写法不同都会让某一段单独出咔哒声。

/**
 * 处理块长（帧）。
 *
 * 与 Web Audio 的 render quantum 一致：包络每块更新一次、系数每块重算一次，
 * 听感才和网页端对得上。改这个值要同时看三处依赖：
 *   · [EqAudioProcessor] 按它切块；
 *   · [MultibandCompressor] 用它的秒数换算包络系数；
 *   · [LookaheadLimiter] 的延迟下限必须大于它，否则当前块会覆盖还没输出的样本。
 */
internal const val DSP_BLOCK_FRAMES = 128

/** 交错样本里的最大绝对值。注意 [offset] 与 [count] 都是**样本**下标，不是帧。 */
internal fun peakOf(buffer: FloatArray, offset: Int, count: Int): Float {
    var peak = 0f
    val end = offset + count
    var index = offset
    while (index < end) {
        val value = abs(buffer[index])
        if (value > peak) peak = value
        index += 1
    }
    return peak
}

/**
 * 软拐点的增益衰减量（dB，≤ 0）。
 *
 * 拐点内按二次曲线过渡，拐点外按比率直线压 —— 形状与 Web 的 DynamicsCompressorNode 一致。
 * 拐点落在 `±kneeDb / 2` 之间。
 *
 * @param over 输入电平超出阈值的 dB 数
 * @param ratio 压缩比（> 1）
 * @param kneeDb 拐点宽度（dB）
 */
internal fun softKneeReductionDb(over: Float, ratio: Float, kneeDb: Float): Float {
    val slope = 1f / ratio - 1f
    val halfKnee = kneeDb / 2f
    return when {
        over <= -halfKnee -> 0f
        over < halfKnee -> slope * (over + halfKnee) * (over + halfKnee) / (2f * kneeDb)
        else -> slope * over
    }
}

/**
 * 把一块样本的增益从 [from] 线性斜坡到 [to]。
 *
 * 块级包络如果整块乘同一个增益，参数一变就是一个咔哒声；插值一次的代价远小于它。
 * 是否要走斜坡由调用方自己判断（各段的判重阈值不同，没必要在这里统一）。
 */
internal fun applyGainRamp(
    buffer: FloatArray,
    offset: Int,
    frames: Int,
    channels: Int,
    from: Float,
    to: Float,
) {
    val delta = to - from
    var index = offset
    for (frame in 0 until frames) {
        val gain = from + delta * (frame + 1) / frames
        for (channel in 0 until channels) {
            buffer[index] *= gain
            index += 1
        }
    }
}

/**
 * dB → 线性增益。
 *
 * 除数是 20 而不是 10：音量的 dB 是**电压比**（20·log10），功率比才是 10·log10。
 * 这条换算在五个文件里各写过一次，写错一次听感就差一倍。
 */
internal fun dbToLinear(db: Float): Float = 10f.pow(db / 20f)
