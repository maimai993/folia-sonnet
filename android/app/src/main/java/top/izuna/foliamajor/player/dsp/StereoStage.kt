package top.izuna.foliamajor.player.dsp

import kotlin.math.abs

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StereoStage.kt
// 声场：声像平移、耳机交叉馈送、M/S 宽度与低频单声道，挂在后置均衡之后、混响之前。
//
// 为什么用 M/S 而不是「左右各加一点延时」：延时差会让单声道兼容性变差 —— 在手机
// 外放或蓝牙单声道音箱上，反相成分直接抵消，声音会变薄。M/S 只改侧向分量的权重，
// 中置（人声、底鼓）原样不动，collapse 到单声道时正好退回去，不丢东西。
//
//   M = (L + R) / 2      S = (L - R) / 2
//   L' = M + S·width     R' = M - S·width
//
// 处理顺序：声像平移（保持左右之和）→ 交叉馈送（对侧延时+低通混一点进来，
// 模拟音箱听感）→ 宽度 → 低频单声道。
//
// 线程：音频渲染线程，逐样本；唯一的分配发生在 configure。

/** LR4 的两级 Butterworth Q。 */
private const val BUTTERWORTH_Q = 0.7071f

/** 交叉馈送的延时：约 0.3 ms，相当于两只音箱到对侧耳朵的行程差。 */
private const val CROSSFEED_DELAY_SEC = 0.0003f

/** 交叉馈送信号的低通截止：只把对侧的低频「绕过来」，高频不混。 */
private const val CROSSFEED_LOWPASS_HZ = 700f

class StereoStage {

    /** 前置声道对的两级高通，作用在侧向信号上；只在开了低频单声道时打开。 */
    private val bassHigh = Array(2) { BiquadFilter() }

    /** 交叉馈送的对侧低通，左右各一条。 */
    private val crossLow = Array(2) { BiquadFilter() }

    /** 交叉馈送的本侧低通补偿，保持中置低频总电平不变、高频不发闷。 */
    private val directLow = Array(2) { BiquadFilter() }

    private var sampleRate = 0
    private var appliedBassHz = 0f
    private var appliedCrossfeed = 0f

    /** 交叉馈送的短延时线，左右各一条环形缓冲。 */
    private var crossBuf = Array(2) { FloatArray(0) }
    private var crossIdx = 0

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        appliedBassHz = 0f
        appliedCrossfeed = 0f
        val delaySamples = (sampleRate * CROSSFEED_DELAY_SEC).toInt().coerceAtLeast(16)
        crossBuf = Array(2) { FloatArray(delaySamples) }
        crossIdx = 0
        crossLow.forEach { it.setLowPass(sampleRate, CROSSFEED_LOWPASS_HZ, BUTTERWORTH_Q) }
        directLow.forEach { it.setLowPass(sampleRate, CROSSFEED_LOWPASS_HZ, BUTTERWORTH_Q) }
        reset()
    }

    /** seek / flush 之后清状态（滤波器与延时线，不清会把上一段的尾巴带进来）。 */
    fun reset() {
        bassHigh.forEach { it.reset() }
        crossLow.forEach { it.reset() }
        directLow.forEach { it.reset() }
        crossBuf.forEach { it.fill(0f) }
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
        // 交叉馈送从关到开：把延时线与低通历史清掉，避免把上一段旧样本混进来造成左右瞬跳。
        if (crossfeed > 0.001f && appliedCrossfeed <= 0.001f) {
            crossBuf.forEach { it.fill(0f) }
            crossLow.forEach { it.reset() }
            directLow.forEach { it.reset() }
            crossIdx = 0
        }
        appliedCrossfeed = crossfeed
        if (monoBass) applyBass(bassHz)
        // 宽度恰好 1、没开低频单声道、交叉馈送与声像平移都为 0 时是恒等变换，别白跑一遍。
        if (!monoBass && abs(width - 1f) < 0.001f
            && crossfeed <= 0.001f && abs(rotation) < 0.001f) return

        val pan = rotation / 180f
        val crossGain = crossfeed * 0.8f
        val crossMix = crossGain / (1f + crossGain)
        val crossN = crossBuf[0].size
        val crossActive = crossfeed > 0.001f && crossN > 0

        // Media3 supplies channel count, not a layout mask. Only FL/FR are safe to pair.
        for (frame in 0 until frames) {
            val base = offset + frame * channels
            val l = buffer[base]
            val r = buffer[base + 1]

            // ① 声像平移：仅转移左右声道之间的份额，单声道折叠不变。
            val transfer = if (pan >= 0f) l * pan else r * pan
            var left = l - transfer
            var right = r + transfer

            // ② 交叉馈送：低频段按 (1 - m)·LP(本侧) + m·LP(对侧延时) 交叉，高频段原样保留，
            //    避免单声道低频叠加膨胀（原未补偿时最高 +5.1 dB）同时不压暗高频。
            if (crossActive) {
                val leftChannel = 0
                val rightChannel = leftChannel + 1
                val delayedL = crossBuf[leftChannel][crossIdx]
                val delayedR = crossBuf[rightChannel][crossIdx]
                crossBuf[leftChannel][crossIdx] = left
                crossBuf[rightChannel][crossIdx] = right
                val crossL = crossLow[leftChannel].process(delayedR, 0)
                val crossR = crossLow[rightChannel].process(delayedL, 0)
                val directL = directLow[leftChannel].process(left, 0)
                val directR = directLow[rightChannel].process(right, 0)
                left += (crossL - directL) * crossMix
                right += (crossR - directR) * crossMix
            }

            // ③ M/S 宽度与低频单声道。
            val mid = (left + right) * 0.5f
            var side = (left - right) * 0.5f
            if (monoBass) {
                // 两级 Butterworth 串联 = LR4 高通，截止点以下的侧向被拿走。
                side = bassHigh[0].process(side, 0)
                side = bassHigh[1].process(side, 0)
            }
            side *= width
            buffer[base] = mid + side
            buffer[base + 1] = mid - side
            if (crossActive) {
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
        bassHigh.forEach { it.setHighPass(sampleRate, bassHz, BUTTERWORTH_Q) }
    }
}
