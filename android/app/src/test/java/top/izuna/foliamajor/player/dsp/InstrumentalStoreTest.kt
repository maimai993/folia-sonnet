package top.izuna.foliamajor.player.dsp

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

// android/app/src/test/java/top/izuna/foliamajor/player/dsp/InstrumentalStoreTest.kt
// 伴奏缓存的纯文件逻辑。
//
// 这层的失败方式都不响：键算错 = 每次播放都重新分离一遍（几十秒）；
// LRU 算错 = 要么删掉正在听的那首，要么缓存无限涨。
class InstrumentalStoreTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = File(System.getProperty("java.io.tmpdir"), "instrumental-test-${System.nanoTime()}")
        dir.mkdirs()
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun `同一首歌的缓存键稳定`() {
        val first = InstrumentalStore.keyFor("http://a/1.mp3", "netease:123")
        val second = InstrumentalStore.keyFor("http://b/2.mp3", "netease:123")
        // 直链会换 CDN、会过期：键必须跟着 songKey 走，否则每播一次都要重新分离。
        assertEquals(first, second)
    }

    @Test
    fun `没有 songKey 时才按地址区分`() {
        val a = InstrumentalStore.keyFor("http://a/1.mp3", null)
        val b = InstrumentalStore.keyFor("http://a/2.mp3", null)
        assertNotEquals(a, b)
    }

    @Test
    fun `键是定长的十六进制`() {
        val key = InstrumentalStore.keyFor("https://x", "local:abc")
        assertEquals(32, key.length)
        assertTrue(key.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun `超过上限时先删最久没用的`() {
        val old = file("old.m4a", 400)
        val fresh = file("fresh.m4a", 400)
        old.setLastModified(1_000_000L)
        fresh.setLastModified(2_000_000L)

        InstrumentalStore.trimDirectory(dir, limitBytes = 500)

        assertFalse("最旧的那首要被删", old.exists())
        assertTrue("最近用过的要留下", fresh.exists())
    }

    @Test
    fun `正在用的那首即使最旧也不能删`() {
        val playing = file("playing.m4a", 400)
        val other = file("other.m4a", 400)
        playing.setLastModified(1_000_000L)
        other.setLastModified(2_000_000L)

        InstrumentalStore.trimDirectory(dir, limitBytes = 100, keep = playing)

        assertTrue("正在播的伴奏不能被清掉", playing.exists())
        assertFalse(other.exists())
    }

    @Test
    fun `半成品会被扫掉`() {
        val done = file("done.m4a", 10)
        val temp = file("half.m4a.part", 10)

        InstrumentalStore.sweepDirectory(dir)

        assertTrue(done.exists())
        assertFalse(temp.exists())
    }

    @Test
    fun `删除分离缓存把两轨正式文件与半成品一起清掉`() {
        // 「要清的是人声分离数据的缓存」：这一按必须真的删掉 m4a，
        // 不能像旧版那样只清了 IndexedDB 里的分析曲线。
        val inst = file("abc.m4a", 100)
        val vocal = file("abc.vocal.m4a", 100)
        val temp = file("abc.m4a.part", 100)

        InstrumentalStore.clearDirectory(dir)

        assertFalse("伴奏要删", inst.exists())
        assertFalse("清唱要删", vocal.exists())
        assertFalse("半成品也要删，否则会被当成孤儿留着", temp.exists())
        assertTrue("目录本身留着复用", dir.isDirectory)
    }

    @Test
    fun `删完用量快照归零 界面不会再显示旧的几首`() {
        file("abc.m4a", 100)
        file("abc.vocal.m4a", 100)
        InstrumentalStore.measure(dir, 123)
        assertEquals(2, InstrumentalStore.usage().second)

        InstrumentalStore.clearDirectory(dir)
        InstrumentalStore.measure(dir, 123)

        val (usedBytes, usedCount) = InstrumentalStore.usage()
        assertEquals(0L, usedBytes)
        assertEquals(0, usedCount)
    }

    @Test
    fun `空间充裕时上限到天花板`() {
        // 128G 剩余：按 1/4 算是 32G，必须被 2G 的天花板截住，
        // 否则一台大存储手机能被缓存吃到几十 G。
        assertEquals(InstrumentalStore.MAX_BYTES, InstrumentalStore.limitFor(128L * 1024 * 1024 * 1024))
        assertEquals(2L * 1024 * 1024 * 1024, InstrumentalStore.MAX_BYTES)
    }

    @Test
    fun `空间紧张时上限跟着缩`() {
        val free = 1024L * 1024 * 1024 // 剩 1G
        val limit = InstrumentalStore.limitFor(free)
        // (1024 - 300) / 4 = 181MB
        assertEquals(181L * 1024 * 1024, limit)
        assertTrue("上限必须远小于剩余空间", limit < free / 2)
    }

    @Test
    fun `余量都不够时不缓存`() {
        // 剩 200M 连预留的 300M 都不够：上限是 0，不是负数。
        assertEquals(0L, InstrumentalStore.limitFor(200L * 1024 * 1024))
        assertEquals(0L, InstrumentalStore.limitFor(0L))
    }

    private fun file(name: String, bytes: Int): File =
        File(dir, name).apply {
            writeBytes(ByteArray(bytes))
        }
}
