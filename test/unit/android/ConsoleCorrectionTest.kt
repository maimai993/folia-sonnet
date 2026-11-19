package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

// Console regression probes: synthetic interleaved PCM, including live settings changes.
class ConsoleCorrectionTest {
    private val rate = 48000
    private fun settings(extra: String) = EqSettings.fromJson(JSONObject("""{"enabled":true,$extra}"""))

    private fun processor(settings: EqSettings, channels: Int = 2): EqAudioProcessor {
        NativeEqualizerState.apply(settings)
        return EqAudioProcessor(NativeEqualizerState).also {
            it.configure(AudioProcessor.AudioFormat(rate, channels, C.ENCODING_PCM_16BIT))
            it.flush()
        }
    }

    private fun tone(frequency: Int, amplitude: Double = 0.6) = FloatArray(rate * 2) {
        (amplitude * sin(2 * PI * frequency * it / rate)).toFloat()
    }

    private fun level(buffer: FloatArray, start: Int = rate) =
        sqrt((start until buffer.size).sumOf { buffer[it].toDouble() * buffer[it] } / (buffer.size - start))

    private fun studio(buffer: FloatArray, settings: StudioSettings): FloatArray {
        StudioStage().apply { configure(rate, 1) }.process(buffer, 0, buffer.size, 1, settings)
        return buffer
    }

    @Test fun carryAcrossToggle() {
        val processor = processor(EqSettings.NEUTRAL)
        processor.queueInput(ByteBuffer.wrap(byteArrayOf(1, 2, 3)))
        NativeEqualizerState.apply(settings("\"version\":2"))
        processor.queueInput(ByteBuffer.wrap(byteArrayOf(4)))
        val output = processor.getOutput()
        assertEquals(4, output.remaining())
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), ByteArray(4).also { output.get(it) })
    }

    @Test fun compareFollowsSameTimeline() {
        fun config(compare: Boolean) = settings(""""mastering":{"balance":{"enabled":true,"value":0.1},"studio":{"scene":{"compare":$compare}}}""")
        val processor = processor(config(false))
        val output = mutableListOf<Int>()
        // Only the left channel is attenuated; the ramp on the right uniquely identifies each frame.
        for (block in 0 until 12) {
            NativeEqualizerState.apply(config(block in 4..7))
            val input = ByteBuffer.allocate(96 * 4).order(ByteOrder.LITTLE_ENDIAN)
            repeat(96) { frame ->
                val value = (1000 + block * 96 + frame).toShort()
                input.putShort(value); input.putShort(value)
            }
            input.flip()
            processor.queueInput(input)
            val samples = processor.getOutput().order(ByteOrder.LITTLE_ENDIAN)
            while (samples.hasRemaining()) { samples.short; output.add(samples.short.toInt()) }
        }
        val delay = output.indexOfFirst { it > 100 }
        assertTrue(delay > 0)
        for (i in delay until output.size) {
            assertTrue("frame $i: ${output[i]} vs ${1000 + i - delay}", abs(output[i] - (1000 + i - delay)) <= 1)
        }
    }

    @Test fun balanceLeavesMono() {
        val buffer = floatArrayOf(0.25f)
        val stage = MasteringStage().apply { configure(rate, 1) }
        stage.process(buffer, 0, 1, 1, MasteringSettings(balance = BalanceSettings(true, 1f)))
        assertEquals(0.25f, buffer[0], 0f)
    }

    @Test fun surroundCenterAndSubAreUntouched() {
        val buffer = FloatArray(6 * 256)
        buffer[2] = 0.5f
        buffer[9] = 0.3f
        val reference = buffer.copyOf()
        val stage = StereoStage().apply { configure(rate) }
        stage.process(buffer, 0, 256, 6, StereoSettings(enabled = true, width = 1.7f, crossfeed = 0.5f, rotation = 90f))
        assertArrayEquals(reference, buffer, 0f)
    }

    @Test fun rotatedCenterSurvivesFold() {
        val buffer = floatArrayOf(0.25f, 0.25f)
        val stage = StereoStage().apply { configure(rate) }
        stage.process(buffer, 0, 1, 2, StereoSettings(enabled = true, rotation = 90f))
        assertEquals(0.25f, (buffer[0] + buffer[1]) / 2, 1e-5f)
        assertTrue(buffer[1] > buffer[0])
    }

    @Test fun dynamicEqIsFrequencySelective() {
        val settings = StudioSettings(advanced = AdvancedSettings(dynamicEq = true, dynamicEqFreq = 200f, dynamicEqAmount = 12f))
        fun gain(frequency: Int): Double {
            val buffer = tone(frequency)
            val reference = level(buffer)
            return level(studio(buffer, settings)) / reference
        }
        assertTrue(gain(200) < 0.9)
        assertEquals(1.0, gain(4000), 0.01)
    }

    @Test fun rmsHeadroomIsATargetOffsetNotAPeakCeiling() {
        fun normalized(withOffset: Boolean) = StudioSettings(normalize = NormalizeSettings(enabled = true, truePeak = withOffset))
        val spike = FloatArray(rate * 2)
        spike[spike.lastIndex] = 0.99f
        studio(spike, normalized(true))
        assertTrue(spike.last() > 1f)
        fun settled(withOffset: Boolean): Double {
            val buffer = FloatArray(rate * 12) { 0.25f }
            return level(studio(buffer, normalized(withOffset)), buffer.size - rate)
        }
        assertEquals(10.0.pow(-1.0 / 20), settled(true) / settled(false), 0.003)
    }

    @Test fun compensateOnlyMeasuredLoss() {
        fun gainAfterCompensation(eqGainDb: Int): Double {
            val processor = processor(settings(""""eq":{"globalGainDb":$eqGainDb},"mastering":{"compensation":{"enabled":true,"amount":1,"responseMs":100,"maxGainDb":12}}"""), 1)
            val source = tone(500, 0.03)
            val input = ByteBuffer.allocate(source.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            source.forEach { input.putShort((it * 32768).toInt().toShort()) }
            input.flip()
            processor.queueInput(input)
            val output = processor.getOutput().order(ByteOrder.LITTLE_ENDIAN)
            return level(FloatArray(source.size) { output.short / 32768f }) / level(source)
        }
        assertEquals(1.0, gainAfterCompensation(0), 0.015)
        assertEquals(1.0, gainAfterCompensation(-6), 0.03)
    }

    @Test fun bothMainsStandardsAndHarmonics() {
        val settings = StudioSettings(restore = RestoreSettings(hum = true, amount = 1f))
        for (frequency in listOf(50, 60, 100, 120, 440)) {
            val buffer = tone(frequency)
            val reference = level(buffer)
            val gain = level(studio(buffer, settings)) / reference
            if (frequency == 440) assertEquals(1.0, gain, 0.02)
            else assertTrue("$frequency Hz ratio $gain", gain < 0.4)
        }
    }

    @Test fun clickFollowsAmount() {
        fun click(amount: Float) = studio(floatArrayOf(0f, 1f, 0f), StudioSettings(restore = RestoreSettings(declick = true, amount = amount)))[1]
        assertEquals(1f, click(0f), 0f)
        assertTrue(click(0.5f) in (click(1f) + 0.01f)..0.99f)
    }

    @Test fun studioOnlySkipsMasteringLoop() {
        val settings = MasteringSettings(studio = StudioSettings(restore = RestoreSettings(hum = true)))
        assertTrue(settings.stageIsNeutral())
        assertTrue(!settings.isNeutral())
        val buffer = floatArrayOf(0.3f)
        MasteringStage().apply { configure(rate, 1) }.process(buffer, 0, 1, 1, settings)
        assertEquals(0.3f, buffer[0], 0f)
    }
}
