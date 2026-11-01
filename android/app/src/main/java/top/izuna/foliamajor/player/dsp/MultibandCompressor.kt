package top.izuna.foliamajor.player.dsp

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.log10
import kotlin.math.sqrt

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/MultibandCompressor.kt
// 四段压缩器：把信号拆成 Low / Mid / High / Air，每段各自压，再原样求和。
//
// 为什么不用一条宽带压缩：整首歌一起压，鼓一响人声就跟着掉；分频之后，
// 低频的冲击只压低频，齿音只压 Air，互不牵连 —— 这也是界面上「2/4 频段」那个选项的意义。
//
// 分频用的是 Linkwitz-Riley 4 阶：两个 Butterworth 2 阶（Q = 1/√2）级联。
// 选它而不是「一个高低通各切一刀」，是因为 LR4 的低通支路与高通支路同相，
// 求和之后幅度是平的（全通）；普通 Butterworth 在分频点上会凹 3 dB，四段就是三个坑。
//
// 分频点与界面上的四段一致：
//   Low  20 ~ 250 Hz    Mid 250 ~ 2000 Hz    High 2000 ~ 8000 Hz    Air 8000 ~ 20000 Hz
// 2 频段模式只切 250 Hz，Low 与 High（其余全部）两段。
//
// 检测器是峰值包络 + 立体声联动（取两声道较大的那个），避免压的时候声像往一边跑。
// 静态曲线带 6 dB 软拐点（与 punch 共用 [softKneeReductionDb]），块内增益线性斜坡。
//
// 线程：音频渲染线程；每块最多一次 log/pow（每段一次），缓冲只在块长变化时重新分配。

class MultibandCompressor {

    /** 每一级分频的两条支路，各两级串联 = LR4。索引是分频级（0: 250 Hz，1: 2 kHz，2: 8 kHz）。 */
    private val splitLow = Array(CROSSOVER_COUNT) { Array(2) { BiquadFilter() } }
    private val splitHigh = Array(CROSSOVER_COUNT) { Array(2) { BiquadFilter() } }

    /** 四段的临时缓冲，长度 = 帧数 × 声道数。 */
    private var segments = Array(BAND_COUNT) { FloatArray(0) }

    private val bandGain = FloatArray(BAND_COUNT) { 1f }
    private val bandPreviousGain = FloatArray(BAND_COUNT) { 1f }
    private val attackCoef = FloatArray(BAND_COUNT) { 0.5f }
    private val releaseCoef = FloatArray(BAND_COUNT) { 0.9f }

    private var sampleRate = 0
    private var lastSettings: CompressorSettings? = null

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        lastSettings = null
        reset()
        // 分频点固定在 configure 里：采样率变了才需要重算系数。
        for (level in 0 until CROSSOVER_COUNT) {
            for (tap in 0 until 2) {
                splitLow[level][tap].setLowPass(sampleRate, CROSSOVERS[level], BUTTERWORTH_Q)
                splitHigh[level][tap].setHighPass(sampleRate, CROSSOVERS[level], BUTTERWORTH_Q)
            }
        }
    }

    fun reset() {
        splitLow.forEach { level -> level.forEach { it.reset() } }
        splitHigh.forEach { level -> level.forEach { it.reset() } }
        bandGain.fill(1f)
        bandPreviousGain.fill(1f)
    }

    /**
     * 就地把一段 PCM 压掉。
     *
     * @param settings 四段的参数；`enabled == false` 时直接返回（调用方也会先判一次）
     */
    fun process(buffer: FloatArray, offset: Int, frames: Int, channels: Int, settings: CompressorSettings) {
        if (!settings.enabled || sampleRate <= 0 || frames <= 0) return
        val twoBand = settings.bandCount == 2
        if (settings !== lastSettings) {
            applySettings(settings, twoBand)
            lastSettings = settings
        }

        ensureCapacity(frames * channels)
        // 2 段模式只有 1 级分频，最后一段装的是「其余全部」；4 段模式 3 级。
        val stages = if (twoBand) 1 else CROSSOVER_COUNT
        split(buffer, offset, frames, channels, stages)

        for (slot in 0..stages) {
            compressBand(segments[slot], frames, channels, slotBand(settings, twoBand, slot), settings.profile, slot)
        }

        // 求和写回。LR4 分频的求和是平的，各段相加即原信号（只差压缩带来的增益）。
        val count = frames * channels
        for (index in 0 until count) {
            var sum = segments[0][index]
            for (slot in 1..stages) sum += segments[slot][index]
            buffer[offset + index] = sum
        }
    }

    private fun ensureCapacity(count: Int) {
        for (band in 0 until BAND_COUNT) {
            if (segments[band].size < count) segments[band] = FloatArray(count)
        }
    }

    /**
     * LR4 级联分频：每一级「低通留下、高通继续往下分」，最后一级剩下的高通就是最高频段。
     *
     * 原先两段与四段各写了一份手写展开；改成循环之后只有一处逻辑，
     * 加段数或改分频点不会再出现两份实现互相漂移。
     *
     * @param stages 分频级数：2 段模式 1，4 段模式 3
     */
    private fun split(buffer: FloatArray, offset: Int, frames: Int, channels: Int, stages: Int) {
        var index = 0
        for (frame in 0 until frames) {
            for (channel in 0 until channels) {
                var carry = buffer[offset + index]
                for (level in 0 until stages) {
                    var low = carry
                    var high = carry
                    for (tap in 0 until 2) {
                        low = splitLow[level][tap].process(low, channel)
                        high = splitHigh[level][tap].process(high, channel)
                    }
                    segments[level][index] = low
                    carry = high
                }
                segments[stages][index] = carry
                index += 1
            }
        }
    }

    /**
     * 2 段模式只有两个槽：Low 借 bands[0]，High 借 bands[2]。
     *
     * 借 High 而不是 Mid，是因为 bands[2] 在四段里正好是「250 Hz 以上」的起点；
     * 借 Mid 的话，界面上调 High 的人会发现声音没变。
     */
    private fun slotBand(settings: CompressorSettings, twoBand: Boolean, slot: Int): CompressorBand {
        if (!twoBand) return settings.bands[slot]
        return when (slot) {
            0 -> settings.bands[0]
            1 -> settings.bands[2]
            // 2 段模式用不到的两个槽也照四段原样映射：切回 4 段时系数不会突然跳一格。
            else -> settings.bands[slot]
        }
    }

    /** 一段的压缩：块级包络 + 块内增益斜坡。 */
    private fun compressBand(
        segment: FloatArray,
        frames: Int,
        channels: Int,
        band: CompressorBand,
        profile: Int,
        slot: Int,
    ) {
        val count = frames * channels
        if (!band.enabled || band.ratio <= 1.001f) {
            bandPreviousGain[slot] = 1f
            bandGain[slot] = 1f
            return
        }

        val peak = peakOf(segment, 0, count)
        val peakDb = 20f * log10(peak.coerceAtLeast(1e-6f))
        val reductionDb = softKneeReductionDb(peakDb - band.thresholdDb, band.ratio, KNEE_DB)
        // 温和模式自动补回压掉的一半，平直模式不补 —— 前者听感「更响但没变糊」，
        // 后者给母带式的 A/B 对比用。
        val makeup = if (profile == CompressorProfile.GENTLE) {
            band.makeupDb + (-reductionDb) * 0.5f
        } else {
            band.makeupDb
        }

        val target = dbToLinear(reductionDb + makeup)
        val coefficient = if (target < bandGain[slot]) attackCoef[slot] else releaseCoef[slot]
        bandPreviousGain[slot] = bandGain[slot]
        bandGain[slot] = target + (bandGain[slot] - target) * coefficient

        val from = bandPreviousGain[slot]
        if (abs(bandGain[slot] - from) < 1e-5f) {
            if (bandGain[slot] != 1f) {
                for (index in 0 until count) segment[index] *= bandGain[slot]
            }
            return
        }
        applyGainRamp(segment, 0, frames, channels, from, bandGain[slot])
    }

    private fun applySettings(settings: CompressorSettings, twoBand: Boolean) {
        for (slot in 0 until BAND_COUNT) {
            val source = slotBand(settings, twoBand, slot)
            attackCoef[slot] = exp(-DSP_BLOCK_FRAMES / (source.attackMs / 1000f * sampleRate)).toFloat()
            releaseCoef[slot] = exp(-DSP_BLOCK_FRAMES / (source.releaseMs / 1000f * sampleRate)).toFloat()
            bandGain[slot] = 1f
            bandPreviousGain[slot] = 1f
        }
    }

    private companion object {
        const val BAND_COUNT = CompressorSettings.COMPRESSOR_BAND_COUNT

        /** 三级分频：250 / 2000 / 8000 Hz。 */
        val CROSSOVERS = floatArrayOf(250f, 2000f, 8000f)
        val CROSSOVER_COUNT = CROSSOVERS.size

        /** Butterworth 2 阶的 Q：两级串联就是 LR4。 */
        val BUTTERWORTH_Q = (1.0 / sqrt(2.0)).toFloat()

        /** 软拐点宽度（dB）。 */
        const val KNEE_DB = 6f
    }
}
