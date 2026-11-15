package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sin

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/SpectrumAnalyzer.kt
// 后置频谱：把「此刻真正送进 AudioTrack 的声音」量成 32 根对数频段，给界面上的
// L / R 实时频谱用。
//
// 为什么要在原生算：Web 侧拿不到音频数据 —— 出声的是 ExoPlayer，Web Audio 图不在信号路径上，
// AnalyserNode 读到的是一条静音的假总线。频谱只能在这里算完再推过桥。
//
// 取的是**后置链路之后**的信号（后置 EQ、混响、限幅都过完了），所以界面上看到的
// 就是耳朵听到的，包括混响尾巴 —— 这也是「后置均衡器」那张图的本来意思。
//
// 实现：512 点 radix-2 FFT + Hann 窗。48 kHz 下 512 点是 10.7 ms 一窗、93.75 Hz 一个 bin，
// 低频分辨率一般，但频谱图是给人看形状的，不是做测量的；再大就要开始吃 CPU 了。
// 每约 48 ms 出一次结果（每 18 个 128 帧的块），远端按帧率画，够用。
//
// 线程：push 在音频渲染线程，copy 在桥线程。两边都不加锁 —— 结果写在一份新数组里，
// 再换掉 volatile 引用；读的人拿到的一定是完整的一份。

/** FFT 点数。 */
private const val FFT_SIZE = 512

/** 输出频段数：与界面上的 32 根柱子一致。 */
const val SPECTRUM_BAND_COUNT = 32

/** 频段覆盖 20 Hz ~ 20 kHz。 */
private const val SPECTRUM_MIN_HZ = 20.0
private const val SPECTRUM_MAX_HZ = 20000.0

/** 每多少块算一次。128 帧 @48 kHz ≈ 2.67 ms，18 块 ≈ 48 ms。 */
private const val BLOCKS_PER_FRAME = 18

/** 底噪：低于这个电平当作静音，频谱图不画。 */
private const val FLOOR_DB = -90f

class SpectrumAnalyzer {

    private var sampleRate = 0

    private val window = FloatArray(FFT_SIZE) { index ->
        // Hann：两端归零，减少泄漏。系数只算一次。
        (0.5 - 0.5 * cos(2.0 * PI * index / (FFT_SIZE - 1))).toFloat()
    }
    private val re = FloatArray(FFT_SIZE)
    private val im = FloatArray(FFT_SIZE)
    private val reverse = IntArray(FFT_SIZE)
    private val cosTable = FloatArray(FFT_SIZE / 2) { cos(2.0 * PI * it / FFT_SIZE).toFloat() }
    private val sinTable = FloatArray(FFT_SIZE / 2) { -sin(2.0 * PI * it / FFT_SIZE).toFloat() }

    /** 环形输入，存的是单声道混合（L + R 的平均）。 */
    private val ring = FloatArray(FFT_SIZE)
    private var ringIndex = 0
    private var written = 0
    private var blocksSinceFrame = 0

    private val bandStart = IntArray(SPECTRUM_BAND_COUNT)
    private val bandEnd = IntArray(SPECTRUM_BAND_COUNT)

    /** 上一帧的结果，做时间平滑用（快起慢落，像真的表头）。 */
    private val smoothed = FloatArray(SPECTRUM_BAND_COUNT)

    /** 给外面读的一份：0..1，对应 -90 dB ~ 0 dB。 */
    @Volatile
    var bands: FloatArray = FloatArray(SPECTRUM_BAND_COUNT)
        private set

    init {
        // 位反转表：迭代 FFT 的标准前置。
        val bits = Integer.numberOfTrailingZeros(FFT_SIZE)
        for (index in 0 until FFT_SIZE) {
            reverse[index] = Integer.reverse(index) ushr (32 - bits)
        }
    }

    fun configure(sampleRate: Int) {
        this.sampleRate = sampleRate
        ringIndex = 0
        written = 0
        blocksSinceFrame = 0
        smoothed.fill(0f)
        bands = FloatArray(SPECTRUM_BAND_COUNT)
        buildBandEdges()
    }

    fun reset() {
        ring.fill(0f)
        ringIndex = 0
        written = 0
        blocksSinceFrame = 0
        smoothed.fill(0f)
        bands = FloatArray(SPECTRUM_BAND_COUNT)
    }

    /**
     * 喂一块处理完的 PCM。
     *
     * @return 这一块是否产生了一帧新的频谱（调用方据此决定要不要推给界面）
     */
    fun push(buffer: FloatArray, offset: Int, frames: Int, channels: Int): Boolean {
        if (sampleRate <= 0 || frames <= 0) return false
        var index = offset
        for (frame in 0 until frames) {
            var sum = 0f
            for (channel in 0 until channels) {
                sum += buffer[index + channel]
            }
            ring[ringIndex] = sum / channels
            ringIndex += 1
            if (ringIndex >= FFT_SIZE) ringIndex = 0
            if (written < FFT_SIZE) written += 1
            index += channels
        }

        blocksSinceFrame += 1
        if (blocksSinceFrame < BLOCKS_PER_FRAME) return false
        blocksSinceFrame = 0
        // 一窗都没填满时算出来全是零，白跑一次 FFT。
        if (written < FFT_SIZE) return false
        analyse()
        return true
    }

    private fun analyse() {
        // 环形缓冲按时间顺序摊平到 re。
        var cursor = ringIndex
        for (index in 0 until FFT_SIZE) {
            re[index] = ring[cursor] * window[index]
            im[index] = 0f
            cursor += 1
            if (cursor >= FFT_SIZE) cursor = 0
        }

        fft()

        for (band in 0 until SPECTRUM_BAND_COUNT) {
            var peak = 0f
            for (bin in bandStart[band] until bandEnd[band]) {
                val magnitude = re[bin] * re[bin] + im[bin] * im[bin]
                if (magnitude > peak) peak = magnitude
            }
            // 幅度归一化：512 点、Hann 窗，满幅正弦的主瓣大约在 FFT_SIZE/4。
            val amplitude = kotlin.math.sqrt(peak) / (FFT_SIZE / 4f)
            val db = 20f * log10(amplitude.coerceAtLeast(1e-7f))
            val normalized = ((db - FLOOR_DB) / -FLOOR_DB).coerceIn(0f, 1f)
            // 快起慢落：柱子上跳要跟得上，下落要能看清。
            val previous = smoothed[band]
            smoothed[band] = if (normalized > previous) {
                previous + (normalized - previous) * 0.6f
            } else {
                previous + (normalized - previous) * 0.18f
            }
        }

        // 换一份新数组，桥线程读到的永远是完整的一帧。
        bands = smoothed.copyOf()
    }

    /** 原地 radix-2 FFT（复数在 re/im 里）。 */
    private fun fft() {
        for (index in 0 until FFT_SIZE) {
            val target = reverse[index]
            if (target > index) {
                val tr = re[index]
                re[index] = re[target]
                re[target] = tr
                val ti = im[index]
                im[index] = im[target]
                im[target] = ti
            }
        }

        var size = 2
        while (size <= FFT_SIZE) {
            val half = size / 2
            val step = FFT_SIZE / size
            var start = 0
            while (start < FFT_SIZE) {
                var k = 0
                for (index in start until start + half) {
                    val cosValue = cosTable[k]
                    val sinValue = sinTable[k]
                    val evenRe = re[index]
                    val evenIm = im[index]
                    val oddRe = re[index + half]
                    val oddIm = im[index + half]
                    val twiddleRe = oddRe * cosValue - oddIm * sinValue
                    val twiddleIm = oddRe * sinValue + oddIm * cosValue
                    re[index] = evenRe + twiddleRe
                    im[index] = evenIm + twiddleIm
                    re[index + half] = evenRe - twiddleRe
                    im[index + half] = evenIm - twiddleIm
                    k += step
                }
                start += size
            }
            size *= 2
        }
    }

    /** 每个频段覆盖哪些 bin：对数均分 20 Hz ~ 20 kHz。 */
    private fun buildBandEdges() {
        val nyquist = sampleRate / 2.0
        val binHz = sampleRate.toDouble() / FFT_SIZE
        val ratio = SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ
        for (band in 0 until SPECTRUM_BAND_COUNT) {
            val low = SPECTRUM_MIN_HZ * Math.pow(ratio, band.toDouble() / SPECTRUM_BAND_COUNT)
            val high = SPECTRUM_MIN_HZ * Math.pow(ratio, (band + 1).toDouble() / SPECTRUM_BAND_COUNT)
            val start = (low / binHz).toInt().coerceIn(1, FFT_SIZE / 2 - 1)
            val end = (high / binHz).toInt().coerceIn(start + 1, FFT_SIZE / 2)
            bandStart[band] = start
            bandEnd[band] = end
            // 采样率低于 40 kHz 时上限够不到 20 kHz，最后几段会落在同一个 bin 上，
            // 这里不特殊处理：它们只是显示成同样高，不影响听感。
            if (low > nyquist) {
                bandStart[band] = FFT_SIZE / 2 - 1
                bandEnd[band] = FFT_SIZE / 2
            }
        }
    }
}
