package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

// test/unit/android/CrossfadeCurveTest.kt
// 交叉淡化曲线的回归：等功率不塌、线性确实塌、快切更早完成交接。
//
// 为什么值得单独测：这三条曲线决定的是「两首歌重叠那几秒听起来烦不烦」，
// 而它只体现在两个浮点数上 —— 没有波形可看，只能对着数验。
// 旧实现用的是线性交叉（incoming = progress），中点功率只有一半，听感是塌一下；
// 下面的 `线性交叉在中点掉一半功率` 就是那条旧行为的对照。

class CrossfadeCurveTest {

    private val samples = (0..10).map { it / 10f }

    @Test
    fun `等功率的两端是干净的`() {
        assertEquals(0f, CrossfadeCurve.incoming(CrossfadeCurve.EQUAL_POWER, 0f), 1e-6f)
        assertEquals(1f, CrossfadeCurve.outgoing(CrossfadeCurve.EQUAL_POWER, 0f), 1e-6f)
        assertEquals(1f, CrossfadeCurve.incoming(CrossfadeCurve.EQUAL_POWER, 1f), 1e-6f)
        assertEquals(0f, CrossfadeCurve.outgoing(CrossfadeCurve.EQUAL_POWER, 1f), 1e-6f)
    }

    @Test
    fun `等功率全程功率不塌`() {
        for (p in samples) {
            val incoming = CrossfadeCurve.incoming(CrossfadeCurve.EQUAL_POWER, p)
            val outgoing = CrossfadeCurve.outgoing(CrossfadeCurve.EQUAL_POWER, p)
            val power = incoming * incoming + outgoing * outgoing
            assertEquals("progress=$p 处功率应恒为 1", 1f, power, 1e-4f)
        }
    }

    @Test
    fun `等功率中点是两个 0_707`() {
        val mid = sqrt(0.5f)
        assertEquals(mid, CrossfadeCurve.incoming(CrossfadeCurve.EQUAL_POWER, 0.5f), 1e-4f)
        assertEquals(mid, CrossfadeCurve.outgoing(CrossfadeCurve.EQUAL_POWER, 0.5f), 1e-4f)
    }

    @Test
    fun `线性交叉在中点掉一半功率`() {
        val incoming = CrossfadeCurve.incoming(CrossfadeCurve.LINEAR, 0.5f)
        val outgoing = CrossfadeCurve.outgoing(CrossfadeCurve.LINEAR, 0.5f)
        assertEquals(0.5f, incoming, 1e-6f)
        assertEquals(0.5f, outgoing, 1e-6f)
        // 0.5² + 0.5² = 0.5：相对等功率的 1.0 正好差 3 dB，这就是「塌一下」的量。
        assertEquals(0.5f, incoming * incoming + outgoing * outgoing, 1e-6f)
    }

    @Test
    fun `快切在中点之前就完成大半交接`() {
        val incoming = CrossfadeCurve.incoming(CrossfadeCurve.FAST, 0.5f)
        val outgoing = CrossfadeCurve.outgoing(CrossfadeCurve.FAST, 0.5f)
        assertTrue("快切中点进来的那首应已明显大于一半，实际 $incoming", incoming > 0.7f)
        assertTrue("快切中点出去的那首应已明显小于一半，实际 $outgoing", outgoing < 0.3f)
        // 两端仍要干净，否则开头结尾会突然出声 / 留声。
        assertEquals(0f, CrossfadeCurve.incoming(CrossfadeCurve.FAST, 0f), 1e-6f)
        assertEquals(1f, CrossfadeCurve.incoming(CrossfadeCurve.FAST, 1f), 1e-6f)
    }

    @Test
    fun `进度越界被夹在两端`() {
        for (curve in listOf(CrossfadeCurve.EQUAL_POWER, CrossfadeCurve.LINEAR, CrossfadeCurve.FAST)) {
            assertEquals(0f, CrossfadeCurve.incoming(curve, -0.5f), 1e-6f)
            assertEquals(1f, CrossfadeCurve.incoming(curve, 1.5f), 1e-6f)
            assertEquals(1f, CrossfadeCurve.outgoing(curve, -0.5f), 1e-6f)
            assertEquals(0f, CrossfadeCurve.outgoing(curve, 1.5f), 1e-6f)
        }
    }

    @Test
    fun `认不出的曲线名回等功率`() {
        assertEquals(CrossfadeCurve.EQUAL_POWER, CrossfadeCurve.fromName("equalPower"))
        assertEquals(CrossfadeCurve.LINEAR, CrossfadeCurve.fromName("linear"))
        assertEquals(CrossfadeCurve.FAST, CrossfadeCurve.fromName("fast"))
        assertEquals(CrossfadeCurve.EQUAL_POWER, CrossfadeCurve.fromName("whatever"))
        assertEquals(CrossfadeCurve.EQUAL_POWER, CrossfadeCurve.fromName(null))
    }

    @Test
    fun `等功率在端点附近单调`() {
        // 两端如果出现回退，说明公式写反了（cos 与 sin 互换），听感是「先响后轻」。
        var previous = -1f
        for (p in samples) {
            val value = CrossfadeCurve.incoming(CrossfadeCurve.EQUAL_POWER, p)
            assertTrue("progress=$p 处出现回退：$previous -> $value", value >= previous - 1e-6f)
            previous = value
        }
    }
}
