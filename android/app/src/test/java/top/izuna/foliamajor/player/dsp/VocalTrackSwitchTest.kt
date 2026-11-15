package top.izuna.foliamajor.player.dsp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/dsp/VocalTrackSwitchTest.kt
// 锁定「只留人声 → 关闭人声」这条曾经切错导致没声音的路径。
//
// 换源判据必须是「此刻播的是不是这一轨」。旧的写法用 `!player.isOnInstrumental()`：
// 伴奏和清唱都算 true，于是从清唱切伴奏时换源被短路，播放器停在清唱轨上，
// 而中置相消已开 —— 用户听到的就是静音。这组用例守住三态两两之间都能正确换源。
class VocalTrackSwitchTest {

    private val original = "https://cdn.example.com/song.mp3"
    private val instrumental = "file:///cache/abc.m4a"
    private val vocal = "file:///cache/abc.vocal.m4a"

    @Test
    fun `原曲切到伴奏要换源`() {
        assertTrue(shouldSwapVocalTrack(original, instrumental))
    }

    @Test
    fun `原曲切到清唱要换源`() {
        assertTrue(shouldSwapVocalTrack(original, vocal))
    }

    @Test
    fun `只留人声切到关闭人声 必须换到伴奏轨 这就是没声音的回归场景`() {
        // 两轨都算 isOnInstrumental()==true，但地址不同 —— 必须切，不能短路。
        assertTrue(shouldSwapVocalTrack(vocal, instrumental))
    }

    @Test
    fun `关闭人声切到只留人声 必须换到清唱轨`() {
        assertTrue(shouldSwapVocalTrack(instrumental, vocal))
    }

    @Test
    fun `关掉两个开关 从分离轨换回原曲要换源`() {
        assertTrue(shouldSwapVocalTrack(instrumental, original))
        assertTrue(shouldSwapVocalTrack(vocal, original))
    }

    @Test
    fun `已经在目标轨时不重复 prepare`() {
        assertFalse(shouldSwapVocalTrack(instrumental, instrumental))
        assertFalse(shouldSwapVocalTrack(vocal, vocal))
        assertFalse(shouldSwapVocalTrack(original, original))
    }

    @Test
    fun `还没装过地址时也要换到目标轨`() {
        assertTrue(shouldSwapVocalTrack(null, instrumental))
    }

    // ---- 生成完换源前的严格身份校验（「切下一首歌却用了上一首的数据」回归） ----

    private val firstUrl = "https://cdn.example.com/first.mp3"
    private val secondUrl = "https://cdn.example.com/second.mp3"

    @Test
    fun `还是同一首歌时放行`() {
        assertTrue(stillPlayingGeneratedTrack(firstUrl, "song:first", firstUrl, "song:first"))
    }

    @Test
    fun `切到下一首歌后 上一首拆完不许换源 这是串歌的回归场景`() {
        // 旧判据 keyFor(baseUrl, songKey) 只看 songKey（生成时那一首的），
        // 所以切歌后仍算「同一首」，把上一首的伴奏装到了新歌上。
        assertFalse(stillPlayingGeneratedTrack(secondUrl, "song:second", firstUrl, "song:first"))
    }

    @Test
    fun `地址变了但 songKey 没跟上时不许换源`() {
        assertFalse(stillPlayingGeneratedTrack(secondUrl, "song:first", firstUrl, "song:first"))
    }

    @Test
    fun `songKey 为空的老路径只比原曲地址`() {
        assertTrue(stillPlayingGeneratedTrack(firstUrl, "", firstUrl, null))
        assertFalse(stillPlayingGeneratedTrack(secondUrl, "", firstUrl, null))
    }

    @Test
    fun `当前歌没有身份时宁可不换`() {
        assertFalse(stillPlayingGeneratedTrack(firstUrl, "", firstUrl, "song:first"))
        assertFalse(stillPlayingGeneratedTrack(null, "song:first", firstUrl, "song:first"))
    }

    // ---- 三态原子接口：值 → 目标轨的映射（「切人声放的是全部、切全部放的是人声」回归） ----

    @Test
    fun `三态取值各自映到正确的轨 未知值一律当全部`() {
        assertEquals(VocalTrackMode.INSTRUMENTAL, vocalTrackModeOf("instrumental"))
        assertEquals(VocalTrackMode.VOCAL, vocalTrackModeOf("vocal"))
        assertNull(vocalTrackModeOf("off"))
        assertNull(vocalTrackModeOf(null))
        assertNull(vocalTrackModeOf("随便什么"))
    }

    @Test
    fun `三态连续切换 每一跳都落在目标轨 不串到上一态`() {
        // 原子接口一次写定两个开关、只 reconcile 一次；这里把「当前轨 → 目标轨 → 换源」
        // 走一遍，确认映射与换源判据组合起来不会把上一轨留到下一步。
        var currentUrl: String? = original
        val targetOf = { mode: VocalTrackMode? -> when (mode) {
            VocalTrackMode.INSTRUMENTAL -> instrumental
            VocalTrackMode.VOCAL -> vocal
            null -> original
        } }
        for (next in listOf("instrumental", "vocal", "off", "vocal", "instrumental", "off")) {
            val target = targetOf(vocalTrackModeOf(next))
            if (shouldSwapVocalTrack(currentUrl, target)) currentUrl = target
            assertEquals("切到 $next 后应停在目标轨", target, currentUrl)
        }
    }
}
