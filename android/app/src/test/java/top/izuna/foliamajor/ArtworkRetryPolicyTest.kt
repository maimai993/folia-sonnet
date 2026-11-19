package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

// android/app/src/test/java/top/izuna/foliamajor/ArtworkRetryPolicyTest.kt
// 通知封面持续退避重试、网络恢复触发与切歌代次隔离单元测试（#348）。
// 去重维度是 songKey（#383）：同歌无论同 URL 还是换签名 URL 都不重复请求，切歌才重来。

class ArtworkRetryPolicyTest {

    private val songA = "netease:1001"
    private val songB = "netease:1002"
    private val urlA1 = "https://cdn.example.com/a.jpg?sign=1&exp=1700000000"
    private val urlA2 = "https://cdn.example.com/a.jpg?sign=2&exp=1700000600"

    @Test
    fun `退避时间封顶并持续安排 不会在 30 秒后永久放弃`() {
        assertEquals(2_000L, ArtworkRetryPolicy.nextDelayMs(-1))
        assertEquals(2_000L, ArtworkRetryPolicy.nextDelayMs(0))
        assertEquals(4_000L, ArtworkRetryPolicy.nextDelayMs(1))
        assertEquals(8_000L, ArtworkRetryPolicy.nextDelayMs(2))
        assertEquals(16_000L, ArtworkRetryPolicy.nextDelayMs(3))
        assertEquals(32_000L, ArtworkRetryPolicy.nextDelayMs(4))
        assertEquals(60_000L, ArtworkRetryPolicy.nextDelayMs(5))
        assertEquals(60_000L, ArtworkRetryPolicy.nextDelayMs(9))
        assertEquals(300_000L, ArtworkRetryPolicy.nextDelayMs(10))
        assertEquals(300_000L, ArtworkRetryPolicy.nextDelayMs(50))
    }

    @Test
    fun `本地协议或空地址识别`() {
        assertTrue(ArtworkRetryPolicy.isLocalOnlyUrl(null))
        assertTrue(ArtworkRetryPolicy.isLocalOnlyUrl(""))
        assertTrue(ArtworkRetryPolicy.isLocalOnlyUrl("   "))
        assertTrue(ArtworkRetryPolicy.isLocalOnlyUrl("blob:https://example.com/1"))
        assertTrue(ArtworkRetryPolicy.isLocalOnlyUrl("BLOB:123"))
        assertTrue(ArtworkRetryPolicy.isLocalOnlyUrl("data:image/jpeg;base64,/9j/"))
        assertFalse(ArtworkRetryPolicy.isLocalOnlyUrl("https://cdn.example.com/cover.jpg"))
        assertFalse(ArtworkRetryPolicy.isLocalOnlyUrl("http://127.0.0.1:9000/cover"))
    }

    @Test
    fun `久后台连续失败超过旧 4 次窗口仍继续调度 直到成功为止`() {
        val now = AtomicLong(1_000L)
        val tracker = ArtworkFetchTracker { now.get() }

        var req = tracker.beginRequest(urlA1, songA)
        assertNotNull(req)
        // 同一首在途时再推一次同一条 update：不重复拉
        assertNull(tracker.beginRequest(urlA1, songA))

        // 连续 12 次临时失败，仍应持续返回重试计划
        val delays = mutableListOf<Long>()
        for (i in 1..12) {
            val plan = tracker.onFetchTransientFailure(req!!)
            assertNotNull("第 $i 次失败后仍应安排重试", plan)
            delays.add(plan!!.delayMs)
            assertEquals(i, plan.attemptNumber)
            now.addAndGet(plan.delayMs)
            req = tracker.beginScheduledRetry(plan)
            assertNotNull(req)
        }
        assertEquals(2_000L, delays[0])
        assertEquals(60_000L, delays[5])
        assertEquals(300_000L, delays[10])
        assertEquals(300_000L, delays[11])

        // 最终网络恢复成功
        assertTrue(tracker.onFetchSucceeded(req!!))
        assertEquals(urlA1, tracker.snapshotArtworkUrl())
        // 已有封面时回前台与网络恢复不再重复拉取
        assertNull(tracker.canRecoverOnForeground())
        assertNull(tracker.canRecoverOnNetwork())
    }

    @Test
    fun `同歌同 URL 多次 update 只下载一次`() {
        val now = AtomicLong(1_000L)
        val tracker = ArtworkFetchTracker { now.get() }

        val first = tracker.beginRequest(urlA1, songA)!!
        assertTrue(tracker.onFetchSucceeded(first))

        // 歌词到了重推、播放状态重推、回前台：同一条 update 再来多少次都不该再起请求
        repeat(5) {
            now.addAndGet(1_000L)
            assertNull(tracker.beginRequest(urlA1, songA))
        }
        assertNull(tracker.canRecoverOnForeground())
        assertNull(tracker.canRecoverOnNetwork())
        // 地址没被动过，日志 / 快照读到的还是那一条
        assertEquals(urlA1, tracker.snapshotArtworkUrl())
    }

    @Test
    fun `同歌换了签名 URL 也不再重新请求`() {
        val now = AtomicLong(1_000L)
        val tracker = ArtworkFetchTracker { now.get() }

        val first = tracker.beginRequest(urlA1, songA)!!
        assertTrue(tracker.onFetchSucceeded(first))

        // 签名到期，Web 层整首周期性换一个新签名：同一首歌已经拿到过封面，不再 HEAD + 写盘
        now.addAndGet(600_000L)
        assertNull(tracker.beginRequest(urlA2, songA))
        assertNull(tracker.canRecoverOnForeground())
        // 快照里的地址不跟着变，晚到的歌词请求仍然拿到原来那条（都能用，且更可能是被缓存过的那条）
        assertEquals(urlA1, tracker.snapshotArtworkUrl())
    }

    @Test
    fun `切歌后磁盘命中不再发请求`() {
        val now = AtomicLong(1_000L)
        val tracker = ArtworkFetchTracker { now.get() }

        val songAReq = tracker.beginRequest(urlA1, songA)!!
        assertTrue(tracker.onFetchSucceeded(songAReq))

        // 切歌：换到另一首，允许起一次请求
        tracker.onSongChanged(songB)
        val songBUrl = "https://cdn.example.com/b.jpg"
        val songBReq = tracker.beginRequest(songBUrl, songB)!!
        assertTrue(songBReq.generation > songAReq.generation)

        // 那次请求临时失败，随后用磁盘缓存补上（服务里 handleTransientArtworkFailure 的磁盘命中分支）
        assertNotNull(tracker.onFetchTransientFailure(songBReq))
        tracker.onExternalArtworkLoaded(songB)

        // 这一首之后同一条 update 再来（同 URL / 换签名 URL）都不再请求，也不再走补拉
        assertNull(tracker.beginRequest(songBUrl, songB))
        assertNull(tracker.beginRequest("https://cdn.example.com/b.jpg?sign=9", songB))
        assertNull(tracker.canRecoverOnForeground())
        assertNull(tracker.canRecoverOnNetwork())
    }

    @Test
    fun `没有封面时切歌回来仍会重新请求`() {
        val tracker = ArtworkFetchTracker()

        assertNotNull(tracker.beginRequest(urlA1, songA))
        // 切走再从这首歌切回来：上一次没拿到封面，这一首仍然缺，要重新拉
        tracker.onSongChanged(songB)
        assertNotNull(tracker.beginRequest("https://cdn.example.com/b.jpg", songB))
        tracker.onSongChanged(songA)
        assertNotNull(tracker.beginRequest(urlA1, songA))
    }

    @Test
    fun `上一首晚到的磁盘命中不会把当前这首记成已有封面`() {
        val tracker = ArtworkFetchTracker()

        val songAReq = tracker.beginRequest(urlA1, songA)!!
        tracker.onSongChanged(songB)
        val songBUrl = "https://cdn.example.com/b.jpg"
        val songBReq = tracker.beginRequest(songBUrl, songB)!!

        // A 的下载 / 磁盘读取晚到：只认当前这一首
        tracker.onExternalArtworkLoaded(songA)
        assertFalse(tracker.onFetchSucceeded(songAReq))

        // B 仍然缺封面，临时失败后照常安排重试
        assertNotNull(tracker.onFetchTransientFailure(songBReq))
    }

    @Test
    fun `网络恢复回调按节流间隔立即清零退避并重拉`() {
        val now = AtomicLong(5_000L)
        val tracker = ArtworkFetchTracker { now.get() }

        val req1 = tracker.beginRequest(urlA1, songA)!!
        val plan = tracker.onFetchTransientFailure(req1)!!
        assertEquals(2_000L, plan.delayMs)

        // 刚失败 500ms 内抖动不立即触发
        now.addAndGet(500L)
        assertNull(tracker.canRecoverOnNetwork())

        // 过了最小间隔后，网络恢复立即触发重拉
        now.addAndGet(ArtworkRetryPolicy.NETWORK_RECOVERY_MIN_GAP_MS)
        val recovered = tracker.canRecoverOnNetwork()
        assertNotNull(recovered)
        // 旧的延迟计划因已重新发起而被挡住
        assertNull(tracker.beginScheduledRetry(plan))

        assertTrue(tracker.onFetchSucceeded(recovered!!))
    }

    @Test
    fun `回前台无视最小节流立即补拉 已加载或永久失败则跳过`() {
        val now = AtomicLong(5_000L)
        val tracker = ArtworkFetchTracker { now.get() }

        val req = tracker.beginRequest(urlA1, songA)!!
        tracker.onFetchTransientFailure(req)
        // 哪怕只过 10ms，回前台也立刻重试
        now.addAndGet(10L)
        val fgReq = tracker.canRecoverOnForeground()
        assertNotNull(fgReq)
        // 在途期间不重复拉
        assertNull(tracker.canRecoverOnForeground())

        assertTrue(tracker.onFetchSucceeded(fgReq!!))
        assertNull(tracker.canRecoverOnForeground())

        // 切到永久失败的图：回前台与网络恢复都不应重拉
        tracker.onSongChanged(songB)
        val badUrl = "https://cdn.example.com/404.jpg"
        val badReq = tracker.beginRequest(badUrl, songB)!!
        assertTrue(tracker.onFetchPermanentFailure(badReq))
        assertTrue(tracker.isPermanentlyFailed(badUrl))
        assertNull(tracker.beginRequest(badUrl, songB))
        assertNull(tracker.canRecoverOnForeground())
        assertNull(tracker.canRecoverOnNetwork())
    }

    @Test
    fun `切歌即使同专辑同 URL 也重置代次与退避 并拦截上一首晚到结果`() {
        val now = AtomicLong(1_000L)
        val tracker = ArtworkFetchTracker { now.get() }
        val sharedAlbumUrl = "https://cdn.example.com/album.jpg"

        val song1Req = tracker.beginRequest(sharedAlbumUrl, songA)!!
        tracker.onFetchTransientFailure(song1Req) // attempt -> 1

        // 切歌到同一张专辑的下一首（URL 相同）
        tracker.onSongChanged(songB)
        assertEquals("", tracker.snapshotArtworkUrl())
        val song2Req = tracker.beginRequest(sharedAlbumUrl, songB)!!
        assertTrue(song2Req.generation > song1Req.generation)

        // 第一首晚到的失败或成功都不能污染第二首
        assertNull(tracker.onFetchTransientFailure(song1Req))
        assertFalse(tracker.onFetchSucceeded(song1Req))

        // 第二首首次失败应从 2s 重新开始退避
        val song2Plan = tracker.onFetchTransientFailure(song2Req)!!
        assertEquals(1, song2Plan.attemptNumber)
        assertEquals(2_000L, song2Plan.delayMs)
    }

    @Test
    fun `没有 songKey 时退回按地址认歌 不同地址仍然各自请求`() {
        val tracker = ArtworkFetchTracker()
        val first = tracker.beginRequest(urlA1, null)!!
        assertTrue(tracker.onFetchSucceeded(first))
        assertNull(tracker.beginRequest(urlA1, null))
        // 没有 songKey 就分不清「换了签名」和「换了一首」，按地址当成新的一首：宁可多拉一次
        assertNotEquals(0L, tracker.beginRequest(urlA2, null)!!.generation)
    }

    @Test
    fun `永久失败集合只保留最近 64 个地址`() {
        val tracker = ArtworkFetchTracker()
        for (i in 0..64) {
            tracker.onSongChanged("song-$i")
            val request = tracker.beginRequest("https://cdn.example.com/$i.jpg", "song-$i")!!
            assertTrue(tracker.onFetchPermanentFailure(request))
        }

        assertFalse(tracker.isPermanentlyFailed("https://cdn.example.com/0.jpg"))
        assertTrue(tracker.isPermanentlyFailed("https://cdn.example.com/1.jpg"))
        assertTrue(tracker.isPermanentlyFailed("https://cdn.example.com/64.jpg"))
    }

    @Test
    fun `外部已提供解码封面时不再把缺失补拉放行`() {
        val tracker = ArtworkFetchTracker()
        tracker.onSongChanged(songA)
        tracker.onExternalArtworkLoaded()
        assertNull(tracker.canRecoverOnForeground())
        assertNull(tracker.canRecoverOnNetwork())
    }
}
