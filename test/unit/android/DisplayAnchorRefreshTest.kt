package top.izuna.foliamajor.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// 回归 #264：后台播放器每秒采样，但叠层三秒核对不能把陈旧采样当成当前播放位置。
class DisplayAnchorRefreshTest {
    @Test
    fun `陈旧缓存会触发回抽而播放器线程的实时位置不会`() {
        val lastSample = 10_000L
        val actualNow = 10_800L
        assertTrue(displayAnchorNeedsWrite(true, actualNow, true, lastSample))
        assertFalse(displayAnchorNeedsWrite(true, actualNow, true, actualNow))
    }
}
