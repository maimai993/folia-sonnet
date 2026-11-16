package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong

// android/app/src/test/java/top/izuna/foliamajor/ArtworkRetryPolicyTest.kt
// 通知封面持续退避重试、网络恢复触发与切歌代次隔离单元测试（#348）。

class ArtworkRetryPolicyTest {

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
        val url = "https://cdn.example.com/1.jpg"

        var req = tracker.beginRequest(url)
        assertNotNull(req)
        // 同 URL 在途去重
        assertNull(tracker.beginRequest(url))

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
        assertEquals(url, tracker.snapshotArtworkUrl())
        // 已有封面时回前台与网络恢复不再重复拉取
        assertNull(tracker.canRecoverOnForeground())
        assertNull(tracker.canRecoverOnNetwork())
    }

    @Test
    fun `网络恢复回调按节流间隔立即清零退避并重拉`() {
        val now = AtomicLong(5_000L)
        val tracker = ArtworkFetchTracker { now.get() }
        val url = "https://cdn.example.com/2.jpg"

        val req1 = tracker.beginRequest(url)!!
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
        val url = "https://cdn.example.com/3.jpg"

        val req = tracker.beginRequest(url)!!
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
        tracker.onSongChanged()
        val badUrl = "https://cdn.example.com/404.jpg"
        val badReq = tracker.beginRequest(badUrl)!!
        assertTrue(tracker.onFetchPermanentFailure(badReq))
        assertTrue(tracker.isPermanentlyFailed(badUrl))
        assertNull(tracker.beginRequest(badUrl))
        assertNull(tracker.canRecoverOnForeground())
        assertNull(tracker.canRecoverOnNetwork())
    }

    @Test
    fun `切歌即使同专辑同 URL 也重置代次与退避 并拦截上一首晚到结果`() {
        val now = AtomicLong(1_000L)
        val tracker = ArtworkFetchTracker { now.get() }
        val sharedAlbumUrl = "https://cdn.example.com/album.jpg"

        val song1Req = tracker.beginRequest(sharedAlbumUrl)!!
        tracker.onFetchTransientFailure(song1Req) // attempt -> 1

        // 切歌到同一张专辑的下一首（URL 相同）
        tracker.onSongChanged()
        assertEquals("", tracker.snapshotArtworkUrl())
        val song2Req = tracker.beginRequest(sharedAlbumUrl)!!
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
    fun `外部已提供解码封面时不再把缺失补拉放行`() {
        val tracker = ArtworkFetchTracker()
        tracker.onSongChanged()
        tracker.onExternalArtworkLoaded()
        assertNull(tracker.canRecoverOnForeground())
        assertNull(tracker.canRecoverOnNetwork())
    }
}
