package top.izuna.foliamajor

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// test/unit/android/CookieDomainAllowlistTest.kt
// cookie 域白名单（issue H2 的真机回归）。
//
// 背景：H2 一开始让 cookie 共用 httpRequest 的主机白名单，而那个名单只收「具体接口主机」
// （music.163.com、y.qq.com）。cookie 却是按**主域**存的 —— 登录态躺在 163.com / qq.com /
// 126.net 上，前端 chrome.cookies 兼容层本来也按主域读写。
//
// 真机上真出事了：装上包之后
//   denied cookiesGetAll: cookie domain qq.com is not allowlisted
// 这类日志刷了 218 条，QQ 与网易云的登录态全部读不出来。
//
// 这个用例钉住「主域必须放行」，同时钉住「不能因此变成任意域都放行」。

class CookieDomainAllowlistTest {

    /** 与 FoliaNativeAccess.buildCookieDomainList 同一份登记内容。 */
    private fun list(): FoliaHostAllowlist {
        val allowlist = FoliaHostAllowlist()
        allowlist.addAll(
            listOf(
                "163.com", "*.163.com",
                "126.net", "*.126.net",
                "music.163.com", "www.music.163.com", "interface.music.163.com", "interface3.music.163.com",
                "qq.com", "*.qq.com",
                "y.qq.com", "i.y.qq.com", "u.y.qq.com", "c.y.qq.com",
                "graph.qq.com", "ptlogin2.qq.com", "ssl.ptlogin2.qq.com", "xui.ptlogin2.qq.com",
                "tencent.com", "weixin.qq.com",
                "kugou.com", "www.kugou.com", "m.kugou.com", "kugou.net",
            ),
        )
        return allowlist
    }

    @Test
    fun `登录态所在的主域必须放行`() {
        val allowlist = list()
        // 这四个是真机上实际被拒的那些。
        assertTrue("网易云主域", allowlist.matches("163.com"))
        assertTrue("网易图床/接口主域", allowlist.matches("126.net"))
        assertTrue("QQ 主域", allowlist.matches("qq.com"))
        assertTrue("腾讯主域", allowlist.matches("tencent.com"))
    }

    @Test
    fun `前端实际传过来的具体域也放行`() {
        val allowlist = list()
        assertTrue(allowlist.matches("www.music.163.com"))
        assertTrue(allowlist.matches("i.y.qq.com"))
        assertTrue(allowlist.matches("music.163.com"))
        assertTrue(allowlist.matches("y.qq.com"))
        assertTrue(allowlist.matches("kugou.com"))
    }

    @Test
    fun `主域下面的子域跟着放行`() {
        val allowlist = list()
        // CookieManager 按域匹配，子域上落的 cookie 也要读得到。
        assertTrue(allowlist.matches("p1.music.126.net"))
        assertTrue(allowlist.matches("m.music.163.com"))
    }

    @Test
    fun `不能变成任意域都放行`() {
        val allowlist = list()
        assertFalse("不属于任何平台", allowlist.matches("example.com"))
        assertFalse("只有相似后缀不算", allowlist.matches("evil163.com"))
        assertFalse("只有相似后缀不算", allowlist.matches("notqq.com"))
        assertFalse("空值不放行", allowlist.matches(""))
        assertFalse("空值不放行", allowlist.matches(null))
        // 顶层域绝不能被当成「父域」放进来。
        assertFalse(allowlist.matches("com"))
        assertFalse(allowlist.matches("net"))
    }

    @Test
    fun `归一后拿到的是登记的那个主域`() {
        val allowlist = list()
        // 前端传 i.y.qq.com，实际读 cookie 要用登记的 qq.com 那一片。
        val domain = allowlist.domainOf("i.y.qq.com")
        assertTrue("应当认出 qq.com 这一片，实际 $domain", domain == "qq.com" || domain == "i.y.qq.com")
    }
}
