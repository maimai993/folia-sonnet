package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/NativeLyricsCacheTest.kt
// 原生兜底歌词缓存：换歌清空、拉完才给、晚到的旧结果不覆盖当前这首（#106）。

class NativeLyricsCacheTest {

    @Test
    fun `换歌先清空上一首的歌词`() {
        val cache = NativeLyricsCache()
        cache.store("a", "[00:01]旧词", "old")
        cache.clear("b")
        assertNull(cache.snapshot("b"))
        assertNull(cache.snapshot("a"))
    }

    @Test
    fun `拉完之前不给快照`() {
        val cache = NativeLyricsCache()
        cache.clear("a")
        assertNull(cache.snapshot("a"))
    }

    @Test
    fun `拉到了就按 songKey 返回`() {
        val cache = NativeLyricsCache()
        cache.store("a", "[00:01]词", "translated")
        val snapshot = cache.snapshot("a")
        assertNotNull(snapshot)
        assertEquals("a", snapshot!!.songKey)
        assertEquals("[00:01]词", snapshot.lrc)
        assertEquals("translated", snapshot.translated)
    }

    @Test
    fun `没歌词也要留显式空结果`() {
        val cache = NativeLyricsCache()
        cache.store("a", null, null)
        val snapshot = cache.snapshot("a")
        assertNotNull(snapshot)
        assertEquals("", snapshot!!.lrc)
        assertEquals("", snapshot.translated)
    }

    @Test
    fun `晚到的旧歌结果不能覆盖新歌`() {
        val cache = NativeLyricsCache()
        cache.clear("b")
        // 上一首的异步结果晚到：快照按当前 songKey 认领，不能把它交出去。
        cache.store("a", "[00:01]旧词", "")
        assertNull(cache.snapshot("b"))
    }
}
