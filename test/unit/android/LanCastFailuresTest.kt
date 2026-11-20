package top.izuna.foliamajor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

// test/unit/android/LanCastFailuresTest.kt
// 投送失败的成因要分开说（issue M22）：过去 HTTP 非 2xx、SOAP Fault、空正文全折成一个 null，
// 界面于是只有一句「请确认它支持 DLNA」—— 音响断电的用户会被引向「换音响」。
// 这里钉住三件事：四种结局判得对；用户能读到的话与成因一一对应；「送进去了没起来」不被说成「连不上」。
class LanCastFailuresTest {

    private val faultBody =
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\">" +
            "<s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>" +
            "<UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>701</errorCode>" +
            "<errorDescription>Transition not available</errorDescription></UPnPError>" +
            "</detail></s:Fault></s:Body></s:Envelope>"

    // ---------------------------------------------------------------- 四种结局

    @Test
    fun `successful soap is ok and keeps the body`() {
        val outcome = LanCastFailures.classify(200, "<u:PlayResponse xmlns:u=\"x\"/>")
        assertTrue(outcome is SoapOutcome.Ok)
        assertEquals("<u:PlayResponse xmlns:u=\"x\"/>", (outcome as SoapOutcome.Ok).body)
    }

    @Test
    fun `soap fault is a rejection carrying the upnp code`() {
        val outcome = LanCastFailures.classify(500, faultBody)
        assertTrue("设备明确拒绝要单独成一类：$outcome", outcome is SoapOutcome.Rejected)
        val rejected = outcome as SoapOutcome.Rejected
        assertEquals(701, rejected.upnpCode)
        assertEquals("Transition not available", rejected.upnpDescription)
    }

    @Test
    fun `a 200 carrying a fault is still a rejection`() {
        // 有的设备用 200 回 SOAP Fault：判据看正文，不看状态码。
        val outcome = LanCastFailures.classify(200, faultBody)
        assertEquals(701, (outcome as SoapOutcome.Rejected).upnpCode)
    }

    @Test
    fun `empty body on 2xx is malformed rather than success`() {
        val outcome = LanCastFailures.classify(200, "   ")
        assertTrue(outcome is SoapOutcome.Malformed)
    }

    @Test
    fun `server error without a fault is malformed not unreachable`() {
        val outcome = LanCastFailures.classify(502, "<html>Bad Gateway</html>")
        assertTrue("设备答了，只是答的不是 SOAP：$outcome", outcome is SoapOutcome.Malformed)
        assertEquals(502, (outcome as SoapOutcome.Malformed).httpStatus)
    }

    @Test
    fun `network exceptions map to the right unreachable cause`() {
        assertEquals(UnreachableCause.NO_ANSWER, LanCastFailures.causeOf(ConnectException("Connection refused")))
        assertEquals(UnreachableCause.NO_ANSWER, LanCastFailures.causeOf(SocketTimeoutException("timeout")))
        assertEquals(UnreachableCause.UNKNOWN_HOST, LanCastFailures.causeOf(UnknownHostException("speaker.local")))
        assertEquals(UnreachableCause.NO_ROUTE, LanCastFailures.causeOf(NoRouteToHostException("no route")))
        // 包了一层的也算：OkHttp 常把真实原因挂在 cause 上。
        val wrapped = java.io.IOException("failed", ConnectException("Connection refused"))
        assertEquals(UnreachableCause.NO_ANSWER, LanCastFailures.causeOf(wrapped))
    }

    @Test
    fun `a transport failure is unreachable even when a status is passed`() {
        val outcome = LanCastFailures.classify(0, "", ConnectException("refused"))
        assertTrue(outcome is SoapOutcome.Unreachable)
    }

    // ---------------------------------------------------------------- 用户能看到的话

    @Test
    fun `an unreachable speaker is never reported as unsupported dlna`() {
        val message = LanCastFailures.message(LanCastOutcome.unreachable(LanCastFailures.causeOf(ConnectException("x"))))
        assertFalse("连不上不该说成不支持 DLNA：$message", message.contains("DLNA"))
        assertTrue("要指明是连不上：$message", message.contains("连不上"))
        // 断电的音响该被这样说，而不是让用户去换一台。
        assertTrue(message.contains("同一个 WiFi"))
    }

    @Test
    fun `a rejection carries the upnp code and reason for the user`() {
        val message = LanCastFailures.message(LanCastFailures.classify(500, faultBody))
        assertTrue("要带出错误码：$message", message.contains("701"))
        assertTrue("要带出设备自己的说法：$message", message.contains("Transition not available"))
    }

    @Test
    fun `an unknown upnp code is still shown instead of being swallowed`() {
        // 前向兼容：不认识的新错误码照实说数字，不退回含糊的「不支持 DLNA」。
        val outcome = LanCastFailures.classify(500, "<s:Fault><UPnPError><errorCode>9999</errorCode></UPnPError></s:Fault>")
        val message = LanCastFailures.message(outcome)
        assertTrue(message, message.contains("9999"))
        assertFalse(message, message.contains("DLNA"))
    }

    @Test
    fun `a malformed answer says the reply could not be understood`() {
        val message = LanCastFailures.message(LanCastFailures.classify(404, "<html/>"))
        assertTrue(message, message.contains("看不懂"))
        assertTrue("状态码要带上：$message", message.contains("404"))
    }

    @Test
    fun `messages never contain a host or a port`() {
        // 用户可见文案里不放设备的网络信息（issue M24）。
        val cases = listOf(
            LanCastFailures.classify(500, faultBody),
            LanCastFailures.classify(502, "<html/>"),
            LanCastFailures.classify(0, "", ConnectException("refused")),
            LanCastFailures.classify(0, "", UnknownHostException("livingroom.speaker.local")),
        )
        for (outcome in cases) {
            val message = LanCastFailures.message(outcome)
            assertFalse(message, message.contains("192.168"))
            assertFalse(message, message.contains("49152"))
            assertFalse(message, message.contains(".local"))
        }
    }

    // ---------------------------------------------------------------- 两段式投送

    @Test
    fun `a device that refuses didl is retried once with NOT_IMPLEMENTED`() {
        var calls = 0
        val dispatched = LanCastFailures.dispatchUri(
            setWithMetadata = {
                calls += 1
                LanCastFailures.classify(500, faultBody)
            },
            setWithoutMetadata = {
                calls += 1
                LanCastFailures.classify(200, "<ok/>")
            },
        )
        assertEquals(PlayDispatch.SENT_NOT_STARTED, dispatched.dispatch)
        assertEquals(2, calls)
    }

    @Test
    fun `an unreachable device is not retried a second time`() {
        var calls = 0
        val dispatched = LanCastFailures.dispatchUri(
            setWithMetadata = {
                calls += 1
                LanCastFailures.classify(0, "", ConnectException("refused"))
            },
            setWithoutMetadata = {
                calls += 1
                LanCastFailures.classify(0, "", ConnectException("refused"))
            },
        )
        // 网络没通就不要再等一次连接超时。
        assertEquals(PlayDispatch.FAILED, dispatched.dispatch)
        assertEquals(1, calls)
        // 没送进去的成因要跟着上来，别在会话层丢成「设备拒绝」。
        assertTrue("成因要被带出来：${dispatched.failure}", dispatched.failure is SoapOutcome.Unreachable)
    }

    @Test
    fun `a fully rejected push keeps the rejection as the cause`() {
        // 两次都被设备明确拒绝：界面上要说「设备拒绝（UPnP 码）」，而不是「连不上」。
        val dispatched = LanCastFailures.dispatchUri(
            setWithMetadata = { LanCastFailures.classify(500, faultBody) },
            setWithoutMetadata = { LanCastFailures.classify(500, faultBody) },
        )
        assertEquals(PlayDispatch.FAILED, dispatched.dispatch)
        assertEquals(701, (dispatched.failure as SoapOutcome.Rejected).upnpCode)
    }

    @Test
    fun `play report keeps unreachable when nothing got through`() {
        val dispatched = LanCastFailures.dispatchUri(
            setWithMetadata = { LanCastFailures.classify(0, "", ConnectException("refused")) },
            setWithoutMetadata = { LanCastFailures.classify(0, "", ConnectException("refused")) },
        )
        val report = LanCastFailures.playReport(dispatched) {
            error("不该走到 Play：地址都没送进去")
        }
        assertFalse(report.started)
        val message = LanCastFailures.failedReportMessage(report)
        assertTrue(message, message.contains("连不上"))
        assertFalse(message, message.contains("DLNA"))
    }

    @Test
    fun `play report keeps the rejection code when the device said no twice`() {
        val dispatched = LanCastFailures.dispatchUri(
            setWithMetadata = { LanCastFailures.classify(500, faultBody) },
            setWithoutMetadata = { LanCastFailures.classify(500, faultBody) },
        )
        val message = LanCastFailures.failedReportMessage(LanCastFailures.playReport(dispatched) {
            error("不该走到 Play：地址没送进去")
        })
        assertTrue(message, message.contains("701"))
        assertFalse("设备明确拒绝不该说成连不上：$message", message.contains("连不上"))
    }

    @Test
    fun `sent but not started is its own message`() {
        val dispatched = LanCastFailures.dispatchUri(
            setWithMetadata = { LanCastFailures.classify(200, "<ok/>") },
            setWithoutMetadata = { LanCastFailures.classify(200, "<ok/>") },
        )
        val report = LanCastFailures.playReport(dispatched) {
            LanCastFailures.classify(500, "<s:Fault><UPnPError><errorCode>701</errorCode></UPnPError></s:Fault>")
        }
        assertFalse(report.started)
        val message = LanCastFailures.failedReportMessage(report)
        assertTrue("要说清地址已经送到了：$message", message.contains("收到了地址"))
        assertTrue(message, message.contains("701"))
        // 这不是「连不上」：地址确实到了音响。
        assertFalse(message, message.contains("连不上"))
    }

    @Test
    fun `ok play means started`() {
        val dispatched = LanCastFailures.dispatchUri(
            setWithMetadata = { LanCastFailures.classify(200, "<ok/>") },
            setWithoutMetadata = { LanCastFailures.classify(200, "<ok/>") },
        )
        val report = LanCastFailures.playReport(dispatched) {
            LanCastFailures.classify(200, "<u:PlayResponse/>")
        }
        assertTrue(report.started)
        assertNull(report.failure)
        assertEquals("", LanCastFailures.failedReportMessage(report))
    }

    // ---------------------------------------------------------------- 日志标签

    @Test
    fun `labels separate the causes for the log`() {
        assertEquals("unreachable/no_answer", LanCastFailures.label(LanCastFailures.classify(0, "", ConnectException("x"))))
        assertEquals("rejected/701", LanCastFailures.label(LanCastFailures.classify(500, faultBody)))
        assertEquals("malformed/502", LanCastFailures.label(LanCastFailures.classify(502, "-")))
        assertEquals("ok", LanCastFailures.label(LanCastFailures.classify(200, "<x/>")))
    }

    @Test
    fun `target hint keeps only the network segment`() {
        val hint = LanCastFailures.targetHint("http://192.168.1.20:49152/upnp/control/AVTransport1")
        assertFalse(hint, hint.contains("192.168.1.20"))
        assertFalse(hint, hint.contains("49152"))
        assertTrue(hint, hint.contains("192.168.1.x"))
    }
}

/** 小工具：让用例读起来是「一个连不上的结局」，而不是一串构造参数。 */
private object LanCastOutcome {
    fun unreachable(cause: UnreachableCause): SoapOutcome = SoapOutcome.Unreachable(cause)
}
