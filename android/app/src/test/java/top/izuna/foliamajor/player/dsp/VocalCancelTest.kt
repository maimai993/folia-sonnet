package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

// android/app/src/test/java/top/izuna/foliamajor/player/dsp/VocalCancelTest.kt
// 关闭人声的回归测试。
//
// 这个功能前两版都是「开不开都滋滋滋」，而且都是在真机上听出来的 ——
// 因为写坏样本不会抛异常，logcat 里干干净净。这组测试就是把当初那两次
// 事故变成断言：
//   1. 关掉开关时，输出必须与输入**逐字节**相同（字节序、错位都过不了这一条）；
//   2. 打开时居中的内容要被明显压下，侧向内容不能被削成方波；
//   3. 拨开关那一下不能有跳变（否则就是一声咔哒）。
class VocalCancelTest {

    private val stereo16 = AudioProcessor.AudioFormat(44100, 2, C.ENCODING_PCM_16BIT)

    @Before
    fun setUp() {
        NativeEqualizerState.vocalCancelEnabled = false
    }

    @After
    fun tearDown() {
        NativeEqualizerState.vocalCancelEnabled = false
    }

    private fun newProcessor(format: AudioProcessor.AudioFormat = stereo16): VocalCancelProcessor =
        VocalCancelProcessor(NativeEqualizerState).also { it.configure(format) }

    /**
     * 造一块 PCM，并故意让 position 不等于 0。
     *
     * 当初第二次事故就出在这里：搬运时一边用绝对下标读、一边用相对位置写，
     * position 一旦不是 0，整段样本就错位了。测试必须把 position 顶开。
     */
    private fun pcmBuffer(samples: IntArray, leadingBytes: Int = 8): ByteBuffer {
        val payload = ByteArray(samples.size * 2)
        samples.forEachIndexed { index, value ->
            payload[index * 2] = (value and 0xFF).toByte()
            payload[index * 2 + 1] = ((value shr 8) and 0xFF).toByte()
        }
        val buffer = ByteBuffer.allocateDirect(leadingBytes + payload.size + 8)
        buffer.order(ByteOrder.BIG_ENDIAN)
        // 前导垃圾：如果实现按「整块容量」或「从 0 开始」去读，就会读到这些字节。
        repeat(leadingBytes) { buffer.put(0x5A) }
        buffer.put(payload)
        buffer.position(leadingBytes)
        buffer.limit(leadingBytes + payload.size)
        return buffer
    }

    private fun interleaved(size: Int, left: (Int) -> Int, right: (Int) -> Int): IntArray =
        IntArray(size * 2) { index ->
            if (index % 2 == 0) left(index / 2) else right(index / 2)
        }

    private fun drain(processor: VocalCancelProcessor): ByteArray {
        val output = processor.output
        assertNotNull(output)
        val bytes = ByteArray(output.remaining())
        output.get(bytes)
        return bytes
    }

    private fun shortsOf(bytes: ByteArray): IntArray =
        IntArray(bytes.size / 2) { index ->
            val low = bytes[index * 2].toInt() and 0xFF
            val high = bytes[index * 2 + 1].toInt()
            (high shl 8) or low
        }

    /** 关闭时逐字节一致 —— 这条挂了，用户听到的就是滋滋声。 */
    @Test
    fun `关闭时输出与输入逐字节相同`() {
        val samples = IntArray(2048) { index -> ((index * 37) % 65536) - 32768 }
        val input = pcmBuffer(samples)
        val expected = ByteArray(input.remaining()).also { input.duplicate().get(it) }
        val processor = newProcessor()

        processor.queueInput(input)
        assertArrayEquals(expected, drain(processor))
    }

    /**
     * 输入缓冲必须被标记为「已消费」。
     *
     * 这条挂了，真机上的表现是「打开开关后伴奏人声全没了，只剩滋滋电流声」：
     * AudioProcessingPipeline 只要看到输入还有剩，就会把同一块 PCM 再交进来，
     * 于是同一段样本被反复处理、反复送进 AudioTrack，播放永远停在这一块上。
     * 旁通分支的 put(inputBuffer) 自带这一步，所以只有打开开关才会犯。
     */
    @Test
    fun `处理时输入缓冲必须被完全消费`() {
        NativeEqualizerState.vocalCancelEnabled = true
        val processor = newProcessor()
        val input = pcmBuffer(interleaved(512, { 8000 }, { 6000 }))
        processor.queueInput(input)
        assertEquals("打开时输入没被消费", input.limit(), input.position())
    }

    /** 关掉时同样要消费（走的是整段搬运那条分支）。 */
    @Test
    fun `旁通时输入缓冲也必须被完全消费`() {
        val processor = newProcessor()
        val input = pcmBuffer(interleaved(512, { 8000 }, { 6000 }))
        processor.queueInput(input)
        assertEquals("旁通时输入没被消费", input.limit(), input.position())
    }

    /** 单声道没有左右差可减：必须原样通过，而不是算出半幅噪声。 */
    @Test
    fun `单声道输入原样通过`() {
        val samples = IntArray(1024) { index -> ((index * 13) % 40000) - 20000 }
        val input = pcmBuffer(samples)
        val expected = ByteArray(input.remaining()).also { input.duplicate().get(it) }
        val processor = newProcessor(AudioProcessor.AudioFormat(44100, 1, C.ENCODING_PCM_16BIT))

        NativeEqualizerState.vocalCancelEnabled = true
        processor.queueInput(input)
        assertArrayEquals(expected, drain(processor))
    }

    /** 居中的人声（L == R）要被明显压下。 */
    @Test
    fun `居中内容被压下`() {
        NativeEqualizerState.vocalCancelEnabled = true
        val processor = newProcessor()
        val samples = interleaved(
            8192,
            left = { index -> (10000 * sin(2 * PI * 440 * index / 44100.0)).toInt() },
            right = { index -> (10000 * sin(2 * PI * 440 * index / 44100.0)).toInt() },
        )
        processor.queueInput(pcmBuffer(samples))
        val out = shortsOf(drain(processor))

        // 前 12ms 是淡入，取后半段比较。
        val window = out.size / 2
        val inputRms = rms(samples, samples.size / 2, samples.size)
        val outputRms = rms(out, window, out.size)
        assertTrue(
            "居中内容应至少压下 15dB，实际 ${20 * kotlin.math.log10(outputRms / inputRms)}dB",
            outputRms < inputRms * 0.18,
        )
    }

    /**
     * 纯侧向内容（完全反相）必须**原样**通过。
     *
     * 这是「减中置」与「减对面声道」的分水岭：后者会把它放大到 1+k 倍，
     * 于是满幅内容过载、限幅器把波形压成方波 —— 用户听到的就是滋滋声。
     */
    @Test
    fun `反相内容原样通过`() {
        NativeEqualizerState.vocalCancelEnabled = true
        val processor = newProcessor()
        val samples = interleaved(
            4096,
            left = { index -> (30000 * sin(2 * PI * 440 * index / 44100.0)).toInt() },
            right = { index -> -(30000 * sin(2 * PI * 440 * index / 44100.0)).toInt() },
        )
        processor.queueInput(pcmBuffer(samples))
        val out = shortsOf(drain(processor))

        // 跳过淡入段（12ms ≈ 529 帧，这里留到 1024 帧），之后应当逐样本相等。
        for (index in 2048 until samples.size) {
            assertEquals("第 $index 个样本被改动", samples[index], out[index])
        }
    }

    /** 纯侧向内容（反相）不能被削成方波：相消后幅度变大，靠软膝兜住。 */
    @Test
    fun `满幅反相内容不削波`() {
        NativeEqualizerState.vocalCancelEnabled = true
        val processor = newProcessor()
        val samples = interleaved(
            4096,
            left = { index -> (32767 * sin(2 * PI * 440 * index / 44100.0)).toInt() },
            right = { index -> -(32767 * sin(2 * PI * 440 * index / 44100.0)).toInt() },
        )
        processor.queueInput(pcmBuffer(samples))
        val out = shortsOf(drain(processor))

        assertTrue("样本越界", out.all { it in Short.MIN_VALUE..Short.MAX_VALUE })
        // 硬切会留下一大串完全相同的满幅值；软膝下峰值附近的样本各不相同。
        val peak = out.maxOf { abs(it) }
        val atPeak = out.count { abs(it) >= peak - 2 }
        assertTrue("峰值处疑似硬削波（$atPeak 个样本贴在 $peak）", atPeak < out.size / 20)
    }

    /** 拨开关那一下从 0 起淡入，第一个样本不能跳。 */
    @Test
    fun `打开开关时没有跳变`() {
        val samples = interleaved(
            512,
            left = { 12000 },
            right = { 9000 },
        )
        val processor = newProcessor()
        NativeEqualizerState.vocalCancelEnabled = true
        processor.queueInput(pcmBuffer(samples))
        val out = shortsOf(drain(processor))

        // 第一个样本还没开始相消：与输入之差应该只有淡入的第一步（不到 1%）。
        assertTrue("首样本跳变", abs(out[0] - 12000) < 200)
        assertTrue("首样本跳变", abs(out[1] - 9000) < 200)
    }

    /** 关掉之后要回到逐字节一致（淡出走完即完全旁通）。 */
    @Test
    fun `关闭后重新逐字节一致`() {
        val processor = newProcessor()
        // 先开着跑一段，把滤波器状态和 mix 顶到 1。
        NativeEqualizerState.vocalCancelEnabled = true
        processor.queueInput(pcmBuffer(interleaved(2048, { 8000 }, { 8000 })))
        drain(processor)

        NativeEqualizerState.vocalCancelEnabled = false
        // 足够长的静音把 12ms 淡出跑完。
        processor.queueInput(pcmBuffer(interleaved(4096, { 0 }, { 0 })))
        drain(processor)

        val samples = IntArray(1024) { index -> ((index * 29) % 50000) - 25000 }
        val input = pcmBuffer(samples)
        val expected = ByteArray(input.remaining()).also { input.duplicate().get(it) }
        processor.queueInput(input)
        assertArrayEquals(expected, drain(processor))
    }

    /** 核心的限幅器不该把正常电平的样本改掉任何一位。 */
    @Test
    fun `软膝之下不做任何改动`() {
        val core = VocalCancelCore().apply { configure(44100) }
        core.setEnabled(false)
        core.process(12345, -23456)
        assertEquals(12345, core.outL)
        assertEquals(-23456, core.outR)
    }

    private fun rms(samples: IntArray, from: Int, to: Int): Double {
        var sum = 0.0
        for (index in from until to) {
            val value = samples[index].toDouble()
            sum += value * value
        }
        return kotlin.math.sqrt(sum / (to - from).coerceAtLeast(1))
    }
}
