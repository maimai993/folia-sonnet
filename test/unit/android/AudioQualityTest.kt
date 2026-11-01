package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

// test/unit/android/AudioQualityTest.kt
// 「音质有没有被处理链弄坏」的量化验收。
//
// 前三类测试关心的是「功能在不在」（有没有增益、参数热不生效）；这里关心的是
// 「有没有副作用」：直通是否逐字节相同、限幅器会不会让波形变形、headroom 会不会白砍动态。
//
// 全部走真实入口：EqAudioProcessor 的 configure → queueInput → getOutput，
// 参数经 NativeEqualizerState.apply() 下发，和 Bridge 线程下发的路径一致。

class AudioQualityTest {

    private val sampleRate = 48000
    private val channels = 2

    // ---------- 激励与测量 ----------

    /** 1 kHz 正弦，指定峰值（线性）。 */
    private fun sine(amplitude: Double, frames: Int): ShortArray {
        val samples = ShortArray(frames * channels)
        val value = amplitude * Short.MAX_VALUE
        for (frame in 0 until frames) {
            val sample = (value * sin(2.0 * PI * 1000.0 * frame / sampleRate)).toInt()
                .coerceIn(-32768, 32767)
            for (channel in 0 until channels) samples[frame * channels + channel] = sample.toShort()
        }
        return samples
    }

    /** 满量程伪随机噪声：旁通测试要覆盖到每一个可能的码值附近。 */
    private fun noise(frames: Int): ShortArray {
        val samples = ShortArray(frames * channels)
        var state = 0x12345678
        for (index in samples.indices) {
            state = state xor (state shl 13)
            state = state xor (state ushr 17)
            state = state xor (state shl 5)
            samples[index] = (state and 0xFFFF).toShort()
        }
        return samples
    }

    private fun toBuffer(samples: ShortArray): ByteBuffer {
        val buffer = ByteBuffer.allocateDirect(samples.size * 2).order(ByteOrder.nativeOrder())
        for (sample in samples) buffer.putShort(sample)
        buffer.flip()
        return buffer
    }

    private fun readAll(buffer: ByteBuffer): ShortArray {
        val copy = buffer.duplicate().order(ByteOrder.nativeOrder())
        val out = ShortArray(copy.remaining() / 2)
        for (index in out.indices) out[index] = copy.short
        return out
    }

    private fun settings(enabled: Boolean, gains: FloatArray, curve: String = "geq", q: Float = 1.4f): EqSettings =
        EqSettings.fromJson(
            JSONObject()
                .put("version", 2)
                .put("enabled", enabled)
                .put("curve", curve)
                .put("q", q.toDouble())
                .put("globalGainDb", 0)
                .put("gains", JSONArray().apply { gains.forEach { put(it.toDouble()) } }),
        )

    private fun run(input: ShortArray, settings: EqSettings): ShortArray {
        NativeEqualizerState.apply(settings)
        val processor = EqAudioProcessor(NativeEqualizerState)
        processor.configure(AudioProcessor.AudioFormat(sampleRate, channels, C.ENCODING_PCM_16BIT))
        processor.flush()
        processor.queueInput(toBuffer(input))
        val output = readAll(processor.getOutput())
        processor.reset()
        return output
    }

    private fun peak(samples: ShortArray, from: Int = 0): Double {
        var worst = 0
        for (index in from until samples.size) {
            val value = kotlin.math.abs(samples[index].toInt())
            if (value > worst) worst = value
        }
        return worst / 32768.0
    }

    /** 单频点幅度（相关法）。窗口必须是该频率的整数个周期，否则会泄漏。 */
    private fun magnitude(samples: ShortArray, from: Int, to: Int, frequency: Double): Double {
        val frames = to - from
        val w = 2.0 * PI * frequency / sampleRate
        var real = 0.0
        var imaginary = 0.0
        for (frame in 0 until frames) {
            // 双声道取左声道即可，左右完全一样。
            val value = samples[(from + frame) * 2] / 32768.0
            real += value * cos(w * frame)
            imaginary += value * sin(w * frame)
        }
        return sqrt(real * real + imaginary * imaginary) * 2.0 / frames
    }

    private fun db(value: Double): Double = 20.0 * log10(value.coerceAtLeast(1e-12))

    /** 2/3 次谐波相对基波。窗口必须对齐整数个周期。 */
    private fun thdOf(samples: ShortArray, from: Int, to: Int, fundamentalHz: Double): Double {
        val fundamental = magnitude(samples, from, to, fundamentalHz)
        val second = magnitude(samples, from, to, fundamentalHz * 2)
        val third = magnitude(samples, from, to, fundamentalHz * 3)
        return db(sqrt(second * second + third * third) / fundamental)
    }

    // ---------- 1. 直通 ----------

    @Test
    fun `关掉总开关时逐样本完全相同`() {
        val input = noise(frames = 4800)
        val output = run(input, settings(enabled = false, gains = FloatArray(10)))

        assertEquals("帧数不能变", input.size, output.size)
        var worst = 0
        var firstDiff = -1
        for (index in input.indices) {
            val delta = kotlin.math.abs(input[index].toInt() - output[index].toInt())
            if (delta != 0 && firstDiff < 0) firstDiff = index
            if (delta > worst) worst = delta
        }
        println("QUALITY bypass_max_delta=$worst")
        assertEquals("直通必须是 0 误差（不是 1 LSB 以内），首个偏差在 $firstDiff", 0, worst)
    }

    // ---------- 2. 小信号：限幅器不该有任何动作 ----------

    @Test
    fun `低于阈值的小信号不会被限幅器改动波形`() {
        // -34 dBFS 的正弦 + 0.5 dB 的 EQ：输出仍远低于限幅阈值，增益必须恒为 1。
        val input = sine(amplitude = 0.02, frames = 4800)
        val gains = FloatArray(10).also { it[5] = 0.5f }
        val neutral = run(input, settings(enabled = false, gains = FloatArray(10)))
        val output = run(input, settings(enabled = true, gains = gains))

        val measuredPeak = peak(output)
        assertTrue("峰值应该只被 EQ 放大 0.5 dB，实测 ${db(measuredPeak)} dBFS", measuredPeak < 0.025)

        val from = 960
        val to = 3360 // 2400 帧 = 50 个 1 kHz 周期

        // 注意：-34 dBFS 的正弦只有约 650 个码值，输入信号自身的 16bit 量化已经把
        // 谐波压在 -64 dB 左右了。所以这里比的是「处理之后有没有比原声更脏」，
        // 而不是一个绝对数字 —— 绝对值会被测试信号本身的量化底噪主导。
        val neutralThd = thdOf(neutral, from, to, 1000.0)
        val shapedThd = thdOf(output, from, to, 1000.0)
        println("QUALITY small_thd_shaped=$shapedThd small_thd_neutral=$neutralThd")
        assertTrue("小信号 THD 不该低于测试信号自身的量化底，实测 $shapedThd dB", shapedThd < -55.0)
        assertTrue(
            "处理不该让畸变变差：原声 $neutralThd dB，处理后 $shapedThd dB",
            shapedThd - neutralThd < 3.0,
        )
    }

    // ---------- 3. 过载：限幅器只改幅度，不改波形 ----------

    @Test
    fun `大幅过载时限幅到上限以内且不产生谐波`() {
        // 0.9 峰值 + 12 dB 提升 → 进限幅器时约 2.5 倍满量程，必须被压 11 dB 左右。
        val input = sine(amplitude = 0.9, frames = 9600)
        val gains = FloatArray(10).also { it[5] = 12f }
        val output = run(input, settings(enabled = true, gains = gains))

        // ① 任何时刻都不许超过 1.0，也基本不该超过 limiter 的 ceiling（-0.26 dBFS）。
        val measuredPeak = peak(output)
        assertTrue("输出峰值必须被压住，实测 ${db(measuredPeak)} dBFS", measuredPeak <= 0.985)

        // ② 稳态段（跳过 5 ms 的 attacking 过渡）应该还是纯正弦。
        val from = 2400
        val to = 7200 // 4800 帧 = 100 个 1 kHz 周期
        val fundamental = magnitude(output, from, to, 1000.0)
        val second = magnitude(output, from, to, 2000.0)
        val third = magnitude(output, from, to, 3000.0)
        val fifth = magnitude(output, from, to, 5000.0)
        val thd = db(sqrt(second * second + third * third + fifth * fifth) / fundamental)
        println("QUALITY overload_peak_db=${db(measuredPeak)} overload_thd_db=$thd")
        assertTrue("稳态限幅不该把正弦压出谐波，实测 THD $thd dB", thd < -50.0)
    }

    // ---------- 4. headroom：只折一半，别把动态砍光 ----------

    @Test
    fun `大增益只折一半的静态补偿`() {
        // 31 Hz 拉到最大（协议层会 clamp 到 12 dB）：只触发 headroom，不碰 1 kHz 本身。
        // excess = 12 - 6 = 6 dB，折半后整体只该降 3 dB（全额补偿会降 6 dB）。
        val input = sine(amplitude = 0.1, frames = 4800)
        val flat = FloatArray(10)
        val boosted = FloatArray(10).also { it[0] = 12f }

        val neutral = run(input, settings(enabled = false, gains = flat))
        val shaped = run(input, settings(enabled = true, gains = boosted))

        val from = 960
        val to = 3360
        val delta = db(magnitude(shaped, from, to, 1000.0)) - db(magnitude(neutral, from, to, 1000.0))
        println("QUALITY headroom_delta_db=$delta")
        assertTrue("整体只该被压 3 dB 左右，实测 $delta dB", delta in -4.0..-2.0)
    }

    // ---------- 5. 限幅器本身的边界 ----------

    @Test
    fun `限幅器输出不越界且不改变安静段`() {
        val limiter = LookaheadLimiter()
        limiter.configure(sampleRate, channels)
        val buffer = FloatArray(4800 * channels)

        // 前 1000 帧安静（-60 dBFS），之后突然 0 dBFS 方波：检验前瞻是否真的提前降增益。
        for (frame in 0 until 4800) {
            val value = if (frame < 1000) 0.001f else if (frame % 48 < 24) 1f else -1f
            for (channel in 0 until channels) buffer[frame * channels + channel] = value
        }

        limiter.process(buffer, 0, 4800, channels)

        var worst = 0f
        for (index in 0 until 1000 * channels) {
            if (kotlin.math.abs(buffer[index]) > worst) worst = kotlin.math.abs(buffer[index])
        }
        // 延迟 5 ms 之后才出现方波，前 1000 帧（≈20 ms）里只有安静信号 + 延迟线里的静音。
        assertTrue("安静段不该被压，实测峰值 $worst", worst <= 0.0011f)

        var overall = 0f
        for (index in buffer.indices) {
            val value = kotlin.math.abs(buffer[index])
            if (value > overall) overall = value
        }
        println("QUALITY limiter_quiet_peak=$worst limiter_overall_peak=$overall")
        assertTrue("任何样本都不许越界，实测 $overall", overall <= 1f)
    }
}
