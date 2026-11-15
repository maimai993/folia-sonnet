package top.izuna.foliamajor.automix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

/**
 * 语义层（发声 / 基频 / 和弦）的行为约束。
 *
 * 守的是三条「错了就一眼看得见」的性质：
 *   · 220Hz 的持续音，音高要落在 55–880Hz 四个八度的正中间（0.5）；
 *   · 纯静音必须是「没在唱」，不能因为数值噪声给出一个发声度；
 *   · C 大三和弦的三个音，判出来的根音必须是 C，而且是大调。
 *
 * 不追求小数级精度：这三个量喂的是画面，不是乐谱。
 */
class AudioFeaturesTest {

    private val sr = ScnetRunner.SAMPLE_RATE
    private val hop = sr / AudioFeatures.FPS

    private fun tone(seconds: Double, hzList: List<Double>): FloatArray {
        val total = (sr * seconds).toInt()
        val out = FloatArray(total)
        for (i in 0 until total) {
            val t = i.toDouble() / sr
            var sum = 0.0
            for (hz in hzList) sum += sin(2 * PI * hz * t)
            out[i] = (sum / hzList.size * 0.4).toFloat()
        }
        return out
    }

    private fun run(mono: FloatArray, seconds: Double = 2.0) =
        AudioFeatures.analyze(arrayOf(mono), null, hop, (seconds * AudioFeatures.FPS).toInt())

    @Test
    fun `a sustained 220Hz note sits in the middle of the range`() {
        val result = run(tone(2.0, listOf(220.0)))
        val pitch = result.pitch.average()
        // 12·log2(220/55) = 24 半音；除以 48 半音 = 0.5。
        assertEquals(0.5, pitch, 0.08)
        assertTrue("持续音应当被判为在唱：${result.voicing.average()}", result.voicing.average() > 0.5)
    }

    @Test
    fun `silence is not a voice`() {
        val result = run(FloatArray((sr * 2.0).toInt()))
        assertEquals(0.0, result.voicing.average(), 1e-6)
        assertEquals(0.0, result.pitch.average(), 1e-6)
    }

    @Test
    fun `a C major triad reads as C major`() {
        // C4 / E4 / G4：261.63 / 329.63 / 392.00
        val result = run(tone(2.0, listOf(261.63, 329.63, 392.0)))
        val root = result.chordRoot.average() * 12
        assertEquals("根音应当是 C（0）", 0.0, root, 0.6)
        assertTrue("C 大三和弦不该被判成小调：${result.chordMinor.average()}", result.chordMinor.average() < 0.5)
    }

    @Test
    fun `a minor triad reads as minor`() {
        // A3 / C4 / E4：220 / 261.63 / 329.63 —— A 小三和弦
        val result = run(tone(2.0, listOf(220.0, 261.63, 329.63)))
        val root = result.chordRoot.average() * 12
        assertEquals("根音应当是 A（9）", 9.0, root, 0.6)
        assertTrue("A 小三和弦应当被判成小调：${result.chordMinor.average()}", result.chordMinor.average() > 0.5)
    }

    @Test
    fun `the chroma mean is a distribution`() {
        val result = run(tone(2.0, listOf(261.63, 329.63, 392.0)))
        val sum = result.chromaMean.sum()
        assertEquals(1.0, sum.toDouble(), 0.05)
        // C、E、G 三个音级的份额应当明显高于其余九个。
        val low = (0 until 12).filter { it != 0 && it != 4 && it != 7 }.map { result.chromaMean[it] }.average()
        val high = (listOf(0, 4, 7)).map { result.chromaMean[it] }.average()
        assertTrue("三和弦的音级应当突出：$high vs $low", high > low * 2)
    }
}
