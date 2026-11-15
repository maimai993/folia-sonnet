package top.izuna.foliamajor.automix

import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin
import kotlin.random.Random

/**
 * 人声净曲线的行为约束。
 *
 * 这一组测试守的不是「数值精确」，而是那条最要命的性质：
 * **鼓敲下去的时候，人声曲线不许跟着跳**。它是「歌词跟着鼓抖」的直接来源，
 * 而这件事在真机上只能靠肉眼看，回归起来没有成本 —— 所以在这里用合成信号钉住。
 */
class VocalCurveTest {

    private val sr = ScnetRunner.SAMPLE_RATE
    private val hop = sr / VocalCurve.FPS
    private val seconds = 6.0
    private val total = (sr * seconds).toInt()

    /** 一段持续的人声：220Hz 基频 + 8 次谐波，稳定输出，不做停顿。 */
    private fun voice(): FloatArray {
        val out = FloatArray(total)
        for (i in 0 until total) {
            val t = i.toDouble() / sr
            var sum = 0.0
            for (k in 1..8) sum += sin(2 * PI * 220 * k * t) / k
            out[i] = (sum * 0.18).toFloat()
        }
        return out
    }

    /** 鼓：每 0.5 秒一下，宽带噪声 + 200Hz 鼓腔，各带指数衰减。 */
    private fun drums(): FloatArray {
        val out = FloatArray(total)
        val random = Random(11)
        val hit = (0.2 * sr).toInt()
        var at = 0.0
        while (at < seconds) {
            val start = (at * sr).toInt()
            for (i in 0 until hit) {
                val index = start + i
                if (index >= total) break
                val t = i.toDouble() / sr
                val decay = exp(-t / 0.035)
                val noise = (random.nextDouble() * 2 - 1) * decay
                val body = sin(2 * PI * 200 * t) * exp(-t / 0.05)
                out[index] += (noise * 0.5 + body * 0.5).toFloat()
            }
            at += 0.5
        }
        return out
    }

    /** 峰值 / 中位数：鼓击是孤立的尖峰，这个比值直接反映「跳不跳」。 */
    private fun crest(curve: FloatArray): Double {
        val sorted = curve.sorted()
        val median = sorted[sorted.size / 2].toDouble()
        val peak = sorted.last().toDouble()
        return peak / maxOf(median, 1e-6)
    }

    /**
     * 相对起伏：峰值比中位数高出多少（0.2 = 高 20%）。
     *
     * 用「高多少」而不是「几倍」：人声本身是一条平线，峰值/中位数天然逼近 1，
     * 这种情况下「降到 75%」是个不可达的目标（比值不可能低于 1），
     * 而「起伏降到一半」才是这条曲线真正该守的性质。
     */
    private fun excursion(curve: FloatArray): Double = crest(curve) - 1.0

    private fun stereo(mono: FloatArray) = arrayOf(mono, mono)

    @Test
    fun `鼓击不再顶起人声曲线`() {
        val voice = voice()
        val drum = drums()
        // 模拟真实情况：分离出来的 vocals 轨里必然漏进一层鼓（这里给 25%）。
        val leaked = FloatArray(total) { voice[it] + drum[it] * 0.25f }

        val raw = VocalCurve.bandRms(stereo(leaked), hop, 250.0, 2000.0)
        val clean = VocalCurve.envelope(stereo(leaked), stereo(drum), hop)

        assertTrue("净曲线不该是空的", clean.isNotEmpty())
        val rawJump = excursion(raw)
        val cleanJump = excursion(clean)
        // 裸带通每一拍都有一个鼓包；净曲线要明显平得多。
        assertTrue(
            "净曲线的起伏应至少减半：raw=$rawJump clean=$cleanJump",
            cleanJump < rawJump * 0.5,
        )
    }

    @Test
    fun `净曲线仍保留人声的水平`() {
        val voice = voice()
        val drum = drums()
        val leaked = FloatArray(total) { voice[it] + drum[it] * 0.25f }

        val raw = VocalCurve.bandRms(stereo(leaked), hop, 250.0, 2000.0)
        val clean = VocalCurve.envelope(stereo(leaked), stereo(drum), hop)

        val rawMean = raw.average()
        val cleanMean = clean.average()
        // 削太狠会让整句歌词都塌成 0，那是另一种「不动」，同样不能用。
        assertTrue(
            "净曲线不该被压死：raw=$rawMean clean=$cleanMean",
            cleanMean > rawMean * 0.35,
        )
    }

    @Test
    fun `没有鼓轨时退化成平滑而不是崩掉`() {
        val clean = VocalCurve.envelope(stereo(voice()), null, hop)
        assertTrue(clean.isNotEmpty())
        assertTrue("没有鼓也要有人声", clean.average() > 0.0)
    }

    @Test
    fun `空输入返回空曲线`() {
        assertTrue(VocalCurve.envelope(null, null, hop).isEmpty())
        assertTrue(VocalCurve.envelope(arrayOf(FloatArray(0)), null, hop).isEmpty())
        assertTrue(VocalCurve.bandRms(null, hop, 250.0, 2000.0).isEmpty())
    }
}
