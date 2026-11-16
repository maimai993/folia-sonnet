package top.izuna.foliamajor.player.dsp

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/player/dsp/InstrumentalSourceFreshnessTest.kt
// 「切回全部时手上的原曲地址还能不能用」的判据。
//
// 用户报的现象：分离缓存生成完之后切回「全部」，播放器不重新去拉原曲音频，
// 本地又没有原曲的媒体缓存副本 —— 结果就是放不出来（界面显示全部，却没有声音）。
// 这一组用例锁住「什么情况下必须重新要一条地址」。
class InstrumentalSourceFreshnessTest {

    private val minute = 60_000L

    // ---- looksSigned：带时效签名的地址一律当作随时会失效 ----

    @Test
    fun `视频站的取流地址带签名 deadline`() {
        assertTrue(
            InstrumentalCoordinator.looksSigned(
                "https://xy1x2.mcdn.bilivideo.cn:8082/v1/resource/a.m4s?deadline=1735689600&upsig=abc",
            ),
        )
    }

    @Test
    fun `音乐平台的直链带 expires 或 token`() {
        assertTrue(
            InstrumentalCoordinator.looksSigned(
                "https://m8.music.126.net/20260101/abc.mp3?expires=1735689600",
            ),
        )
        assertTrue(
            InstrumentalCoordinator.looksSigned(
                "https://example.cdn.com/song.mp3?token=xyz",
            ),
        )
    }

    @Test
    fun `本地文件与回环地址永远不过期`() {
        assertFalse(InstrumentalCoordinator.looksSigned("file:///data/cache/abc.m4a"))
        assertFalse(InstrumentalCoordinator.looksSigned("http://127.0.0.1:1234/media-cache/abc"))
        assertFalse(InstrumentalCoordinator.looksSigned("http://localhost:1234/remote-audio/abc"))
    }

    @Test
    fun `没有签名参数的长链不算签名`() {
        assertFalse(InstrumentalCoordinator.looksSigned("https://cdn.example.com/song.mp3"))
    }

    @Test
    fun `空地址不算签名`() {
        assertFalse(InstrumentalCoordinator.looksSigned(null))
        assertFalse(InstrumentalCoordinator.looksSigned(""))
    }

    // ---- sourceMayBeStale：什么时候该重新要一条 ----

    @Test
    fun `带签名的一律要新的 哪怕刚装进去`() {
        // 一秒之前刚装的，但地址带签名：重新要一次只是一个请求，不要赌它还活着。
        assertTrue(
            InstrumentalCoordinator.sourceMayBeStale(
                preparedAt = 1_000L,
                now = 2_000L,
                signed = true,
            ),
        )
    }

    @Test
    fun `没签名且刚装的不必重要`() {
        assertFalse(
            InstrumentalCoordinator.sourceMayBeStale(
                preparedAt = 10 * minute,
                now = 10 * minute,
                signed = false,
            ),
        )
    }

    @Test
    fun `没签名但放了很久要重要`() {
        assertTrue(
            InstrumentalCoordinator.sourceMayBeStale(
                preparedAt = 0L,
                now = 60 * minute,
                signed = false,
            ),
        )
    }

    @Test
    fun `不知道什么时候装的一律重要`() {
        // preparedAt 为 0 表示这一版之前装的、或者压根没记 —— 无从判断，要新的最安全。
        assertTrue(
            InstrumentalCoordinator.sourceMayBeStale(
                preparedAt = 0L,
                now = 1L,
                signed = false,
            ),
        )
    }
}
