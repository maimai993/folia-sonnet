package top.izuna.foliamajor.player

import org.junit.Assert.assertEquals
import org.junit.Test

// 后台静默跳过不回 JS 重播；前台不抢 JS 的失败处理，设置相互独立（#172）。
class NativeFailurePolicyTest {
    @Test
    fun `前台按自动跳过设置且只回执`() {
        assertEquals(NativeFailurePolicy(true, false), nativeFailurePolicy(true, false, true))
        assertEquals(NativeFailurePolicy(true, true), nativeFailurePolicy(true, true, false))
    }

    @Test
    fun `后台只看静默跳过开关不回执重播`() {
        assertEquals(NativeFailurePolicy(false, true), nativeFailurePolicy(false, false, true))
        assertEquals(NativeFailurePolicy(false, false), nativeFailurePolicy(false, true, false))
    }

    @Test
    fun `空mediaId的ended视为无身份而不是不匹配`() {
        assertEquals(null, endedIdentity(""))
        assertEquals(null, endedIdentity(null))
        assertEquals("kugou:1", endedIdentity("kugou:1"))
    }
}
