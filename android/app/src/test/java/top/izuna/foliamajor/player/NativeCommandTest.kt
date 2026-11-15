package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// android/app/src/test/java/top/izuna/foliamajor/player/NativeCommandTest.kt
// 原生传输命令的过期判定、exactly-once 结算与调度（#337 #338 #339）。

class NativeCommandTest {

    /** 假的「播放器线程」：post 只入队，runAll 由测试在「播放器线程」上按序执行。 */
    private class FakeThread {
        val queue = ArrayDeque<Runnable>()
        var accepting = true
        var onThread = false
        val post: (Runnable) -> Boolean = { task ->
            if (accepting) { queue.addLast(task); true } else false
        }
        fun runAll() {
            onThread = true
            try {
                while (queue.isNotEmpty()) queue.removeFirst().run()
            } finally {
                onThread = false
            }
        }
    }

    private fun scheduler(thread: FakeThread, onError: (Throwable) -> Unit = {}) =
        NativeCommandScheduler(thread.post, { thread.onThread }, onError)

    private fun collect(results: MutableList<NativeCommandResult>): NativeCommandCompletion = { results.add(it) }

    // ---------- 过期判定 ----------

    @Test
    fun `同 source 的 play 与 seek 都照常执行`() {
        assertNull(NativeCommandPolicy.staleReason(NativeCommandKind.PLAY, 3, 5, 3, 5))
        assertNull(NativeCommandPolicy.staleReason(NativeCommandKind.SEEK, 3, 5, 3, 5))
    }

    @Test
    fun `提交之后又换了源 prepare play seek stop 都过期`() {
        for (kind in listOf(NativeCommandKind.PREPARE, NativeCommandKind.PLAY, NativeCommandKind.SEEK, NativeCommandKind.STOP)) {
            assertEquals(
                NativeCommandPolicy.REASON_SOURCE,
                NativeCommandPolicy.staleReason(kind, 3, 5, 4, 5),
            )
        }
    }

    @Test
    fun `暂停不受换源约束 原生同一瞬间换歌时用户的暂停仍然落地`() {
        assertNull(NativeCommandPolicy.staleReason(NativeCommandKind.PAUSE, 3, 5, 4, 5))
    }

    @Test
    fun `更新的播放意图让旧 play 与 pause 过期 但 seek 不受影响`() {
        assertEquals(NativeCommandPolicy.REASON_INTENT, NativeCommandPolicy.staleReason(NativeCommandKind.PLAY, 3, 5, 3, 6))
        assertEquals(NativeCommandPolicy.REASON_INTENT, NativeCommandPolicy.staleReason(NativeCommandKind.PAUSE, 3, 5, 3, 6))
        assertNull(NativeCommandPolicy.staleReason(NativeCommandKind.SEEK, 3, 5, 3, 6))
    }

    // ---------- 结算 ----------

    @Test
    fun `completion 只结算一次 后到的结算被忽略`() {
        val results = mutableListOf<NativeCommandResult>()
        val command = PendingCommand(NativeCommandKind.PLAY, collect(results))
        assertTrue(command.settle(NativeCommandResult.Ok(1)))
        assertFalse(command.settle(NativeCommandResult.Failed("PLAYER_RELEASED", "x")))
        assertEquals(listOf<NativeCommandResult>(NativeCommandResult.Ok(1)), results)
    }

    @Test
    fun `completion 抛异常不外溢 且仍算已结算`() {
        val command = PendingCommand(NativeCommandKind.PREPARE, { throw IllegalStateException("bridge gone") })
        assertTrue(command.settle(NativeCommandResult.Ok(1)))
        assertTrue(command.isSettled)
    }

    @Test
    fun `completion 抛异常时交给错误回调记录 不会无痕吞掉`() {
        val logged = mutableListOf<Throwable>()
        val command = PendingCommand(NativeCommandKind.PLAY, { throw IllegalStateException("bridge gone") }, { logged.add(it) })
        assertTrue(command.settle(NativeCommandResult.Ok(1)))
        assertEquals(1, logged.size)
        assertEquals("bridge gone", logged[0].message)
    }

    @Test
    fun `错误回调自己抛异常也不外溢`() {
        val command = PendingCommand(NativeCommandKind.PLAY, { throw IllegalStateException("a") }, { throw IllegalStateException("b") })
        assertTrue(command.settle(NativeCommandResult.Ok(1)))
        assertTrue(command.isSettled)
    }

    @Test
    fun `调度器把 completion 的异常转给 onCompletionError`() {
        val thread = FakeThread()
        val logged = mutableListOf<Throwable>()
        val s = NativeCommandScheduler(thread.post, { thread.onThread }, onCompletionError = { logged.add(it) })
        s.dispatch(NativeCommandKind.PLAY, { throw IllegalStateException("resolve failed") }, bumpSource = false, bumpTransport = true) {}
        thread.runAll()
        assertEquals(1, logged.size)
        assertEquals(0, s.pendingCount)
    }

    @Test
    fun `settleAll 让所有排队命令收尾 且不会重复结算`() {
        val pending = PendingCommands()
        val results = mutableListOf<String>()
        val a = PendingCommand(NativeCommandKind.PREPARE, { results.add("a:$it") })
        val b = PendingCommand(NativeCommandKind.PLAY, { results.add("b:$it") })
        pending.add(a)
        pending.add(b)
        b.settle(NativeCommandResult.Ok(2))
        pending.remove(b)
        pending.settleAll(NativeCommandResult.Failed("PLAYER_RELEASED", "released"))
        assertEquals(0, pending.size)
        assertEquals(2, results.size)
        pending.settleAll(NativeCommandResult.Failed("PLAYER_RELEASED", "released"))
        assertEquals(2, results.size)
    }

    // ---------- 调度器 ----------

    @Test
    fun `动作真正执行完才结算 post 之后尚未结算`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        val results = mutableListOf<NativeCommandResult>()
        var ran = false
        s.dispatch(NativeCommandKind.PREPARE, collect(results), bumpSource = true, bumpTransport = true) { ran = true }
        assertTrue(results.isEmpty())
        assertFalse(ran)
        thread.runAll()
        assertTrue(ran)
        assertEquals(1, results.size)
        assertTrue(results[0] is NativeCommandResult.Ok)
        assertEquals(0, s.pendingCount)
    }

    @Test
    fun `A 到 B 再到 A 连发 中间那条是 Stale 且根本没执行`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        val results = mutableListOf<NativeCommandResult>()
        val executed = mutableListOf<String>()
        for (name in listOf("A", "B", "A2")) {
            s.dispatch(NativeCommandKind.PREPARE, collect(results), bumpSource = true, bumpTransport = true) { executed.add(name) }
        }
        thread.runAll()
        assertEquals(listOf("A2"), executed)
        assertTrue(results[0] is NativeCommandResult.Stale)
        assertTrue(results[1] is NativeCommandResult.Stale)
        assertTrue(results[2] is NativeCommandResult.Ok)
    }

    @Test
    fun `play 紧跟 pause 只有 pause 落地 play 是 Stale`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        val results = mutableListOf<NativeCommandResult>()
        val executed = mutableListOf<String>()
        s.dispatch(NativeCommandKind.PLAY, collect(results), bumpSource = false, bumpTransport = true) { executed.add("play") }
        s.dispatch(NativeCommandKind.PAUSE, collect(results), bumpSource = false, bumpTransport = true) { executed.add("pause") }
        thread.runAll()
        assertEquals(listOf("pause"), executed)
        assertEquals(NativeCommandPolicy.REASON_INTENT, (results[0] as NativeCommandResult.Stale).reason)
    }

    @Test
    fun `排队的 pause 遇到原生换源仍然执行`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        val results = mutableListOf<NativeCommandResult>()
        val executed = mutableListOf<String>()
        s.dispatch(NativeCommandKind.PAUSE, collect(results), bumpSource = false, bumpTransport = true) { executed.add("pause") }
        s.bumpBoundary()  // 原生自己换歌（crossfade / 兜底）
        thread.runAll()
        assertEquals(listOf("pause"), executed)
        assertTrue(results[0] is NativeCommandResult.Ok)
    }

    @Test
    fun `接管边界让此前排队的 play 与 seek 过期 之后提交的才是新纪元`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        val results = mutableListOf<NativeCommandResult>()
        val executed = mutableListOf<String>()
        s.dispatch(NativeCommandKind.PLAY, collect(results), bumpSource = false, bumpTransport = true) { executed.add("oldPlay") }
        s.dispatch(NativeCommandKind.SEEK, collect(results), bumpSource = false, bumpTransport = false) { executed.add("oldSeek") }
        s.bumpBoundary()
        s.dispatch(NativeCommandKind.PLAY, collect(results), bumpSource = false, bumpTransport = true) { executed.add("newPlay") }
        thread.runAll()
        assertEquals(listOf("newPlay"), executed)
        assertTrue(results[0] is NativeCommandResult.Stale)
        assertTrue(results[1] is NativeCommandResult.Stale)
        assertTrue(results[2] is NativeCommandResult.Ok)
    }

    @Test
    fun `换源边界不动播放意图纪元`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        val before = s.transportEpoch
        s.bumpBoundary()
        assertEquals(before, s.transportEpoch)
        assertEquals(1L, s.sourceEpoch)
    }

    @Test
    fun `连发两次 seek 按先后都执行 最终位置是最后一次`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        var position = 0L
        for (target in listOf(10L, 20L)) {
            s.dispatch(NativeCommandKind.SEEK, null, bumpSource = false, bumpTransport = false) { position = target }
        }
        thread.runAll()
        assertEquals(20L, position)
    }

    @Test
    fun `动作抛异常 以 Failed 结算 通知错误回调 且错误回调自己抛也不悬挂`() {
        val thread = FakeThread()
        val errors = mutableListOf<Throwable>()
        val s = scheduler(thread) { errors.add(it); throw IllegalStateException("listener broke") }
        val results = mutableListOf<NativeCommandResult>()
        s.dispatch(NativeCommandKind.PLAY, collect(results), bumpSource = false, bumpTransport = true) {
            throw IllegalArgumentException("boom")
        }
        thread.runAll()
        assertEquals(1, errors.size)
        val failed = results.single() as NativeCommandResult.Failed
        assertEquals("ACTION_FAILED", failed.code)
        assertEquals(0, s.pendingCount)
    }

    @Test
    fun `post 失败 立即 Failed 且不留在待办里`() {
        val thread = FakeThread().apply { accepting = false }
        val s = scheduler(thread)
        val results = mutableListOf<NativeCommandResult>()
        s.dispatch(NativeCommandKind.PREPARE, collect(results), bumpSource = true, bumpTransport = true) { fail("must not run") }
        assertEquals("POST_FAILED", (results.single() as NativeCommandResult.Failed).code)
        assertEquals(0, s.pendingCount)
    }

    @Test
    fun `post 抛异常也当作失败处理`() {
        val s = NativeCommandScheduler({ throw IllegalStateException("dead thread") }, { false })
        val results = mutableListOf<NativeCommandResult>()
        s.dispatch(NativeCommandKind.PLAY, collect(results), bumpSource = false, bumpTransport = true) { fail("must not run") }
        assertEquals("POST_FAILED", (results.single() as NativeCommandResult.Failed).code)
    }

    @Test
    fun `release 让排队中的命令全部 Failed 随后到的 runnable 不再执行也不重复结算`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        val results = mutableListOf<NativeCommandResult>()
        var ran = 0
        s.dispatch(NativeCommandKind.PREPARE, collect(results), bumpSource = true, bumpTransport = true) { ran++ }
        s.dispatch(NativeCommandKind.PLAY, collect(results), bumpSource = false, bumpTransport = true) { ran++ }
        assertTrue(s.release())
        assertEquals(2, results.size)
        assertTrue(results.all { it is NativeCommandResult.Failed && it.code == "PLAYER_RELEASED" })
        thread.runAll()
        assertEquals(0, ran)
        assertEquals(2, results.size)
        assertFalse(s.release())
    }

    @Test
    fun `release 之后再提交 直接 Failed`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        s.release()
        val results = mutableListOf<NativeCommandResult>()
        s.dispatch(NativeCommandKind.SEEK, collect(results), bumpSource = false, bumpTransport = false) { fail("must not run") }
        assertEquals("PLAYER_RELEASED", (results.single() as NativeCommandResult.Failed).code)
        assertEquals(0, thread.queue.size)
    }

    @Test
    fun `已经在播放器线程上 直接执行 不排到下一轮`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        thread.onThread = true
        val results = mutableListOf<NativeCommandResult>()
        var ran = false
        s.dispatch(NativeCommandKind.PREPARE, collect(results), bumpSource = true, bumpTransport = true) { ran = true }
        assertTrue(ran)
        assertEquals(0, thread.queue.size)
        assertTrue(results.single() is NativeCommandResult.Ok)
    }

    @Test
    fun `callerSide 在调用线程拿到本条的 source 纪元`() {
        val thread = FakeThread()
        val s = scheduler(thread)
        val epochs = mutableListOf<Long>()
        repeat(3) {
            s.dispatch(NativeCommandKind.PREPARE, null, bumpSource = true, bumpTransport = true, callerSide = { epochs.add(it) }) {}
        }
        assertEquals(listOf(1L, 2L, 3L), epochs)
    }

    @Test
    fun `多线程并发提交与 release 每条命令恰好结算一次 没有悬挂`() {
        repeat(50) {
            val executor = Executors.newSingleThreadExecutor()
            val s = NativeCommandScheduler(
                post = { task -> try { executor.execute(task); true } catch (_: Throwable) { false } },
                onPlayerThread = { false },
            )
            val total = 400
            val counts = Array(total) { java.util.concurrent.atomic.AtomicInteger(0) }
            val done = CountDownLatch(total)
            val producers = Executors.newFixedThreadPool(4)
            for (i in 0 until total) {
                producers.execute {
                    val kind = if (i % 2 == 0) NativeCommandKind.PLAY else NativeCommandKind.PREPARE
                    s.dispatch(kind, { counts[i].incrementAndGet(); done.countDown() }, bumpSource = i % 2 == 1, bumpTransport = true) {}
                    if (i == total / 2) s.release()
                }
            }
            assertTrue("有命令没有结算（Promise 悬挂）", done.await(10, TimeUnit.SECONDS))
            assertTrue(counts.all { it.get() == 1 })
            assertEquals(0, s.pendingCount)
            producers.shutdownNow()
            executor.shutdownNow()
        }
    }
}
