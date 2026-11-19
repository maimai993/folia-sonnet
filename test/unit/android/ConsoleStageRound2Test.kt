package top.izuna.foliamajor.player.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

// test/unit/android/ConsoleStageRound2Test.kt
// 第二轮整改的合成 PCM 回归：只碰 StudioStage / MasteringStage / SpectrumAnalyzer，不加载 media3。
// 所有断言用实际物理量（dB、毫秒、Hz、帧数）：电平比、谐波相对基波、更新间隔。

class ConsoleStageRound2Test {

    private fun sine(rate: Int, frequency: Double, seconds: Double, amplitude: Double): FloatArray =
        FloatArray((rate * seconds).toInt()) { (amplitude * sin(2 * PI * frequency * it / rate)).toFloat() }

    private fun rms(buffer: FloatArray, from: Int, to: Int = buffer.size): Double {
        var sum = 0.0
        for (i in from until to) sum += buffer[i].toDouble() * buffer[i]
        return sqrt(sum / (to - from))
    }

    private fun db(ratio: Double) = 20 * log10(ratio)

    /** 单频幅度（Goertzel，整段）。 */
    private fun amplitudeAt(buffer: FloatArray, from: Int, rate: Int, frequency: Double): Double {
        var re = 0.0
        var im = 0.0
        val n = buffer.size - from
        for (i in 0 until n) {
            val phase = 2 * PI * frequency * i / rate
            re += buffer[from + i] * kotlin.math.cos(phase)
            im -= buffer[from + i] * sin(phase)
        }
        return 2 * sqrt(re * re + im * im) / n
    }

    private fun mastering(buffer: FloatArray, rate: Int, settings: MasteringSettings, channels: Int = 1): FloatArray {
        MasteringStage().apply { configure(rate, channels) }.process(buffer, 0, buffer.size / channels, channels, settings)
        return buffer
    }

    private fun studio(buffer: FloatArray, rate: Int, settings: StudioSettings, channels: Int = 1): FloatArray {
        StudioStage().apply { configure(rate, channels) }.process(buffer, 0, buffer.size / channels, channels, settings)
        return buffer
    }

    // ———— 4：RMS 标准化的时间常数与声道数无关 ————

    @Test fun normalizeFollowsTheSameTimeForAnyChannelCount() {
        val rate = 48000
        val settings = StudioSettings(normalize = NormalizeSettings(enabled = true))
        fun gainAfter(channels: Int, seconds: Double): Double {
            val frames = (rate * seconds).toInt()
            val buffer = FloatArray(frames * channels) { 0.05f }
            studio(buffer, rate, settings, channels)
            return buffer[(frames - 1) * channels].toDouble() / 0.05
        }
        // 0.3 s 处增益还在爬坡：此时的增益能直接反映功率跟随的时间常数。
        val mono = gainAfter(1, 0.3)
        for (channels in listOf(2, 6)) {
            val multi = gainAfter(channels, 0.3)
            assertEquals("${channels}ch gain at 300 ms vs mono (${db(multi / mono)} dB)", 1.0, multi / mono, 0.01)
        }
    }

    @Test fun normalizeAppliesOneGainToEveryChannel() {
        val rate = 48000
        val channels = 6
        val frames = rate / 2
        val amplitudes = floatArrayOf(0.02f, 0.3f, 0.1f, 0.05f, 0.2f, 0.01f)
        val input = FloatArray(frames * channels) { amplitudes[it % channels] }
        val output = input.copyOf()
        studio(output, rate, StudioSettings(normalize = NormalizeSettings(enabled = true)), channels)
        for (frame in listOf(100, frames / 2, frames - 1)) {
            val reference = output[frame * channels] / input[frame * channels]
            for (channel in 1 until channels) {
                val gain = output[frame * channels + channel] / input[frame * channels + channel]
                assertEquals("frame $frame channel $channel", reference.toDouble(), gain.toDouble(), 1e-5)
            }
        }
    }

    // ———— 5：去喷麦 ————

    @Test fun steadyMidToneIsNotAttenuatedOrDistortedByDePlosive() {
        for (rate in listOf(44100, 48000, 96000)) {
            val input = sine(rate, 440.0, 2.0, 0.6)
            val output = mastering(input.copyOf(), rate, MasteringSettings(dePlosive = DePlosiveSettings(enabled = true)))
            val from = rate
            val levelDb = db(rms(output, from) / rms(input, from))
            assertEquals("$rate Hz steady 440 Hz level change", 0.0, levelDb, 0.05)
            val fundamental = amplitudeAt(output, from, rate, 440.0)
            for (harmonic in listOf(880.0, 1320.0, 1760.0)) {
                val relative = db(amplitudeAt(output, from, rate, harmonic) / fundamental)
                assertTrue("$rate Hz harmonic ${harmonic.toInt()} Hz at $relative dB rel. fundamental", relative < -70.0)
            }
        }
    }

    @Test fun lowBurstIsReducedAndSustainedBassIsNot() {
        fun burstPeakDb(rate: Int): Double {
            val total = rate * 2
            val input = FloatArray(total)
            val start = (rate * 0.3).toInt()
            val length = (rate * 0.12).toInt()
            for (i in 0 until length) input[start + i] = (0.6 * sin(2 * PI * 80.0 * i / rate)).toFloat()
            val output = mastering(input.copyOf(), rate, MasteringSettings(dePlosive = DePlosiveSettings(enabled = true, reductionDb = -12f)))
            // 起音 40 ms 之后到冲击结束：取这一段的峰值电平变化。
            val from = start + (rate * 0.04).toInt()
            val to = start + length
            val peakIn = input.copyOfRange(from, to).maxOf { abs(it) }
            val peakOut = output.copyOfRange(from, to).maxOf { abs(it) }
            return db((peakOut / peakIn).toDouble())
        }
        val at44 = burstPeakDb(44100)
        val at96 = burstPeakDb(96000)
        assertTrue("80 Hz plosive burst only changed by $at44 dB at 44.1 kHz", at44 < -6.0)
        assertTrue("80 Hz plosive burst only changed by $at96 dB at 96 kHz", at96 < -6.0)
        assertEquals("burst reduction must not depend on the sample rate", at44, at96, 2.0)

        val rate = 48000
        val bass = sine(rate, 80.0, 3.0, 0.5)
        val kept = mastering(bass.copyOf(), rate, MasteringSettings(dePlosive = DePlosiveSettings(enabled = true)))
        assertEquals("sustained 80 Hz note after 2 s", 0.0, db(rms(kept, rate * 2) / rms(bass, rate * 2)), 0.5)
    }

    // ———— 6：去咔嗒 ————

    @Test fun sustainedHighFrequencyIsNotTreatedAsClicks() {
        val rate = 48000
        val settings = StudioSettings(restore = RestoreSettings(declick = true, amount = 1f))
        for (frequency in listOf(6000.0, 10000.0, 12000.0)) {
            val input = sine(rate, frequency, 1.0, 0.8)
            val output = studio(input.copyOf(), rate, settings)
            // 5 ms 的起音之后必须与输入逐样本一致。
            var worst = 0.0
            for (i in 240 until input.size) worst = max(worst, abs(output[i] - input[i]).toDouble())
            assertTrue("${frequency.toInt()} Hz tone altered by up to $worst of full scale", worst < 1e-6)
        }
    }

    @Test fun isolatedSpikeInAHighFrequencyBedIsStillRemoved() {
        val rate = 48000
        val bed = sine(rate, 6000.0, 1.0, 0.3)
        val input = bed.copyOf()
        val spike = 24000
        input[spike] += 0.9f
        val output = studio(input.copyOf(), rate, StudioSettings(restore = RestoreSettings(declick = true, amount = 1f)))
        val remaining = abs(output[spike] - bed[spike])
        assertTrue("spike left $remaining of 0.9", remaining < 0.3f)
        var worst = 0.0
        for (i in 240 until input.size) if (i != spike) worst = max(worst, abs(output[i] - bed[i]).toDouble())
        assertTrue("neighbours of the spike altered by $worst", worst < 1e-6)
    }

    // ———— 7：瞬态塑形 ————

    private fun burstPeakChangeDb(amount: Float, rate: Int = 48000): Double {
        val input = FloatArray(rate)
        val start = (rate * 0.3).toInt()
        val length = (rate * 0.010).toInt()
        for (i in 0 until length) input[start + i] = (0.5 * sin(2 * PI * 1000.0 * i / rate)).toFloat()
        val output = mastering(input.copyOf(), rate, MasteringSettings(transient = TransientSettings(enabled = true, amount = amount)))
        var peakIn = 0f
        var peakOut = 0f
        for (i in start until start + length + (rate * 0.002).toInt()) {
            peakIn = max(peakIn, abs(input[i])); peakOut = max(peakOut, abs(output[i]))
        }
        return db(peakOut.toDouble() / peakIn)
    }

    @Test fun transientAmountChangesA10MsBurstByRealDecibels() {
        val boost = burstPeakChangeDb(1f)
        val half = burstPeakChangeDb(0.5f)
        val soften = burstPeakChangeDb(-1f)
        assertTrue("amount +1 changed the 10 ms burst peak by only $boost dB", boost >= 4.0)
        assertTrue("amount +0.5 gave $half dB, expected between 1.5 dB and the full-amount $boost dB", half in 1.5..boost)
        assertTrue("amount -1 changed the 10 ms burst peak by only $soften dB", soften <= -4.0)
        assertEquals("amount 0 is untouched", 0.0, burstPeakChangeDb(0f), 1e-6)
    }

    @Test fun transientLeavesSteadyTonesAlone() {
        val rate = 48000
        for (frequency in listOf(100.0, 440.0, 3000.0)) {
            val input = sine(rate, frequency, 2.0, 0.5)
            val output = mastering(input.copyOf(), rate, MasteringSettings(transient = TransientSettings(enabled = true, amount = 1f)))
            var worst = 0.0
            for (i in rate until input.size) worst = max(worst, abs(output[i] - input[i]).toDouble())
            assertTrue("${frequency.toInt()} Hz steady tone altered by up to $worst of full scale", worst < 1e-3)
        }
    }

    // ———— 3：频谱刷新按样本数计时 ————

    @Test fun spectrumUpdatesPerSecondDoNotDependOnCallSize() {
        for (rate in listOf(44100, 48000)) {
            val signal = sine(rate, 1000.0, 4.0, 0.5)
            fun updatesPerSecond(chunk: Int): Double {
                val analyzer = SpectrumAnalyzer().apply { configure(rate) }
                var updates = 0
                var position = 0
                while (position < signal.size) {
                    val frames = minOf(chunk, signal.size - position)
                    if (analyzer.push(signal, position, frames, 1)) updates++
                    position += frames
                }
                return updates / 4.0
            }
            val wetBlocks = updatesPerSecond(128)
            // 1000 帧 ≈ 21 ms 仍小于 48 ms 的间隔：一次调用至多出一帧，计数才有意义。
            val coarseCalls = updatesPerSecond(1000)
            assertTrue("$rate Hz: 128-frame blocks gave $wetBlocks updates/s (48 ms hop = 20.8/s)", wetBlocks in 19.0..22.0)
            assertEquals("$rate Hz: 1000-frame calls gave $coarseCalls updates/s vs $wetBlocks", wetBlocks, coarseCalls, 1.5)
        }
    }
}
