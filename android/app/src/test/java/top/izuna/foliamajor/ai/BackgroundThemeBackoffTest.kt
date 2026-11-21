package top.izuna.foliamajor.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/ai/BackgroundThemeBackoffTest.kt
// 后台主题失败退避的纯规则单测（issue H33）。
//
// 钉住的是三件事，任何一件破了都会重新变成「反复重烧额度」：
//  1. 失败之后冷却窗口内不再自动重试；
//  2. 连续失败时窗口指数增长，且封顶（不会无限长到「这首永远没主题」）；
//  3. 「配置错误」类（401/403/未配置）冷却更长 —— 那类重试一万次也不会好；
//  4. 连续失败到上限后停止自动重试，但用户主动重试那条路不受影响（在 worker 里）。

class BackgroundThemeBackoffTest {

    private val kind = BackgroundThemeBackoff.Kind.TRANSIENT
    private val config = BackgroundThemeBackoff.Kind.CONFIG

    @Test
    fun `没有失败记录时不跳过`() {
        assertFalse(BackgroundThemeBackoff.shouldSkip(null, 1_000L))
    }

    @Test
    fun `第一次失败就在窗口内跳过`() {
        val failure = BackgroundThemeBackoff.recordFailure(null, kind, nowMs = 10_000L)
        assertEquals(1, failure.streak)
        assertEquals(kind.name, failure.kind)
        /* 窗口还没走完。 */
        assertTrue(BackgroundThemeBackoff.shouldSkip(failure, 10_000L + 1L))
        assertTrue(BackgroundThemeBackoff.shouldSkip(failure, 10_000L + BackgroundThemeBackoff.BASE_COOLDOWN_MS - 1))
        /* 窗口一过就该放行。 */
        assertFalse(BackgroundThemeBackoff.shouldSkip(failure, 10_000L + BackgroundThemeBackoff.BASE_COOLDOWN_MS))
    }

    @Test
    fun `连续失败时窗口指数增长并封顶`() {
        val first = BackgroundThemeBackoff.cooldownMs(kind, 1)
        val second = BackgroundThemeBackoff.cooldownMs(kind, 2)
        val third = BackgroundThemeBackoff.cooldownMs(kind, 3)
        assertEquals(BackgroundThemeBackoff.BASE_COOLDOWN_MS, first)
        assertEquals(first * 2, second)
        assertEquals(second * 2, third)
        /* 再多次也不会超过上限：封顶保证用户最终还能拿到主题。 */
        assertTrue(BackgroundThemeBackoff.cooldownMs(kind, 100) <= BackgroundThemeBackoff.MAX_COOLDOWN_MS)
        assertEquals(BackgroundThemeBackoff.MAX_COOLDOWN_MS, BackgroundThemeBackoff.cooldownMs(kind, 100))
    }

    @Test
    fun `配置错误的冷却比普通失败长`() {
        /* 同样是第一次失败，401 该等更久 —— 它基本等于「令牌过期了」，重试没有意义。 */
        assertTrue(
            BackgroundThemeBackoff.cooldownMs(config, 1) > BackgroundThemeBackoff.cooldownMs(kind, 1),
        )
        assertTrue(
            BackgroundThemeBackoff.cooldownMs(config, 100) >= BackgroundThemeBackoff.cooldownMs(kind, 100),
        )
        assertTrue(BackgroundThemeBackoff.Kind.CONFIG.isConfig)
        assertFalse(BackgroundThemeBackoff.Kind.TRANSIENT.isConfig)
    }

    @Test
    fun `连续失败到上限之后一直跳过`() {
        var failure: BackgroundThemeFailure? = null
        var now = 0L
        repeat(BackgroundThemeBackoff.MAX_STREAK) {
            failure = BackgroundThemeBackoff.recordFailure(failure, kind, now)
            now += BackgroundThemeBackoff.cooldownMs(kind, failure!!.streak)
        }
        assertEquals(BackgroundThemeBackoff.MAX_STREAK, failure!!.streak)
        /* 停止自动重试：时间过得再久也不再自动跑（只有用户主动重试 / 改配置才恢复）。 */
        assertTrue(BackgroundThemeBackoff.shouldSkip(failure, now + 365L * 24 * 60 * 60 * 1000))
    }

    @Test
    fun `换了失败类别就从一次重新数`() {
        val first = BackgroundThemeBackoff.recordFailure(null, kind, 0L)
        val stillTransient = BackgroundThemeBackoff.recordFailure(first, kind, 1L)
        assertEquals(2, stillTransient.streak)
        /* 限流和临时失败不是一回事：类别变了，连续次数重来。 */
        val rateLimited = BackgroundThemeBackoff.recordFailure(stillTransient, BackgroundThemeBackoff.Kind.RATE_LIMITED, 2L)
        assertEquals(1, rateLimited.streak)
        assertEquals(BackgroundThemeBackoff.Kind.RATE_LIMITED.name, rateLimited.kind)
    }

    @Test
    fun `认不出的类别名按临时失败处理`() {
        assertEquals(kind, BackgroundThemeBackoff.kindOf(null))
        assertEquals(kind, BackgroundThemeBackoff.kindOf("SOMETHING_ELSE"))
        assertEquals(config, BackgroundThemeBackoff.kindOf(BackgroundThemeBackoff.Kind.CONFIG.name))
    }

    @Test
    fun `从错误码判类别`() {
        assertEquals(config, BackgroundThemeBackoff.kindOfFailure("401", null))
        assertEquals(config, BackgroundThemeBackoff.kindOfFailure("403", "forbidden"))
        assertEquals(
            BackgroundThemeBackoff.Kind.RATE_LIMITED,
            BackgroundThemeBackoff.kindOfFailure("429", null),
        )
        assertEquals(config, BackgroundThemeBackoff.kindOfFailure("ai-not-configured", "未配置"))
        assertEquals(kind, BackgroundThemeBackoff.kindOfFailure("timeout", "socket timeout"))
        assertEquals(kind, BackgroundThemeBackoff.kindOfFailure(null, null))
    }
}
