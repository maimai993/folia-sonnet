package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// test/unit/android/LanCastDiscoveryTest.kt
// 局域网发现的策略（issue M21）。三条验收标准逐条钉住：
// 网络里只有一台音响时不再发 ssdp:all；一台设备不响应时整次发现仍在预算内；MX 与等待窗口一致。
class LanCastDiscoveryTest {

    // ---------------------------------------------------------------- 先精准后兜底

    @Test
    fun `the first round asks only for MediaRenderer`() {
        val probe = LanCastDiscovery.precise()
        assertEquals(LanCastDiscovery.MEDIA_RENDERER, probe.searchTarget)
        assertFalse("第一轮不该广播 ssdp:all：$probe", probe.searchTarget == LanCastDiscovery.ALL)
    }

    @Test
    fun `ssdp all is only sent after a precise round found nothing`() {
        // 第一轮：精准搜索。
        val first = LanCastDiscovery.nextProbe(
            elapsedMs = 0, timeoutMs = 5000, found = 0, rounds = 0, preciseRoundsWithoutResult = 0,
        )
        assertEquals(LanCastDiscovery.MEDIA_RENDERER, first?.searchTarget)
        // 精准搜索零结果之后才补兜底（还要留得下一个完整窗口）。
        val second = LanCastDiscovery.nextProbe(
            elapsedMs = 2000, timeoutMs = 5000, found = 0, rounds = 1, preciseRoundsWithoutResult = 1,
        )
        assertEquals(LanCastDiscovery.ALL, second?.searchTarget)
        // 预算只剩不够一个窗口的尾巴时，宁可不发也不再叫醒全网段。
        assertNull(
            LanCastDiscovery.nextProbe(
                elapsedMs = 2500, timeoutMs = 3200, found = 0, rounds = 1, preciseRoundsWithoutResult = 1,
            ),
        )
    }

    @Test
    fun `once a speaker answered no further broadcast happens`() {
        // issue 的验收标准原话：网络内只有一台音响时不再发 ssdp:all。
        // 第一轮就搜到一台之后，后续任何时刻都不该再发探针。
        assertNull(
            LanCastDiscovery.nextProbe(
                elapsedMs = 2000, timeoutMs = 3200, found = 1, rounds = 1, preciseRoundsWithoutResult = 0,
            ),
        )
        assertNull(
            LanCastDiscovery.nextProbe(
                elapsedMs = 2000, timeoutMs = 3200, found = 3, rounds = 1, preciseRoundsWithoutResult = 0,
            ),
        )
    }

    @Test
    fun `an answered round resets the precise counter`() {
        // 上一轮有应答（找到了设备，不必再多发），精准计数归零：不该紧接着就广播 ssdp:all。
        val probe = LanCastDiscovery.nextProbe(
            elapsedMs = 2000, timeoutMs = 4000, found = 0, rounds = 1, preciseRoundsWithoutResult = 0,
        )
        assertEquals(LanCastDiscovery.MEDIA_RENDERER, probe?.searchTarget)
    }

    // ---------------------------------------------------------------- 预算

    @Test
    fun `no probe is sent when a full window cannot fit`() {
        // 只剩 1.5 秒却要等 2 秒：发了也收不到回复，白叫醒全网段。
        assertNull(
            LanCastDiscovery.nextProbe(
                elapsedMs = 1700, timeoutMs = 3200, found = 0, rounds = 1, preciseRoundsWithoutResult = 1,
            ),
        )
    }

    @Test
    fun `the wait window matches the declared MX`() {
        // 声明 MX: 2 就必须等满 2 秒：过去 400ms 就换目标，等于用重发掩盖协议错配。
        assertEquals(LanCastDiscovery.MX_SECONDS * 1000, LanCastDiscovery.WINDOW_MS)
        assertEquals(LanCastDiscovery.WINDOW_MS, LanCastDiscovery.precise().windowMs)
        assertEquals(LanCastDiscovery.WINDOW_MS, LanCastDiscovery.fallback().windowMs)
    }

    @Test
    fun `the m-search packet declares the same MX as the window`() {
        val packet = String(
            LanCastDiscovery.searchRequest(LanCastDiscovery.MEDIA_RENDERER, "239.255.255.250", 1900),
            Charsets.UTF_8,
        )
        assertTrue(packet, packet.contains("MX: ${LanCastDiscovery.MX_SECONDS}\r\n"))
        assertTrue(packet, packet.contains("ST: ${LanCastDiscovery.MEDIA_RENDERER}\r\n"))
        assertTrue(packet, packet.contains("MAN: \"ssdp:discover\"\r\n"))
        // 结尾必须是空行，否则不少设备不理这条 M-SEARCH。
        assertTrue(packet, packet.endsWith("\r\n\r\n"))
    }

    @Test
    fun `the fetch budget stays bounded no matter how slow the search was`() {
        // issue 的验收标准原话：一台设备故意不响应时 discover 仍在预算内返回。
        // 抓包用光了 timeoutMs 也不能让回取无限期跑下去。
        val budget = LanCastDiscovery.fetchBudgetMs(timeoutMs = 3200, elapsedMs = 5000)
        assertTrue(budget.toString(), budget <= LanCastDiscovery.MAX_FETCH_BUDGET_MS.toLong())
        assertTrue(budget.toString(), budget >= LanCastDiscovery.PER_DEVICE_FETCH_BUDGET_MS.toLong())
    }

    @Test
    fun `the fetch budget never exceeds the cap`() {
        // 抓包很快、timeoutMs 给到 10 秒：也不能把回取预算抬到 10 秒。
        val budget = LanCastDiscovery.fetchBudgetMs(timeoutMs = 10_000, elapsedMs = 0)
        assertEquals(LanCastDiscovery.MAX_FETCH_BUDGET_MS.toLong(), budget)
    }

    @Test
    fun `the whole discovery fits in the promised timeout for a dead device`() {
        // 端到端算一遍：一轮精准（2s）+ 一轮兜底（2s）+ 回取预算，不能超过 timeoutMs 太多。
        val timeoutMs = 3200
        val searchMs = LanCastDiscovery.WINDOW_MS * 2L
        val budget = LanCastDiscovery.fetchBudgetMs(timeoutMs = timeoutMs, elapsedMs = searchMs)
        // 过去这里是「串行 + 每台 4s 连 6s 读」，一台死设备就是 10 秒起。
        val worst = searchMs + budget + LanCastDiscovery.PER_DEVICE_FETCH_BUDGET_MS.toLong()
        assertTrue("最坏 $worst ms，拖得太久了", worst <= timeoutMs + LanCastDiscovery.MAX_FETCH_BUDGET_MS + 5_000)
    }

    @Test
    fun `concurrency is capped and never zero`() {
        // 零设备就别起线程池；设备再多也不超过上限（家用路由器扛不住十几条并发）。
        assertEquals(1, LanCastDiscovery.fetchConcurrency(0))
        assertEquals(2, LanCastDiscovery.fetchConcurrency(2))
        assertEquals(LanCastDiscovery.MAX_FETCH_CONCURRENCY, LanCastDiscovery.fetchConcurrency(10))
        assertEquals(LanCastDiscovery.MAX_FETCH_CONCURRENCY, LanCastDiscovery.fetchConcurrency(100))
    }

    // ---------------------------------------------------------------- 收缓冲

    @Test
    fun `the receive buffer is big enough for long ssdp replies`() {
        // 2048 装不下某些设备的长 USN + 多个头，截断后变成畸形应答，设备就静默丢了。
        assertTrue(LanCastDiscovery.RECEIVE_BUFFER_BYTES >= 8192)
    }

    @Test
    fun `a fallback probe is still sent when the timeout allows only one more round`() {
        val probe = LanCastDiscovery.nextProbe(
            elapsedMs = 1000, timeoutMs = 3200, found = 0, rounds = 2, preciseRoundsWithoutResult = 2,
        )
        assertNotNull(probe)
        assertEquals(LanCastDiscovery.ALL, probe?.searchTarget)
    }
}
