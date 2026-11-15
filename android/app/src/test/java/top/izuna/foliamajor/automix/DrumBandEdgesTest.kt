package top.izuna.foliamajor.automix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/automix/DrumBandEdgesTest.kt
// 混音鼓点三条频带的边界，与 Web 侧 drumHitPicking.ts / beatThis.ts 对账（#344）。
//
// 基准值来自 Web 侧 `melBandCentresHz()` + `drumBandTracks` 的同一套边界（0/150/4000/6000），
// 在 vitest 里跑出来写死在这里。两边任何一边改了边界或 mel 公式，这里就红，不会再悄悄漂移。

class DrumBandEdgesTest {

    private val centres = DrumBandEdges.melBandCentres(128, 30.0, 11000.0)

    private fun band(kind: Int) = DrumBandEdges.pickBands(centres, kind)

    @Test
    fun `mel 中心频率与 Web 侧逐点一致`() {
        assertEquals(128, centres.size)
        assertEquals(55.54396640387823, centres[0], 1e-9)
        assertEquals(2037.9612153053977, centres[64], 1e-9)
        assertEquals(5260.85822394576, centres[100], 1e-9)
        assertEquals(10714.011559875331, centres[127], 1e-9)
    }

    @Test
    fun `三条带的 mel 带归属与 Web 一致`() {
        // Web：kick 0..3（4 条）、snare 4..89（86 条）、hat 105..127（23 条）
        assertEquals((0..3).toList(), band(0))
        assertEquals((4..89).toList(), band(1))
        assertEquals((105..127).toList(), band(2))
    }

    @Test
    fun `4 到 6 kHz 的空档不属于任何一条带`() {
        // Web：空档 90..104 共 15 条。旧 Android 把它们算进 hat（hat 有 38 条而不是 23 条）。
        val gap = (90..104).toList()
        for (index in gap) {
            for (kind in 0..2) {
                assertTrue("mel 带 $index（${centres[index]} Hz）不该落进第 $kind 条带", index !in band(kind))
            }
        }
        assertEquals(15, gap.size)
        assertEquals(23, band(2).size)
    }

    @Test
    fun `hat 起点是 6000 Hz 而不是 4000 Hz`() {
        assertEquals(6000.0, DrumBandEdges.HAT_MIN_HZ, 0.0)
        assertTrue("hat 里最低的一条中心频率应不低于 6000", centres[band(2).first()] >= 6000.0)
        assertTrue("空档最高的一条应低于 6000", centres[90 + 14] < 6000.0)
        // 4–6 kHz 的军鼓高频（例如 5260 Hz 的那条）不能再算 hat
        assertTrue(100 !in band(2))
    }

    @Test
    fun `三条带互不重叠 而且按频率升序`() {
        val all = band(0) + band(1) + band(2)
        assertEquals(all.size, all.toSet().size)
        assertEquals(all.sorted(), all)
        assertEquals(4 + 86 + 23, all.size)
    }

    @Test
    fun `边界常量与 Web 侧一致`() {
        assertEquals(150.0, DrumBandEdges.KICK_MAX_HZ, 0.0)
        assertEquals(4000.0, DrumBandEdges.SNARE_MAX_HZ, 0.0)
        assertEquals(6000.0, DrumBandEdges.HAT_MIN_HZ, 0.0)
        assertEquals(Double.POSITIVE_INFINITY, DrumBandEdges.BANDS[2][1], 0.0)
    }

    @Test
    fun `空的 mel 中心频率不崩`() {
        assertEquals(emptyList<Int>(), DrumBandEdges.pickBands(DoubleArray(0), 0))
    }
}
