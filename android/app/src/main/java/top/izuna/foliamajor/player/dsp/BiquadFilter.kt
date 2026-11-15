package top.izuna.foliamajor.player.dsp

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/BiquadFilter.kt
// 单个二阶节：RBJ Audio EQ Cookbook 的系数 + Direct Form II Transposed 的逐样本运算。
//
// 系数用的是 Web Audio BiquadFilterNode 的同一套公式（lowshelf / highshelf 取 S = 1），
// 所以同一组参数在两边算出来的频响能对上 —— 这是「手机和电脑听起来一样」的前提，
// 也是单元测试能拿 Web 的导出曲线做基准的原因。
//
// 线程：只在音频渲染线程上调用（ExoPlayer 的 playerLooper），无锁、无分配。

/** 支持到 7.1；单声道 / 立体声是最常见的情况，多声道时按声道号各自保留状态。 */
private const val MAX_CHANNELS = 8

class BiquadFilter {

    private var b0 = 1f
    private var b1 = 0f
    private var b2 = 0f
    private var a1 = 0f
    private var a2 = 0f

    private val z1 = FloatArray(MAX_CHANNELS)
    private val z2 = FloatArray(MAX_CHANNELS)

    /** false = 这一步是恒等变换（增益 0 dB / 频率在中性位置），process 直接返回输入。 */
    var active = false
        private set

    /** seek / flush 之后清状态：不清的话上一段的尾巴会被带进新位置，听感是一次「噗」。 */
    fun reset() {
        z1.fill(0f)
        z2.fill(0f)
    }

    /**
     * 关掉这一步。
     *
     * 只有「从开到关」才 reset：运行中改增益不 reset，否则每拖一下滑杆都要爆一下。
     */
    fun bypass() {
        if (active) reset()
        active = false
        b0 = 1f
        b1 = 0f
        b2 = 0f
        a1 = 0f
        a2 = 0f
    }

    fun process(input: Float, channel: Int): Float {
        if (!active) return input
        val index = if (channel < MAX_CHANNELS) channel else 0
        val output = b0 * input + z1[index]
        z1[index] = b1 * input - a1 * output + z2[index]
        z2[index] = b2 * input - a2 * output
        return output
    }

    fun setPeaking(sampleRate: Int, frequency: Float, q: Float, gainDb: Float) {
        if (abs(gainDb) < 0.01f) {
            bypass()
            return
        }
        val w0 = omega(sampleRate, frequency)
        val cosW0 = cos(w0)
        val alpha = sin(w0) / (2f * q.coerceAtLeast(0.1f))
        val a = 10f.pow(gainDb / 40f)
        normalize(
            b0 = 1f + alpha * a,
            b1 = -2f * cosW0,
            b2 = 1f - alpha * a,
            a0 = 1f + alpha / a,
            a1 = -2f * cosW0,
            a2 = 1f - alpha / a,
        )
    }

    fun setLowShelf(sampleRate: Int, frequency: Float, gainDb: Float) {
        if (abs(gainDb) < 0.01f) {
            bypass()
            return
        }
        val w0 = omega(sampleRate, frequency)
        val cosW0 = cos(w0)
        val sinW0 = sin(w0)
        val a = 10f.pow(gainDb / 40f)
        // S = 1（Web Audio 的默认斜率）：alpha = sin/2 * sqrt(2)
        val alpha = sinW0 / 2f * sqrt(2f)
        val twoSqrtAAlpha = 2f * sqrt(a) * alpha
        normalize(
            b0 = a * ((a + 1f) - (a - 1f) * cosW0 + twoSqrtAAlpha),
            b1 = 2f * a * ((a - 1f) - (a + 1f) * cosW0),
            b2 = a * ((a + 1f) - (a - 1f) * cosW0 - twoSqrtAAlpha),
            a0 = (a + 1f) + (a - 1f) * cosW0 + twoSqrtAAlpha,
            a1 = -2f * ((a - 1f) + (a + 1f) * cosW0),
            a2 = (a + 1f) + (a - 1f) * cosW0 - twoSqrtAAlpha,
        )
    }

    fun setHighShelf(sampleRate: Int, frequency: Float, gainDb: Float) {
        if (abs(gainDb) < 0.01f) {
            bypass()
            return
        }
        val w0 = omega(sampleRate, frequency)
        val cosW0 = cos(w0)
        val sinW0 = sin(w0)
        val a = 10f.pow(gainDb / 40f)
        val alpha = sinW0 / 2f * sqrt(2f)
        val twoSqrtAAlpha = 2f * sqrt(a) * alpha
        normalize(
            b0 = a * ((a + 1f) + (a - 1f) * cosW0 + twoSqrtAAlpha),
            b1 = -2f * a * ((a - 1f) + (a + 1f) * cosW0),
            b2 = a * ((a + 1f) + (a - 1f) * cosW0 - twoSqrtAAlpha),
            a0 = (a + 1f) - (a - 1f) * cosW0 + twoSqrtAAlpha,
            a1 = 2f * ((a - 1f) - (a + 1f) * cosW0),
            a2 = (a + 1f) - (a - 1f) * cosW0 - twoSqrtAAlpha,
        )
    }

    fun setHighPass(sampleRate: Int, frequency: Float, q: Float) {
        // 20 Hz 是中性值（Web 侧 highpass 的 neutral）：再低只会切掉直流，不值得多跑一遍。
        if (frequency <= 21f) {
            bypass()
            return
        }
        val w0 = omega(sampleRate, frequency)
        val cosW0 = cos(w0)
        val alpha = sin(w0) / (2f * q.coerceAtLeast(0.1f))
        normalize(
            b0 = (1f + cosW0) / 2f,
            b1 = -(1f + cosW0),
            b2 = (1f + cosW0) / 2f,
            a0 = 1f + alpha,
            a1 = -2f * cosW0,
            a2 = 1f - alpha,
        )
    }

    fun setLowPass(sampleRate: Int, frequency: Float, q: Float) {
        val ceiling = sampleRate.toFloat() * 0.475f
        if (frequency >= ceiling - 1f || frequency >= 19000f) {
            bypass()
            return
        }
        val w0 = omega(sampleRate, frequency)
        val cosW0 = cos(w0)
        val alpha = sin(w0) / (2f * q.coerceAtLeast(0.1f))
        normalize(
            b0 = (1f - cosW0) / 2f,
            b1 = 1f - cosW0,
            b2 = (1f - cosW0) / 2f,
            a0 = 1f + alpha,
            a1 = -2f * cosW0,
            a2 = 1f - alpha,
        )
    }

    /**
     * 角频率 ω0 = 2π·f/fs，频率先夹到 [10 Hz, 0.475·fs]（Nyquist 以下留 5% 余量）。
     *
     * 五个 set 方法都要这一步；夹紧规则只写一遍，就不会出现「peak 夹了、shelf 忘了」。
     */
    private fun omega(sampleRate: Int, frequency: Float): Float {
        val fs = sampleRate.toFloat()
        return TWO_PI * frequency.coerceIn(10f, fs * 0.475f) / fs
    }

    private fun normalize(b0: Float, b1: Float, b2: Float, a0: Float, a1: Float, a2: Float) {
        this.b0 = b0 / a0
        this.b1 = b1 / a0
        this.b2 = b2 / a0
        this.a1 = a1 / a0
        this.a2 = a2 / a0
        active = true
    }

    private companion object {
        const val TWO_PI = 6.283185307179586f
    }
}
