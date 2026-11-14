package top.izuna.foliamajor.player.transition

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MusicalTimeTest {

    @Test
    fun `二倍速等价`() {
        assertEquals(1f, MusicalTime.foldOctave(2f), 1e-4f)
        assertEquals(1f, MusicalTime.foldOctave(0.5f), 1e-4f)
        assertEquals(1f, MusicalTime.foldOctave(4f), 1e-4f)
        assertEquals(1.1f, MusicalTime.foldOctave(2.2f), 1e-4f)
    }

    @Test
    fun `速度关系分级`() {
        assertEquals(TempoRelation.UNKNOWN, MusicalTime.relation(null, 120f))
        assertEquals(TempoRelation.LOCKED, MusicalTime.relation(120f, 120f))
        assertEquals(TempoRelation.NEAR, MusicalTime.relation(120f, 126f))
        assertEquals(TempoRelation.STRETCHABLE, MusicalTime.relation(120f, 132f))
        assertEquals(TempoRelation.DRIFTING, MusicalTime.relation(120f, 144f))
        assertEquals(TempoRelation.FAR, MusicalTime.relation(120f, 180f))
        // 70 与 140 是同一个网格，不该被当成 FAR。
        assertEquals(TempoRelation.LOCKED, MusicalTime.relation(70f, 140f))
    }

    @Test
    fun `只弯出场曲且不超过 12%`() {
        assertEquals(1.1f, MusicalTime.outgoingStretch(120f, 132f), 1e-3f)
        assertEquals(1f, MusicalTime.outgoingStretch(120f, 180f), 1e-4f)
        assertEquals(1f, MusicalTime.outgoingStretch(null, 132f), 1e-4f)
        val clamped = MusicalTime.outgoingStretch(100f, 119f)
        assertTrue(clamped <= 1f + MusicalTime.STRETCH_LIMIT)
    }

    @Test
    fun `小节对齐把秒数折算成拍`() {
        val bpm = 120f // 一小节 2000 ms
        assertEquals(2_000f, MusicalTime.barMs(bpm), 1e-2f)
        assertEquals(4_000L, MusicalTime.nextBarBoundary(3_000L, bpm))
        // 5 秒会被向上取整到 4 小节（8 秒），而不是停在 5 秒。
        assertEquals(8_000, MusicalTime.snapToBars(5_000, bpm, 2_000, 24_000))
        // 没有 BPM 时按原值夹取，不乱猜。
        assertEquals(5_000, MusicalTime.snapToBars(5_000, 0f, 2_000, 24_000))
    }

    @Test
    fun `入场点对齐到小节线`() {
        val bpm = 120f
        assertEquals(4_000L, MusicalTime.alignInStart(5_200L, bpm))
        assertEquals(0L, MusicalTime.alignInStart(800L, bpm))
    }
}
