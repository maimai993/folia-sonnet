package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StereoStage.kt
// 声场：旋转、耳机交叉馈送、M/S 宽度与低频单声道，挂在后置均衡之后、混响之前。
//
// 为什么用 M/S 而不是「左右各加一点延时」：延时差会让单声道兼容性变差 —— 在手机
// 外放或蓝牙单声道音箱上，反相成分直接抵消，声音会变薄。M/S 只改侧向分量的权重，
// 中置（人声、底鼓）原样不动，collapse 到单声道时正好退回去，不丢东西。
//
//   M = (L + R) / 2      S = (L - R) / 2
//   L' = M + S·width     R' = M - S·width
//
// 处理顺序：旋转（把整个声场转一个角度）→ 交叉馈送（对侧延时+低通混一点进来，
// 模拟音箱听感）→ 宽度 → 低频单声道。
//
// 线程：音频渲染线程，逐样本；唯一的分配发生在 configure。

/** 最多 4 对（8 声道）—— 与 BiquadFilter 的 MAX_CHANNELS 一致。 */
private const val MAX_PAIRS = 4

/** LR4 的两级 Butterworth Q。 */
private const val BUTTERWORTH_Q = 0.7071f

/** 交叉馈送的延时：约 0.3 ms，相当于两只音箱到对侧耳朵的行程差。 */
private const val CROSSFEED_DELAY_SEC = 0.0003f

/** 交叉馈送信号的低通截止：只把对侧的低频「绕过来」，高频不混。 */
private const val CROSSFEED_LOWPASS_HZ = 700f

class StereoStage {

    /** 每对声道的两级高通，作用在侧向信号上；只在开了低频单声道时打开。 */
    private val bassHigh = Array(MAX_PAIRS) { Array(2) { BiquadFilter() } }

    /** 交叉馈送的对侧低通，左右各一条。 */
    private val crossLow = Array(2) { BiquadFilter() }

    private var sampleRate = 0
    private var appliedBassHz = 0f

    /** 交叉馈送的短延时线，左右各一条环形缓冲。 */
    private var crossBuf = arrayOf(FloatArray(0), FloatArray(0))
    private var crossIdx = 0

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        appliedBassHz = 0f
        val delaySamples = (sampleRate * CROSSFEED_DELAY_SEC).toInt().coerceAtLeast(16)
        crossBuf = arrayOf(FloatArray(delaySamples), FloatArray(delaySamples))
        crossIdx = 0
        crossLow.forEach { it.setLowPass(sampleRate, CROSSFEED_LOWPASS_HZ, BUTTERWORTH_Q) }
        reset()
    }

    /** seek / flush 之后清状态（滤波器与延时线，不清会把上一段的尾巴带进来）。 */
    fun reset() {
        bassHigh.forEach { pair -> pair.forEach { it.reset() } }
        crossLow.forEach { it.reset() }
        crossBuf[0].fill(0f)
        crossBuf[1].fill(0f)
        crossIdx = 0
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channels: Int,
        settings: StereoSettings,
    ) {
        // 单声道没有「侧」可言。
        if (!settings.enabled || channels < 2) return
        val width = settings.width.coerceIn(0f, 2f)
        val bassHz = settings.bassMonoHz.coerceIn(0f, 400f)
        val monoBass = bassHz > 0f
        val crossfeed = settings.crossfeed.coerceIn(0f, 1f)
        val rotation = settings.rotation.coerceIn(-180f, 180f)
        if (monoBass) applyBass(bassHz)
        // 宽度恰好 1、没开低频单声道、交叉馈送与旋转都为 0 时是恒等变换，别白跑一遍。
        if (!monoBass && abs(width - 1f) < 0.001f
            && crossfeed < 0.001f && abs(rotation) < 0.001f) return

        val rotRad = rotation * PI.toFloat() / 180f
        val rotCos = cos(rotRad)
        val rotSin = sin(rotRad)
        val crossGain = crossfeed * 0.8f
        val crossN = crossBuf[0].size

        val pairs = minOf(channels / 2, MAX_PAIRS)
        for (frame in 0 until frames) {
            val base = offset + frame * channels
            // 成对处理；声道数为奇数时最后一个通道没有伴，原样留着。
            for (pair in 0 until pairs) {
                val l = buffer[base + pair * 2]
                val r = buffer[base + pair * 2 + 1]

                // ① 旋转：整个声场绕听者转。
                var left = l * rotCos - r * rotSin
                var right = l * rotSin + r * rotCos

                // ② 交叉馈送：对侧的低频（延时 + 低通）混一点进本侧。
                if (crossGain > 0f) {
                    val delayedL = crossBuf[0][crossIdx]
                    val delayedR = crossBuf[1][crossIdx]
                    crossBuf[0][crossIdx] = left
                    crossBuf[1][crossIdx] = right
                    left += crossLow[0].process(delayedR, 0) * crossGain
                    right += crossLow[1].process(delayedL, 1) * crossGain
                }

                // ③ M/S 宽度与低频单声道。
                val mid = (left + right) * 0.5f
                var side = (left - right) * 0.5f
                if (monoBass) {
                    // 两级 Butterworth 串联 = LR4 高通，截止点以下的侧向被拿走。
                    side = bassHigh[pair][0].process(side, 0)
                    side = bassHigh[pair][1].process(side, 0)
                }
                side *= width
                buffer[base + pair * 2] = mid + side
                buffer[base + pair * 2 + 1] = mid - side
            }
            if (crossGain > 0f) {
                crossIdx += 1
                if (crossIdx >= crossN) crossIdx = 0
            }
        }
    }

    /**
     * 低频单声道的分频只随频率变，所以只在滑杆真的动了的时候重算系数。
     *
     * 只换系数、不清状态：拖滑杆时听到的是「折成单声道的边界在移动」，
     * 而不是每拖一格「啪」一下。
     */
    private fun applyBass(bassHz: Float) {
        if (abs(bassHz - appliedBassHz) < 0.01f) return
        appliedBassHz = bassHz
        for (pair in 0 until MAX_PAIRS) {
            for (tap in 0 until 2) {
                bassHigh[pair][tap].setHighPass(sampleRate, bassHz, BUTTERWORTH_Q)
            }
        }
    }
}
