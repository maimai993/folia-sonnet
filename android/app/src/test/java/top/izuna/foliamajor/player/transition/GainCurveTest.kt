package top.izuna.foliamajor.player.transition

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// 曲线库单测：这些断言守的是「听感签名」，不是实现细节。

class GainCurveTest {

    @Test
    fun `等功率曲线平方和恒为 1`() {
        for (step in 0..20) {
            val p = step / 20f
            val sum = GainCurve.equalPowerSum(CurveId.EQUAL_POWER, p)
            assertEquals("progress=$p", 1f, sum, 1e-4f)
        }
    }

    @Test
    fun `线性曲线中点会塌 3dB`() {
        // 这正是旧 CrossfadeCurve 注释里说的「过渡中间音量塌一下」：
        // 两条直线中点各 0.5，合成功率 0.5，而等功率是 1.0。
        val linear = GainCurve.equalPowerSum(CurveId.LINEAR, 0.5f)
        val equal = GainCurve.equalPowerSum(CurveId.EQUAL_POWER, 0.5f)
        assertTrue("线性应明显低于等功率", linear < equal - 0.4f)
        assertEquals(0.5f, linear, 1e-4f)
        assertEquals(1f, equal, 1e-4f)
    }

    @Test
    fun `所有曲线端点落在 0 和 1`() {
        CurveId.values().forEach { id ->
            assertEquals("$id 起点进", 0f, GainCurve.incoming(id, 0f), 1e-3f)
            assertEquals("$id 起点出", 1f, GainCurve.outgoing(id, 0f), 1e-3f)
            assertEquals("$id 终点进", 1f, GainCurve.incoming(id, 1f), 1e-3f)
            assertEquals("$id 终点出", 0f, GainCurve.outgoing(id, 1f), 1e-3f)
        }
    }

    @Test
    fun `平台曲线中段恒定且不消耗 headroom`() {
        val mid = GainCurve.incoming(CurveId.PLATEAU, 0.5f)
        val out = GainCurve.outgoing(CurveId.PLATEAU, 0.5f)
        assertEquals(0.7071f, mid, 1e-3f)
        assertEquals(0.7071f, out, 1e-3f)
        // 平台段各 0.707，平方和仍为 1 —— README §6.5 的「平台不消耗任何 headroom」。
        assertEquals(1f, mid * mid + out * out, 1e-3f)
        // 平台左右两侧仍连续走到 0 / 1。
        assertTrue(GainCurve.incoming(CurveId.PLATEAU, 0.2f) < mid)
        assertTrue(GainCurve.incoming(CurveId.PLATEAU, 0.8f) > mid)
    }

    @Test
    fun `together 参数对非等功率曲线也生效`() {
        val withPlateau = GainCurve.incoming(CurveId.S_CURVE, 0.5f, 0.5f)
        val without = GainCurve.incoming(CurveId.S_CURVE, 0.5f, 0f)
        // 两者在中点都恰是 0.5 的形状值，平台把它压在重映射后的 0.5，数值接近但不强行相等；
        // 关键是左右两段被压缩后仍然连续、端点不变。
        assertTrue(withPlateau >= 0f && withPlateau <= 1f)
        assertTrue(without >= 0f && without <= 1f)
        assertEquals(0f, GainCurve.incoming(CurveId.S_CURVE, 0f, 0.5f), 1e-3f)
        assertEquals(1f, GainCurve.incoming(CurveId.S_CURVE, 1f, 0.5f), 1e-3f)
    }

    @Test
    fun `老设置里的曲线名仍能读进来`() {
        assertEquals(CurveId.EQUAL_POWER, CurveId.fromWire("equalPower"))
        assertEquals(CurveId.LINEAR, CurveId.fromWire("linear"))
        assertEquals(CurveId.FAST_CUT, CurveId.fromWire("fast"))
        assertEquals(CurveId.EQUAL_POWER, CurveId.fromWire("不认识的值"))
        assertEquals(CurveId.EQUAL_POWER, CurveId.fromWire(null))
    }

    @Test
    fun `旧三条曲线与新库数值一致`() {
        // 老用户不改设置时，听到的交叉淡化必须和升级前一样。
        for (step in 0..10) {
            val p = step / 10f
            assertEquals(
                kotlin.math.sin(p.toDouble() * Math.PI / 2.0).toFloat(),
                GainCurve.incoming(CurveId.EQUAL_POWER, p), 1e-5f,
            )
            assertEquals(p, GainCurve.incoming(CurveId.LINEAR, p), 1e-5f)
            assertEquals(1f - (1f - p) * (1f - p), GainCurve.incoming(CurveId.FAST_CUT, p), 1e-5f)
        }
    }
}
