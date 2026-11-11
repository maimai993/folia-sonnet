package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Test

// 可控队列回归：采样跨越任意已受理控制动作就失效，控制动作本身仍按播放器队列全部执行。
class DisplayAnchorGenerationTest {
    private class ControlledPlayer {
        val guard = DisplayAnchorGeneration()
        val queue = mutableListOf<() -> Unit>()
        val actions = mutableListOf<String>()
        var position = 10000L
        var displayed = -1L

        fun accept(action: () -> Unit): () -> Unit {
            guard.begin()
            return {
                try {
                    action()
                } finally {
                    guard.finish()
                }
            }
        }

        fun sample() {
            val epoch = guard.capture()
            queue.add { guard.ifCurrent(epoch) { displayed = position } }
        }

        fun runNext() = queue.removeAt(0).invoke()
    }

    @Test
    fun `刷新执行时读取实时位置而不是请求时缓存`() {
        val player = ControlledPlayer()
        player.sample()
        player.position = 10800L
        player.runNext()
        assertEquals(10800L, player.displayed)
    }

    @Test
    fun `排队prepare和seek都执行且全部完成后新采样才能发布`() {
        val player = ControlledPlayer()
        player.sample()
        player.queue.add(player.accept {
            player.actions.add("prepare")
            player.position = 0L
        })
        player.queue.add(player.accept {
            player.actions.add("seek")
            player.position = 42000L
        })
        player.sample()
        player.runNext() // prepare/seek 受理前的采样失效。
        player.runNext()
        assertEquals(listOf("prepare"), player.actions)
        player.guard.ifCurrent(player.guard.capture()) { player.displayed = player.position }
        assertEquals(-1L, player.displayed) // 还有 seek 未执行。
        player.runNext()
        player.runNext() // pending 期间捕获的采样不能在 finish 后复活。
        assertEquals(listOf("prepare", "seek"), player.actions)
        assertEquals(-1L, player.displayed)
        player.sample()
        player.runNext()
        assertEquals(42000L, player.displayed)
    }

    @Test
    fun `受理与enqueue反序时按实际队列全部执行且不能提前开放采样`() {
        val player = ControlledPlayer()
        val prepare = player.accept {
            player.actions.add("prepare")
            player.position = 0L
        }
        val seek = player.accept {
            player.actions.add("seek")
            player.position = 7000L
        }
        player.queue.add(seek)
        player.queue.add(prepare)
        player.runNext()
        player.sample()
        player.guard.ifCurrent(player.guard.capture()) { player.displayed = player.position }
        assertEquals(-1L, player.displayed)
        player.runNext()
        player.runNext()
        assertEquals(listOf("seek", "prepare"), player.actions)
        assertEquals(-1L, player.displayed)
        player.sample()
        player.runNext()
        assertEquals(0L, player.displayed)
    }

    @Test
    fun `no-op和异常控制动作都finally结束并淘汰执行期间采样`() {
        val player = ControlledPlayer()
        player.queue.add(player.accept noOp@{
            player.sample()
            return@noOp
        })
        player.runNext()
        player.runNext()
        assertEquals(-1L, player.displayed)
        player.queue.add(player.accept {
            player.sample()
            throw IllegalStateException("control failed")
        })
        try {
            player.runNext()
        } catch (_: IllegalStateException) {
            player.actions.add("caught")
        }
        assertEquals(listOf("caught"), player.actions)
        player.runNext()
        assertEquals(-1L, player.displayed)
        player.sample()
        player.runNext()
        assertEquals(10000L, player.displayed)
    }

    @Test
    fun `close之后队列的finish以及新控制动作都不能重新开放采样`() {
        val player = ControlledPlayer()
        player.queue.add(player.accept { player.position = 10L })
        player.queue.add(player.accept { player.position = 20L })
        player.guard.close()
        player.runNext()
        player.runNext()
        player.sample()
        player.runNext()
        assertEquals(-1L, player.displayed)
        player.queue.add(player.accept { player.position = 30L })
        player.runNext()
        player.sample()
        player.runNext()
        assertEquals(-1L, player.displayed)
    }

    @Test
    fun `close永久封闭即使尚有未执行控制动作`() {
        val player = ControlledPlayer()
        player.accept { player.position = 1L } // 模拟 release 后不再执行的队列。
        player.guard.close()
        player.guard.close()
        player.sample()
        player.runNext()
        assertEquals(-1L, player.displayed)
    }
}
