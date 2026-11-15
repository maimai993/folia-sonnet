package top.izuna.foliamajor.online

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

// 酷狗候选下载契约来自实测响应；用合成歌词替代实际版权内容，测试不出网。
class KugouNativeLyricsTest {
    private val hash = "ED943F43073EE12DE264C1DCD83163E1"

    @Test
    fun `按 hash 搜候选再解码下载 LRC`() {
        val urls = mutableListOf<String>()
        val lyric = "[00:01.00]合成歌词"
        val result = KugouNativeLyrics.fetch(hash) { url ->
            urls.add(url)
            if (url.contains("/search?")) """{"status":200,"candidates":[{"id":"123","accesskey":"synthetic"}]}"""
            else """{"status":200,"content":"${Base64.getEncoder().encodeToString(lyric.toByteArray(Charsets.UTF_8))}"}"""
        }
        assertEquals(lyric, result)
        assertEquals(2, urls.size)
        assertTrue(urls[0].contains("hash=$hash"))
        assertTrue(urls[1].contains("fmt=lrc"))
        assertTrue(urls.none { it.contains("m.kugou.com/krc") })
    }

    @Test
    fun `没有候选不假报有歌词`() {
        assertNull(KugouNativeLyrics.fetch(hash) { """{"status":200,"candidates":[]}""" })
    }

    @Test
    fun `HTTP200 的 No Action Found 不被视为歌词`() {
        val result = KugouNativeLyrics.fetch(hash) { url ->
            if (url.contains("/search?")) """{"candidates":[{"id":"123","accesskey":"synthetic"}]}"""
            else """{"content":"${Base64.getEncoder().encodeToString("No Action Found!".toByteArray())}"}"""
        }
        assertNull(result)
        assertNull(KugouNativeLyrics.fetch("invalid") { error("invalid hash must not request") })
    }
}
