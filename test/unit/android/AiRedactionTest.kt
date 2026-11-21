package top.izuna.foliamajor.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// test/unit/android/AiRedactionTest.kt
// 原生错误脱敏要和 Web 侧同等强度（issue H32）。
//
// 背景：服务商把 API key 原样回显进错误消息是常见现象，用户填错 key 时那串明文会随文案回到
// 页面、进日志、进截图反馈。Web 侧 src/utils/errorText.ts 早有一套规则，原生侧原来只有四条，
// 漏掉了「一眼能认出来的明文密钥形态」。这里钉住两件事：该遮的遮住，不该动的别动。

class AiRedactionTest {

    private val redacted = "[redacted]"

    private fun redact(text: String) = AiEndpoints.redact(text)

    @Test
    fun `OpenAI key echoed in an error message is redacted`() {
        val key = "sk-" + "a".repeat(32)
        val out = redact("Incorrect API key provided: $key")
        assertFalse("原文不应残留：$out", out.contains(key))
        assertTrue("应出现占位符：$out", out.contains(redacted))
    }

    @Test
    fun `Google AI Studio key is redacted`() {
        val key = "AIza" + "B".repeat(32)
        val out = redact("API key not valid: $key")
        assertFalse(out.contains(key))
    }

    @Test
    fun `GitHub and Slack token shapes are redacted`() {
        val ghp = "ghp_" + "c".repeat(24)
        val pat = "github_pat_" + "d".repeat(24)
        val slack = "xoxb-" + "1234567890-abcd"
        val out = redact("denied $ghp / $pat / $slack")
        assertFalse(out.contains(ghp))
        assertFalse(out.contains(pat))
        assertFalse(out.contains(slack))
    }

    @Test
    fun `bearer token is redacted`() {
        val out = redact("Authorization: Bearer abcdefghijklmnop")
        assertFalse(out.contains("abcdefghijklmnop"))
        // 保留原来的写法（大小写照抄原文），只把值换掉。
        assertTrue("应保留 bearer 字样：$out", out.contains("Bearer $redacted"))
    }

    @Test
    fun `secret and password keys are redacted`() {
        val out = redact("""{"secret":"s3cr3t-value","password":"hunter2"}""")
        assertFalse("secret 应被遮住：$out", out.contains("s3cr3t-value"))
        assertFalse("password 应被遮住：$out", out.contains("hunter2"))
    }

    @Test
    fun `query string key is redacted`() {
        val out = redact("https://example.com/v1?key=" + "e".repeat(20) + "&model=gemini")
        assertFalse(out.contains("e".repeat(20)))
    }

    // ---- 以下是不该被误伤的 ----

    @Test
    fun `ordinary numbers and model names survive`() {
        val text = "page=2 & limit=50 model=gpt-5 temperature=0.7"
        assertEquals(text, redact(text))
    }

    @Test
    fun `boolean flags are not treated as credentials`() {
        val text = "cookie=true token=false"
        assertEquals(text, redact(text))
    }

    @Test
    fun `plain prose without credentials is untouched`() {
        val text = "The request timed out after 30 seconds. Please try again."
        assertEquals(text, redact(text))
    }
}
