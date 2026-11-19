package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

// test/unit/android/ConsoleProcessorRound2Test.kt
// 第二轮整改里需要整个 EqAudioProcessor 才能复现的两项：A/B 原声的等延迟、频谱刷新率按样本计时。

class ConsoleProcessorRound2Test {
    private val rate = 48000

    private fun settings(extra: String) = EqSettings.fromJson(JSONObject("""{"enabled":true,$extra}"""))

    private fun processor(initial: EqSettings): EqAudioProcessor {
        NativeEqualizerState.apply(initial)
        return EqAudioProcessor(NativeEqualizerState).also {
            it.configure(AudioProcessor.AudioFormat(rate, 1, C.ENCODING_PCM_16BIT))
            it.flush()
        }
    }

    private fun block(values: IntArray): ByteBuffer {
        val buffer = ByteBuffer.allocate(values.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        values.forEach { buffer.putShort(it.toShort()) }
        buffer.flip()
        return buffer
    }

    private fun drain(processor: EqAudioProcessor): IntArray {
        val out = processor.getOutput().order(ByteOrder.LITTLE_ENDIAN)
        return IntArray(out.remaining() / 2) { out.short.toInt() }
    }

    // ———— 2：A/B 固定为原声，链路在平/非平之间切换，输出始终是同一条等延迟的原声 ————

    @Test fun abOriginalKeepsOneConstantDelayAcrossFlatAndNonFlat() {
        val compare = """"mastering":{"studio":{"scene":{"compare":true}}}"""
        val flat = settings(compare)
        val bent = settings(""""eq":{"globalGainDb":6},$compare""")
        val processor = processor(flat)
        val blockFrames = 160
        val total = 40
        val output = ArrayList<Int>()
        for (index in 0 until total) {
            // 第 10..19 块、第 30.. 块用非平设置，其余平：覆盖「平→非平→平→非平」。
            NativeEqualizerState.apply(if (index in 10..19 || index >= 30) bent else flat)
            processor.queueInput(block(IntArray(blockFrames) { 1000 + index * blockFrames + it }))
            drain(processor).forEach { output.add(it) }
        }
        val delay = output.indexOfFirst { it != 0 }
        assertTrue("the original never came out", delay >= 0)
        assertTrue("delay $delay frames = ${delay * 1000.0 / rate} ms", delay in 200..300)
        for (i in delay until output.size) {
            assertEquals("frame $i (${i * 1000.0 / rate} ms): a gap or a jump in the original", 1000 + i - delay, output[i])
        }
    }

    // ———— 3：频谱每秒刷新次数不随一次 queueInput 的帧数变 ————

    private fun spectrumUpdatesPerSecond(extra: String): Double {
        NativeEqualizerState.spectrumEnabled = true
        try {
            val processor = processor(settings(extra))
            var updates = 0
            var last = NativeEqualizerState.spectrum()
            val seconds = 4
            val chunk = 1024
            for (index in 0 until rate * seconds / chunk) {
                processor.queueInput(block(IntArray(chunk) { (8000 * Math.sin(2 * Math.PI * 1000.0 * (index * chunk + it) / rate)).toInt() }))
                drain(processor)
                val now = NativeEqualizerState.spectrum()
                if (now !== last) { updates++; last = now }
            }
            return updates / seconds.toDouble()
        } finally { NativeEqualizerState.spectrumEnabled = false }
    }

    @Test fun spectrumRefreshRateIsTheSameWetAndInAB() {
        val wet = spectrumUpdatesPerSecond(""""eq":{"globalGainDb":3}""")
        val dryFlat = spectrumUpdatesPerSecond("""
            "mastering":{"studio":{"scene":{"compare":true}}}""".trim())
        val dryBent = spectrumUpdatesPerSecond(""""eq":{"globalGainDb":3},"mastering":{"studio":{"scene":{"compare":true}}}""")
        assertEquals("48 ms hop should give about 20.8 updates/s, wet got $wet", 20.8, wet, 1.5)
        assertEquals("A/B on a flat chain: $dryFlat updates/s vs wet $wet", wet, dryFlat, 1.5)
        assertEquals("A/B on a non-flat chain: $dryBent updates/s vs wet $wet", wet, dryBent, 1.5)
    }
}
