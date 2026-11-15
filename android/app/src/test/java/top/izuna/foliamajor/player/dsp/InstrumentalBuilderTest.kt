package top.izuna.foliamajor.player.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/dsp/InstrumentalBuilderTest.kt
// 分离进度换算。
//
// 这几条数字看着琐碎，但它们守的是「进度条不会倒退、不会越界」：
// 倒退一次用户就以为重来了一遍，越界回 0 就直接像是卡死了。
class InstrumentalBuilderTest {

    @Test
    fun `还没开始时停在 6`() {
        // 0 个窗口完成时不能是 0%：前 6% 是解码与模型加载，已经走完了。
        assertEquals(6, InstrumentalBuilder.percentForWindow(0, 20))
    }

    @Test
    fun `全部跑完停在 99`() {
        // 100% 留给「文件写完」—— 分离完成那一刻磁盘上还可能只有一个 .part。
        assertEquals(99, InstrumentalBuilder.percentForWindow(20, 20))
    }

    @Test
    fun `不会越界`() {
        // 编码器多吐一个窗口、或总数为 0（空音频）时都不能算出负数或 100+。
        assertEquals(99, InstrumentalBuilder.percentForWindow(25, 20))
        assertEquals(6, InstrumentalBuilder.percentForWindow(0, 0))
        assertTrue(InstrumentalBuilder.percentForWindow(3, 7) in 6..99)
    }

    @Test
    fun `单调不减`() {
        val total = 23
        var previous = -1
        for (done in 0..total) {
            val percent = InstrumentalBuilder.percentForWindow(done, total)
            assertTrue("第 $done 个窗口时进度倒退了：$previous -> $percent", percent >= previous)
            previous = percent
        }
    }
}
