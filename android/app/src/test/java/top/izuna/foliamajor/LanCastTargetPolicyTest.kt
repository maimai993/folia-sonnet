package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.URL

// 纯 JVM 合成测试：投送目标准入（SSDP 伪造应答的防线）不需要 Android 也不需要网络。
class LanCastTargetPolicyTest {

    private fun rejected(value: String) {
        try {
            LanCastTargetPolicy.requireAllowedTarget(value, "设备地址")
            fail("应当拒绝：$value")
        } catch (expected: IOException) {
        }
    }

    private fun accepted(value: String): URL =
        LanCastTargetPolicy.requireAllowedTarget(value, "设备地址")

    @Test
    fun rejectsPublicAndSpecialAddresses() {
        // 伪造 SSDP 应答最想要的几种目标，全部要在发出请求之前挡掉。
        rejected("http://example.com/desc.xml")
        rejected("http://8.8.8.8:80/desc.xml")
        rejected("http://1.1.1.1/desc.xml")
        rejected("http://2001:4860:4860::8888/desc.xml")
        rejected("http://0.0.0.0:8080/desc.xml")
        rejected("http://239.255.255.250:1900/desc.xml")
        // 回环不在白名单里：那是手机自己，不该被当成设备描述地址。
        rejected("http://127.0.0.1:1234/desc.xml")
        rejected("http://localhost:8080/desc.xml")
    }

    @Test
    fun rejectsNonHttpSchemesCredentialsAndOddPorts() {
        rejected("file:///etc/hosts")
        rejected("ftp://192.168.1.10/desc.xml")
        rejected("gopher://192.168.1.10/desc.xml")
        rejected("http://user:pass@192.168.1.10/desc.xml")
        // 端口必须落在 DLNA 常见端口里，任意端口正是 SSRF 用来打内网服务的。
        rejected("http://192.168.1.10:22/desc.xml")
        rejected("http://192.168.1.10:6379/desc.xml")
        rejected("http://192.168.1.10:11211/desc.xml")
        rejected("")
        rejected("不是地址")
    }

    @Test
    fun acceptsPrivateRangesWithDevicePorts() {
        accepted("http://192.168.1.20:49152/AVTransport/control")
        accepted("http://192.168.1.20/desc.xml")
        accepted("http://10.0.0.5:8080/desc.xml")
        accepted("http://172.16.4.4:49153/desc.xml")
        accepted("https://192.168.31.9/desc.xml")
        accepted("http://[fd00::1]:49152/desc.xml")
        accepted("http://[fe80::1]:49152/desc.xml")
        accepted("http://livingroom.local:49152/desc.xml")
    }

    @Test
    fun onlyAcceptsSubnetSiblingsNotCrossSubnetOrInternet() {
        val device = accepted("http://192.168.1.20:49152/desc.xml")
        // 同一台机器，不同服务端口：合规设备常见。
        LanCastTargetPolicy.requireSameLanAs(accepted("http://192.168.1.20:8080/AVTransport/control"), device)
        // 同段另一台主机（有些音响把控制服务挂在桥接进程上）。
        LanCastTargetPolicy.requireSameLanAs(accepted("http://192.168.1.21:49152/AVTransport/control"), device)
        val crossSubnet = accepted("http://192.168.2.20:49152/AVTransport/control")
        try {
            LanCastTargetPolicy.requireSameLanAs(crossSubnet, device)
            fail("跨段控制地址应当被拒绝")
        } catch (expected: IOException) {
        }
        try {
            LanCastTargetPolicy.requireSameLanAs(accepted("http://10.1.1.1:49152/control"), device)
            fail("跨到另一个私有段也应当被拒绝")
        } catch (expected: IOException) {
        }
    }

    @Test
    fun classifiesHostsWithoutDnsLookup() {
        assertTrue(LanCastTargetPolicy.isLanHost("192.168.0.2"))
        assertTrue(LanCastTargetPolicy.isLanHost("[fd12::2]"))
        assertTrue(LanCastTargetPolicy.isLanHost("speaker.local"))
        assertFalse(LanCastTargetPolicy.isLanHost("speaker.example.com"))
        assertFalse(LanCastTargetPolicy.isLanHost("999.1.1.1"))
        assertFalse(LanCastTargetPolicy.isLanHost(""))
        // 回环只有显式声明才放行。
        assertFalse(LanCastTargetPolicy.isLanHost("127.0.0.1"))
        assertTrue(LanCastTargetPolicy.isLanHost("127.0.0.1", allowLoopback = true))
    }

    @Test
    fun acceptsEveryDocumentedPort() {
        // 白名单本身是常量表：改动了这里就要同步前端 lanCast.ts 的 LAN_PORTS。
        assertEquals(
            setOf(80, 443, 49152, 49153, 49154, 49155, 49156, 49157, 8080, 8443),
            LanCastTargetPolicy.ALLOWED_PORTS,
        )
    }
}
