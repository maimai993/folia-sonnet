package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sin

// test/unit/android/EqAudioProcessorChainTest.kt
// 端到端：把 16bit PCM 从 [EqAudioProcessor] 的入口塞进去，从 getOutput() 取出来。
//
// 与 BiquadEqTest / ConsoleDspTest 的区别：那两个直接调 DSP 三件套，证明的是「算法对」；
// 这一个走 media3 的 AudioProcessor 接口（configure → queueInput → getOutput），证明的是
// 「这段 PCM 确实被处理器改过」—— 也就是挂在 AudioSink 上的那一层真的在干活，而不是接了线没通电。
//
// 用到的参数走 NativeEqualizerState.apply()，和桥线程下发的路径是同一个（没有测试专用后门）。

class EqAudioProcessorChainTest {

    private val sampleRate = 48000
    private val channels = 2
    private val frames = sampleRate / 2

    /** 1 kHz 正弦，双声道交织，振幅 0.2（约 -14 dBFS，离限幅器很远）。 */
    private fun tone(): ShortArray {
        val samples = ShortArray(frames * channels)
        for (frame in 0 until frames) {
            val value = (0.2 * sin(2.0 * PI * 1000.0 * frame / sampleRate) * Short.MAX_VALUE).toInt()
            for (channel in 0 until channels) {
                samples[frame * channels + channel] = value.toShort()
            }
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

    /** 后半段的 RMS，避开起始瞬态；返回 dBFS。 */
    private fun rmsDb(samples: ShortArray): Double {
        val start = (samples.size / 2 / channels) * channels
        var energy = 0.0
        var count = 0
        for (index in start until samples.size) {
            val value = samples[index] / Short.MAX_VALUE.toDouble()
            energy += value * value
            count += 1
        }
        return 10.0 * log10(energy / count)
    }

    private fun run(input: ShortArray, settings: EqSettings): ShortArray {
        NativeEqualizerState.apply(settings)
        val processor = EqAudioProcessor(NativeEqualizerState)
        processor.configure(AudioProcessor.AudioFormat(sampleRate, channels, C.ENCODING_PCM_16BIT))
        processor.flush()
        processor.queueInput(toBuffer(input))
        val output = processor.getOutput()
        val result = readAll(output)
        processor.reset()
        return result
    }

    private fun settings(enabled: Boolean, gains: FloatArray): EqSettings = EqSettings.fromJson(
        org.json.JSONObject()
            .put("version", 2)
            .put("enabled", enabled)
            .put("curve", "geq")
            .put("q", 1.4)
            .put("globalGainDb", 0)
            .put(
                "gains",
                org.json.JSONArray().apply { gains.forEach { put(it.toDouble()) } },
            ),
    )

    @Test
    fun `关掉总开关时输出与原声一致`() {
        val input = tone()
        val flat = FloatArray(10)
        val output = run(input, settings(enabled = false, gains = flat))

        assertEquals("帧数不能变", input.size, output.size)
        var worst = 0
        for (index in input.indices) worst = maxOf(worst, abs(input[index].toInt() - output[index].toInt()))
        assertTrue("旁通必须是原样，最大偏差 $worst", worst <= 1)
    }

    @Test
    fun `1 kHz 推上去之后从处理器出来的确有这一段的提升`() {
        val input = tone()
        val gains = FloatArray(10).also { it[5] = 9f } // 31 62 125 250 500 1k …
        val neutral = run(input, settings(enabled = false, gains = FloatArray(10)))
        val boosted = run(input, settings(enabled = true, gains = gains))

        val delta = rmsDb(boosted) - rmsDb(neutral)
        assertTrue("1 kHz 上 9 dB 的提升应该基本落到位，实测 $delta dB", delta in 5.0..11.0)
        assertEquals("帧数不能变", neutral.size, boosted.size)
    }

    @Test
    fun `关掉之后马上回到原声 —— 参数是热生效的`() {
        val input = tone()
        val boosted = run(input, settings(enabled = true, gains = FloatArray(10).also { it[5] = 9f }))
        val back = run(input, settings(enabled = false, gains = FloatArray(10)))

        val delta = rmsDb(back) - rmsDb(boosted)
        assertTrue("关掉应该把增益还回去，实测 $delta dB", delta < -4.0)
    }
}
