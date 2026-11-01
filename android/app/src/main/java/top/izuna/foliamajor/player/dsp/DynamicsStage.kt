package top.izuna.foliamajor.player.dsp

import kotlin.math.exp
import kotlin.math.log10

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/DynamicsStage.kt
// Web 的 punch 滑杆在原生侧的实现：一次块级压缩 + 自动 headroom 预增益。
//
// 对齐的是 src/services/audioEffects/effectChain.ts 里那条 DynamicsCompressorNode：
//   threshold = -6 - 26 * punch      ratio = 1 + 7 * punch
//   knee      = 30 - 18 * punch      makeup = 3 * punch dB
//   attack 8 ms / release 180 ms
//
// 与 Web 的**刻意不同**：
//   1. 预增益（headroom）：Web 靠 DAC 削顶，16bit 中间态削顶是刺耳的；这里先把最大提升量
//      折回去一部分（见 EqAudioProcessor.HEADROOM_TRIM），宁可整首小一两 dB，也不要破音。
//   2. 这里**不做限幅**。整条链的末端是 [LookaheadLimiter] —— 多段压缩、后置 EQ、混响都在
//      punch 后面，限幅必须等它们全部跑完再做，否则压不住后级加的增益。
//
// 早期版本在本类里带过一条「punch + tanh 软限幅」的便捷路径，现在没有调用者了：逐样本
// 波形整形在峰值密集时就是持续互调失真，已经整体删除，只留 [processPunch]。
//
// 线程：音频渲染线程，块级调用；块内只做乘加，log/pow 每块最多一次。

class DynamicsStage {

    private var attackCoef = 0f
    private var releaseCoef = 0f

    /** 上一块用过的线性增益：块内从它斜坡到新值，避免台阶声。 */
    private var currentGain = 1f
    private var previousGain = 1f

    fun configure(sampleRate: Int, blockFrames: Int) {
        attackCoef = exp(-blockFrames / (ATTACK_SECONDS * sampleRate)).toFloat()
        releaseCoef = exp(-blockFrames / (RELEASE_SECONDS * sampleRate)).toFloat()
        reset()
    }

    fun reset() {
        currentGain = 1f
        previousGain = 1f
    }

    /**
     * @param punch 0..1（Web 的 punch 滑杆）
     * @param preGain 线性预增益，由十段里最大的正增益算出来（见 EqAudioProcessor.updatePreGain）
     */
    fun processPunch(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        punch: Float,
        preGain: Float,
    ) {
        val count = frames * channels
        if (preGain != 1f) {
            for (index in 0 until count) {
                buffer[offset + index] *= preGain
            }
        }

        if (punch <= 0.001f) {
            previousGain = 1f
            currentGain = 1f
            return
        }

        previousGain = currentGain
        currentGain = nextGain(buffer, offset, count, punch)
        if (currentGain == previousGain) {
            for (index in 0 until count) buffer[offset + index] *= currentGain
        } else {
            applyGainRamp(buffer, offset, frames, channels, previousGain, currentGain)
        }
    }

    /** 块级增益计算：整块一个目标值，块内线性斜坡。 */
    private fun nextGain(buffer: FloatArray, offset: Int, count: Int, punch: Float): Float {
        val peak = peakOf(buffer, offset, count)
        val peakDb = 20f * log10(peak.coerceAtLeast(1e-6f))

        val threshold = -6f - 26f * punch
        val reductionDb = softKneeReductionDb(peakDb - threshold, 1f + 7f * punch, 30f - 18f * punch)
        // 补 3 dB 是 Web 的 makeup：punch 拉满时整体听感应该「更紧」而不是「更轻」。
        val target = dbToLinear(reductionDb + 3f * punch)
        val coefficient = if (target < currentGain) attackCoef else releaseCoef
        return target + (currentGain - target) * coefficient
    }

    private companion object {
        const val ATTACK_SECONDS = 0.008f
        const val RELEASE_SECONDS = 0.180f
    }
}
