package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// test/unit/android/RedirectGuardTest.kt
// M16：白名单对重定向链也要生效。
//
// 改动之前，httpRequest 缺省 `redirect: 'follow'`，而 JS 侧的 fetch shim / nativeHttpRequest
// 又总是显式传 follow —— 原生 OkHttp 于是自己跟随 3xx 到**任意**主机，并按目标 URL 重新附带
// Cookie。白名单主机上一个可控的重定向（盗链、短链、被投毒的上游）就能把请求连同目标域的
// 凭据带到白名单之外，而 JS 这一侧拿到的是一个「正常」的响应，完全看不出越界。
//
// 现在每一跳都由 redirectDenial 复核，越界那一跳给调用方一个明确的 `redirect not allowed: <host>`。

class RedirectGuardTest {

    /** 与出厂白名单里最常用的几台主机一致的一份（只做字符串与白名单比对，不碰 Context）。 */
    private fun gate(): FoliaNativeAccess {
        val allowlist = FoliaHostAllowlist()
        allowlist.addAll(
            listOf(
                "music.163.com",
                "interface.music.163.com",
                "y.qq.com",
                "ssl.ptlogin2.qq.com",
            ),
        )
        allowlist.addAll(listOf("*.126.net", "*.kugou.com", "*.qq.com"))
        return FoliaNativeAccess.testGate(allowlist)
    }

    @Test
    fun keepsRedirectsInsideTheAllowlist() {
        assertNull(redirectDenial(302, "https://y.qq.com/portal/wx_redirect.html", gate()))
        assertNull(redirectDenial(301, "https://p1.music.126.net/cover.jpg", gate()))
        assertNull(redirectDenial(307, "https://interface.music.163.com/eapi/batch", gate()))
    }

    @Test
    fun rejectsRedirectsThatLeaveTheAllowlist() {
        // M16 的验收标准：白名单主机 302 到非白名单主机时不予跟随。
        val denial = redirectDenial(302, "https://evil.example.com/steal", gate())
        assertEquals("redirect not allowed: evil.example.com", denial)
    }

    @Test
    fun rejectsLookalikeHostsAndSuffixTricks() {
        // 只是后缀相同不是同一台主机：`qq.com.attacker.test` 与 `notqq.com` 都不在白名单里。
        assertEquals(
            "redirect not allowed: qq.com.attacker.test",
            redirectDenial(302, "https://qq.com.attacker.test/x", gate()),
        )
        assertEquals(
            "redirect not allowed: notqq.com",
            redirectDenial(302, "https://notqq.com/x", gate()),
        )
        // 主机名大小写不敏感。
        assertNull(redirectDenial(302, "https://Y.QQ.COM/x", gate()))
    }

    @Test
    fun ignoresAnythingThatIsNotARedirect() {
        assertNull(redirectDenial(200, "https://evil.example.com/steal", gate()))
        assertNull(redirectDenial(404, "https://evil.example.com/steal", gate()))
        assertNull(redirectDenial(500, "https://evil.example.com/steal", gate()))
    }

    @Test
    fun rejectsRedirectsWithoutAHost() {
        // 空主机（相对跳转没解出主机、或根本解不开）：宁可不跟。
        val denial = redirectDenial(302, "", gate())
        assertTrue(denial != null && denial.startsWith("redirect not allowed:"))
    }
}
