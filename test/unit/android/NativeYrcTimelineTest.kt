package top.izuna.foliamajor.online

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// 原生 YRC / LRC 时间轴回归：测试经 MusicGateway 生产入口，不依赖网络或真实账号。
class NativeYrcTimelineTest {
    @Test
    fun `YRC 不再被 LRC 入口丢成零行并保留逐字时间`() {
        val main = "[12000,3000](12000,1500,0)第一(13500,1500,0)句\n" +
                "[15000,2000](15000,2000,0)第二句"
        val lines = MusicGateway.parseLrc(main, "[00:12.000]first")
        assertEquals(2, lines.size)
        assertEquals("第一句", lines[0].text)
        assertEquals(12000L, lines[0].startMs)
        assertEquals(15000L, lines[0].endMs)
        assertEquals("first", lines[0].translation)
        assertEquals(2, lines[0].words!!.size)
        assertEquals(13500L, lines[0].words!![1].startMs)
        assertEquals(15000L, lines[0].words!![1].endMs)
    }

    @Test
    fun `普通 LRC 和多时间戳不受 YRC 适配影响`() {
        assertNull(NativeYrcTimeline.parse("[00:01]普通歌词", ""))
        val lines = MusicGateway.parseLrc("[00:01][00:03]普通歌词", "[00:03]翻译")
        assertEquals(2, lines.size)
        assertEquals("普通歌词", lines[0].text)
        assertEquals("翻译", lines[1].translation)
    }

    @Test
    fun `YRC 支持 BOM 和乱序并拒绝溢出时间`() {
        val lines = MusicGateway.parseLrc("\uFEFF[2000,1000](2000,1000,0)后\n" +
                "[1000,1000](1000,1000,0)前\n" +
                "[9223372036854775807,1000](0,10,0)错", "")
        assertEquals(listOf("前", "后"), lines.map { it.text })
        assertTrue(MusicGateway.parseLrc("[12000,3000]没有合法词时间", "").isEmpty())
    }
}
