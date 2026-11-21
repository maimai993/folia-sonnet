package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// 纯 JVM 合成测试：投送租约的签发、续期、收回与过期，不启动 Android 也不开 socket。
class LanCastLeaseRegistryTest {

    private fun registry(leaseMillis: Long = 60_000L) = LanCastLeaseRegistry(leaseMillis = leaseMillis)

    @Test
    fun issuesOpaqueTokenAndReadablePairCode() {
        val lease = registry().ensure(1_000L)
        assertTrue(lease.lanToken.startsWith(LanCastLeaseRegistry.LAN_TOKEN_PREFIX))
        // 令牌足够长，猜不出来；配对码只有人能读的 8 个字符。
        assertTrue(lease.lanToken.length >= 40)
        assertEquals(8, lease.pairCode.length)
        // 配对码里不该出现容易看混的字符。
        for (confusing in listOf('0', 'O', '1', 'I')) {
            assertFalse("配对码不该含 $confusing", lease.pairCode.contains(confusing))
        }
    }

    @Test
    fun admitsOnlyTheTokenIssuedByTheCurrentLease() {
        val registry = registry()
        val lease = registry.ensure(1_000L)
        assertTrue(registry.admitsLanToken(lease.lanToken, 2_000L))
        // 猜一个格式正确但不是本次签发的令牌。
        assertFalse(registry.admitsLanToken(LanCastLeaseRegistry.LAN_TOKEN_PREFIX + "abcdefgh", 2_000L))
        assertFalse(registry.admitsLanToken("", 2_000L))
    }

    @Test
    fun releaseRevokesImmediately() {
        val registry = registry()
        val lease = registry.ensure(1_000L)
        registry.release()
        assertNull(registry.current(2_000L))
        assertFalse(registry.admitsLanToken(lease.lanToken, 2_000L))
        // 收回之后再开是新的一份凭证，旧 URL 不会复活。
        val reopened = registry.ensure(3_000L)
        assertNotEquals(lease.lanToken, reopened.lanToken)
        assertFalse(registry.admitsLanToken(lease.lanToken, 4_000L))
        assertTrue(registry.admitsLanToken(reopened.lanToken, 4_000L))
    }

    @Test
    fun expiresOnItsOwn() {
        val registry = registry(leaseMillis = 10_000L)
        val lease = registry.ensure(1_000L)
        assertTrue(registry.admitsLanToken(lease.lanToken, 5_000L))
        // 到点即失效，不需要任何人来收回。
        assertNull(registry.current(11_000L))
        assertFalse(registry.admitsLanToken(lease.lanToken, 11_000L))
    }

    @Test
    fun repeatedPrepareRenewsWithoutRotatingTokens() {
        // 切歌 / 换音响会反复 prepare：每次都换 token 会让音响手上那份立刻失效。
        val registry = registry(leaseMillis = 10_000L)
        val first = registry.ensure(1_000L)
        val second = registry.ensure(8_000L)
        assertEquals(first.lanToken, second.lanToken)
        assertEquals(first.pairCode, second.pairCode)
        // 续期把截止时间往后推了。
        assertEquals(18_000L, second.expiresAtMillis)
        assertTrue(registry.admitsLanToken(first.lanToken, 15_000L))
    }

    @Test
    fun aDifferentRegistryNeverSharesCredentials() {
        // 相当于「进程重启」：新实例没有任何旧凭证。
        val before = registry()
        val old = before.ensure(1_000L)
        val after = registry()
        assertNull(after.current(2_000L))
        assertFalse(after.admitsLanToken(old.lanToken, 2_000L))
        assertNotEquals(old.lanToken, after.ensure(2_000L).lanToken)
    }

    @Test
    fun defaultLeaseOutlivesAFullAlbumButNotForever() {
        assertTrue(LanCastLeaseRegistry.DEFAULT_LEASE_MS >= 60L * 60 * 1000)
        assertTrue(LanCastLeaseRegistry.DEFAULT_LEASE_MS <= 6L * 60 * 60 * 1000)
    }
}
