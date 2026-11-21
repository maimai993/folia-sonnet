package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// test/unit/android/LanCastLogTextTest.kt
// 投送日志里不许出现令牌原文、设备 IP 与端口（issue M24）。这里钉住两件事：
//  1. 该遮的遮干净 —— 令牌原文、完整 IPv4、端口、查询串一位都不出现；
//  2. 该留的线索还在 —— 网段、资源名、令牌长度/前缀，排查仍然有据可查。
// 纯 JVM：不碰 Android、不发网络请求（hostHint 只认 IP 字面量与主机名后缀，不查 DNS）。
class LanCastLogTextTest {

    // 日志纪律是「令牌原文不进日志行」：这几个用例用一条具名的令牌逐条核对。
    private val token = "a1b2c3d4e5f60718293a4b5c6d7e8f90"

    @Test
    fun `token hint keeps the shape and never the value`() {
        val hint = LanCastLogText.tokenHint(token)
        assertFalse("令牌原文不该出现在提示里：$hint", hint.contains(token))
        assertFalse("令牌原文的任何长片段都不该出现：$hint", hint.contains(token.substring(4, 12)))
        assertTrue("要记长度：$hint", hint.contains("长度 32"))
        assertTrue("要记前缀：$hint", hint.contains("a1b2"))
        assertTrue("要记形态：$hint", hint.contains("字母数字"))
    }

    @Test
    fun `token with odd characters is only described by shape`() {
        val odd = "lan-cast_token/../etc"
        val hint = LanCastLogText.tokenHint(odd)
        assertFalse(hint, hint.contains(odd))
        assertFalse("特殊字符的令牌只记形态：$hint", hint.contains("../"))
        assertTrue(hint, hint.contains("含特殊字符"))
        assertEquals("空令牌", LanCastLogText.tokenHint(""))
        assertEquals("空令牌", LanCastLogText.tokenHint(null))
    }

    @Test
    fun `device description hint drops ip port and path but keeps the segment`() {
        val hint = LanCastLogText.deviceHint("http://192.168.1.20:49152/upnp/desc/living-room.xml")
        assertFalse("完整 IP 不该出现：$hint", hint.contains("192.168.1.20"))
        assertFalse("端口不该出现：$hint", hint.contains("49152"))
        assertTrue("网段要留着：$hint", hint.contains("192.168.1.x"))
        assertTrue("资源名要留着：$hint", hint.contains("living-room.xml"))
    }

    @Test
    fun `query string is never carried into the hint`() {
        // 设备描述地址带签名的情况：查询串常常就是一次性的凭证。
        val hint = LanCastLogText.deviceHint("http://10.0.0.5:8080/desc.xml?sig=deadbeefcafe&device=1234")
        assertFalse("查询串整体丢掉：$hint", hint.contains("deadbeefcafe"))
        assertFalse(hint, hint.contains("sig="))
        assertTrue(hint, hint.contains("10.0.0.x"))
        assertTrue(hint, hint.contains("desc.xml"))
    }

    @Test
    fun `mdns hosts keep only the suffix`() {
        assertEquals("….speaker.local", LanCastLogText.hostHint("livingroom.speaker.local"))
        // 两段的 .local 名字本身就是设备身份，不记。
        assertEquals("…local", LanCastLogText.hostHint("speaker.local"))
    }

    @Test
    fun `ipv6 hint keeps the network prefix`() {
        val hint = LanCastLogText.hostHint("fd00:1234:5678:9abc:1111:2222:3333:4444")
        assertFalse("接口标识不该出现：$hint", hint.contains("4444") || hint.contains("3333"))
        assertTrue("前缀要留着：$hint", hint.startsWith("fd00:1234:5678:9abc"))
    }

    @Test
    fun `unparseable addresses never fall back to the original text`() {
        val raw = "not a url 192.168.1.99:49152"
        val hint = LanCastLogText.deviceHint(raw)
        assertFalse(hint, hint.contains("192.168.1.99"))
        assertFalse(hint, hint.contains("49152"))
        assertTrue(hint, hint.startsWith("无法解析"))
        assertEquals("无地址", LanCastLogText.deviceHint(""))
    }

    @Test
    fun `control hint keeps the resource name only`() {
        val hint = LanCastLogText.controlHint("http://172.16.4.4:49153/upnp/control/AVTransport1")
        assertFalse(hint, hint.contains("172.16.4.4"))
        assertFalse(hint, hint.contains("49153"))
        assertTrue(hint, hint.contains("172.16.4.x"))
        assertTrue(hint, hint.contains("AVTransport1"))
    }
}
