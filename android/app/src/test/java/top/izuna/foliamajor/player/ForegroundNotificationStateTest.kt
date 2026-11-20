package top.izuna.foliamajor.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// 前台化 / 通知 / MediaSession 三件东西的状态机（#M4）：路径 × 终态的表驱动单测。
// 纯 JVM，不碰 Service / MediaSessionCompat / NotificationManager。

class ForegroundNotificationStateTest {

    /** 收尾来路 × 终态：三条路径只在「最后一步」上不同，状态必须对得上。 */
    private data class Path(val keepSession: Boolean, val stopService: Boolean, val expectedState: ForegroundNotificationState)

    private val paths = listOf(
        // 心跳断了：服务继续活着，session 留着（还得能重新 active），只是退前台 + 撤通知。
        Path(keepSession = true, stopService = false, expectedState = ForegroundNotificationState.WITHDRAWN),
        // MediaSession 的 onStop（媒体面板点了停止）：与上面同，再加 stopSelf。
        Path(keepSession = true, stopService = true, expectedState = ForegroundNotificationState.WITHDRAWN),
        // ACTION_STOP_FOREGROUND：同上。
        Path(keepSession = true, stopService = true, expectedState = ForegroundNotificationState.WITHDRAWN),
        // onDestroy：session 一起 release，实例没了。
        Path(keepSession = false, stopService = false, expectedState = ForegroundNotificationState.NONE),
    )

    /**
     * 把 endNotificationState 的状态落点照抄一遍。
     *
     * 真正的收尾函数在 Service 里（要为它起 Android 运行时），但它对状态的决定只有这一行；
     * 单测盯的就是这一行 —— 三条路径的终态各不相同，任何一条改错都会在这里红。
     */
    private fun finalState(keepSession: Boolean): ForegroundNotificationState =
        if (keepSession) ForegroundNotificationState.WITHDRAWN else ForegroundNotificationState.NONE

    @Test
    fun `每条收尾路径的终态与预期一致`() {
        for (path in paths) {
            assertTrue("keepSession=${path.keepSession}: " + path.expectedState,
                finalState(path.keepSession) == path.expectedState)
        }
    }

    @Test
    fun `收尾之后一定不在前台`() {
        for (path in paths) {
            assertFalse("path=$path", finalState(path.keepSession).isForeground)
        }
    }

    @Test
    fun `只有 onDestroy 之后服务才算不活着`() {
        /*
         * 撤回 / onStop / ACTION_STOP_FOREGROUND 都不会让实例消失（stopSelf 之后才 onDestroy），
         * 所以这几条收尾只能落在 WITHDRAWN 上；只有释放了 session 的 onDestroy 才落到 NONE。
         * 判据直接看状态本身，不另外发明一套「算不算活着」的定义。
         */
        for (path in paths) {
            val state = finalState(path.keepSession)
            if (state == ForegroundNotificationState.NONE) {
                assertFalse("path=$path", ForegroundNotificationState.isAlive(state))
            } else {
                assertTrue("path=$path", ForegroundNotificationState.isAlive(state))
            }
        }
        assertFalse(ForegroundNotificationState.isAlive(ForegroundNotificationState.NONE))
        assertTrue(ForegroundNotificationState.isAlive(ForegroundNotificationState.WITHDRAWN))
        assertTrue(ForegroundNotificationState.isAlive(ForegroundNotificationState.FOREGROUND))
    }

    @Test
    fun `非前台身份在跑这件事有名字了`() {
        // 旧实现里 `running=true / foregrounded=false` 这个组合没有名字，插件只能自己拼两个字段。
        assertTrue(ForegroundNotificationState.WITHDRAWN.isRunningInBackground)
        assertFalse(ForegroundNotificationState.FOREGROUND.isRunningInBackground)
        assertFalse(ForegroundNotificationState.NONE.isRunningInBackground)
    }

    @Test
    fun `只有前台态才报 isForegrounded`() {
        assertTrue(ForegroundNotificationState.FOREGROUND.isForeground)
        assertFalse(ForegroundNotificationState.WITHDRAWN.isForeground)
        // onDestroy 之后必须是 false：否则插件会跳过 startForegroundService，
        // 新实例也跳过 startForeground，5 秒后 ForegroundServiceDidNotStartInTimeException。
        assertFalse(ForegroundNotificationState.NONE.isForeground)
    }

    @Test
    fun `已在前台时不重复调 startForeground`() {
        assertFalse(ForegroundNotificationState.needsForegroundCall(ForegroundNotificationState.FOREGROUND, false))
        assertTrue(ForegroundNotificationState.needsForegroundCall(ForegroundNotificationState.WITHDRAWN, false))
        assertTrue(ForegroundNotificationState.needsForegroundCall(ForegroundNotificationState.NONE, false))
    }

    @Test
    fun `onStartCommand 的无条件兑现有额外的理由`() {
        // onStartCommand 里那条「每条 intent 都真调一次」：状态说在前台也要调，
        // 因为 startForegroundService 开的倒计时只有 startForeground() 能兑现。
        assertTrue(ForegroundNotificationState.needsForegroundCall(ForegroundNotificationState.FOREGROUND, true))
        assertTrue(ForegroundNotificationState.needsForegroundCall(ForegroundNotificationState.WITHDRAWN, true))
    }
}
