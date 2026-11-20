package top.izuna.foliamajor.ai

import org.junit.Assert.assertEquals
import org.junit.Test
import top.izuna.foliamajor.FoliaPrivateNetworks
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

// android/app/src/test/java/top/izuna/foliamajor/ai/AiEndpointsTest.kt
// 三套协议端点解析的边界。这里的规则错一条，那一家的用户就是「填了 Key 也发不出去」，
// 而报错只会是一次请求失败，看不出是地址拼错了 —— 所以逐条钉住。

class AiEndpointsTest {

    // ---- OpenAI 兼容：normalizeChatCompletionsUrl 的三种填法 ----

    @Test
    fun `OpenAI 空地址回落默认`() {
        assertEquals("https://api.openai.com/v1/chat/completions", AiEndpoints.chatCompletions(""))
    }

    @Test
    fun `OpenAI 只有域名补全路径`() {
        assertEquals("https://api.deepseek.com/v1/chat/completions",
                AiEndpoints.chatCompletions("https://api.deepseek.com"))
    }

    @Test
    fun `OpenAI 带版本号补 chat completions`() {
        assertEquals("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
                AiEndpoints.chatCompletions("https://dashscope.aliyuncs.com/compatible-mode/v1"))
    }

    @Test
    fun `OpenAI 已是完整端点原样保留`() {
        assertEquals("https://x.test/v1/chat/completions",
                AiEndpoints.chatCompletions("https://x.test/v1/chat/completions"))
    }

    @Test
    fun `OpenAI 解析失败退回裁剪后的原文`() {
        assertEquals("not a url", AiEndpoints.chatCompletions("not a url"))
    }

    // ---- Anthropic：normalizeAnthropicMessagesUrl ----

    @Test
    fun `Anthropic 空地址回落官方`() {
        assertEquals("https://api.anthropic.com/v1/messages", AiEndpoints.anthropicMessages(""))
    }

    @Test
    fun `Anthropic 已带 messages 不重复拼接`() {
        assertEquals("https://x.test/v1/messages",
                AiEndpoints.anthropicMessages("https://x.test/v1/messages"))
    }

    @Test
    fun `Anthropic 尾部资源段被剥掉再拼`() {
        // 用户把 OpenAI 那套习惯带过来：填了 /chat/completions，要能纠正回来。
        assertEquals("https://x.test/v1/messages",
                AiEndpoints.anthropicMessages("https://x.test/v1/chat/completions"))
    }

    // ---- Gemini：resolveGeminiGenerateContentUrl 的三种填法 ----

    @Test
    fun `Gemini 空地址回落默认反代`() {
        assertEquals("https://apig.tangbot.xyz/v1beta/models/gemini-3-flash-preview:generateContent",
                AiEndpoints.geminiGenerateContent("", ""))
    }

    @Test
    fun `Gemini 只填域名按官方路径补全`() {
        assertEquals("https://apig.tangbot.xyz/v1beta/models/m1:generateContent",
                AiEndpoints.geminiGenerateContent("https://apig.tangbot.xyz", "m1"))
    }

    @Test
    fun `Gemini 已带动作名原样保留`() {
        assertEquals("https://x.test/v1beta/models/m1:generateContent",
                AiEndpoints.geminiGenerateContent("https://x.test/v1beta/models/m1:generateContent", "m2"))
    }

    @Test
    fun `Gemini 中文冒号被清洗`() {
        // 中文输入法打出「https：//」，构造 URL 就炸 —— 清洗掉才能用。
        assertEquals("https://x.test/v1beta/models/m1:generateContent",
                AiEndpoints.geminiGenerateContent("https：//x.test", "m1"))
    }

    @Test
    fun `Gemini 解析失败回落默认不抛错`() {
        assertEquals("https://apig.tangbot.xyz/v1beta/models/gemini-3-flash-preview:generateContent",
                AiEndpoints.geminiGenerateContent("://bad", ""))
    }

    // ---- 模型与 provider 判定 ----

    @Test
    fun `配置了模型优先用配置`() {
        assertEquals("my-model", AiEndpoints.resolveModel("https://x.test/v1", "my-model"))
    }

    @Test
    fun `DeepSeek 端点空模型用 deepseek 默认`() {
        assertEquals("deepseek-flash",
                AiEndpoints.resolveModel("https://api.deepseek.com/v1/chat/completions", ""))
    }

    @Test
    fun `其他端点空模型用通用默认`() {
        assertEquals("gpt-5.6-luna", AiEndpoints.resolveModel("https://x.test/v1", ""))
    }

    @Test
    fun `provider 判定 OpenAI 本尊与 DeepSeek`() {
        assertEquals("openai", AiEndpoints.detectProvider("https://api.openai.com/v1/chat/completions"))
        assertEquals("deepseek", AiEndpoints.detectProvider("https://api.deepseek.com/v1/chat/completions"))
        assertEquals("generic", AiEndpoints.detectProvider("https://x.test/v1"))
    }

    // ---- 脱敏 ----

    @Test
    fun `redact 不让密钥进日志`() {
        // 与 Web 侧 redact 同一覆盖面：Bearer 头、URL 上的 key=、JSON 里的 "apiKey"。
        // 纯文本里裸写的 key= 不在两侧的覆盖内（Web 侧第 3 条正则同样要求 [?&] 前缀）。
        val line = """Bearer abc123def456789; url https://x.test?api_key=sk-abcd12345678; {"authorization":"Bearer zz9888hh0011"}"""
        val out = AiEndpoints.redact(line)
        assertEquals(false, out.contains("abc123def456789"))
        assertEquals(false, out.contains("sk-abcd12345678"))
        assertEquals(false, out.contains("zz9888hh0011"))
    }

    // ---- 端点准入（M30）----
    //
    // 改前这里什么都不拦：baseUrl 填 127.0.0.1 / 10.x / 192.168.x，原生网络栈就照着发出去，
    // 响应原样回到页面 —— 页面侧的主机白名单对这条通道无效。
    // 这里钉住三件事：内网与环回在**发请求之前**就被拒；公网主机照旧发得出去
    // （否则就是把所有人自建的第三方 AI 代理一起打死）；地址段判定与 httpRequest 同一条。

    /** 一个「通过了主机判定」的桩：记下被放行的地址，不做白名单（那是 FoliaNativeAccess 的事）。 */
    private class PassGate : (String) -> Unit {
        val passed = ArrayList<String>()
        override fun invoke(url: String) {
            passed.add(url)
        }
    }

    private fun openAiConfig(baseUrl: String) = AiConfig(
        provider = "custom",
        geminiApiKey = "",
        geminiApiUrl = "",
        apiKey = "fixture-key",
        model = "m1",
        baseUrl = baseUrl,
        temperature = 0.7,
    )

    /**
     * 起一个只活在这条用例里的本地服务：收到请求就回一个最小的 chat/completions 负载。
     *
     * 不用 com.sun.net.httpserver —— 它不在 kotlin-stdlib 能编到的范围里，安卓的单元测试
     * 环境也不保证有；裸 ServerSocket 几下就够，还顺手数得出「到底发了几次」。
     */
    private class LocalEndpoint {
        val socket = ServerSocket(0, 0, InetAddress.getLoopbackAddress())
        val port: Int = socket.localPort
        val served = AtomicInteger()

        init {
            thread(isDaemon = true) {
                while (!socket.isClosed) {
                    try {
                        val client = socket.accept()
                        val buffer = ByteArray(2048)
                        val read = client.getInputStream().read(buffer)
                        val head = if (read > 0) String(buffer, 0, read) else ""
                        if (head.contains("HTTP/")) served.incrementAndGet()
                        val body = """{"choices":[{"message":{"content":"ok"}}]}""".toByteArray()
                        val response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                            "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
                        client.getOutputStream().write(response.toByteArray())
                        client.getOutputStream().write(body)
                        client.getOutputStream().flush()
                        client.close()
                    } catch (_: Exception) {
                        break
                    }
                }
            }
        }

        fun stop() {
            runCatching { socket.close() }
        }
    }

    private fun assertBlocked(baseUrl: String) {
        val gate = PassGate()
        try {
            AiCompletion.run(openAiConfig(baseUrl), "s", "p", 0, false) { url -> gate(url) }
            throw AssertionError("$baseUrl 应当被拦下")
        } catch (error: AiCompletion.AiException) {
            assertEquals("ai-endpoint-blocked", error.code)
        }
        // 判定发生在发请求之前：闸门一次都没被问过。
        assertEquals(emptyList<String>(), gate.passed)
    }

    @Test
    fun `AI 端点指向回环地址时不发请求就拒绝`() {
        val local = LocalEndpoint()
        try {
            assertBlocked("http://127.0.0.1:${local.port}/v1")
            // 服务端一次都没被敲过：拦在发请求之前，不是拦在收到响应之后。
            assertEquals(0, local.served.get())
        } finally {
            local.stop()
        }
    }

    @Test
    fun `AI 端点指向私网地址时不发请求就拒绝`() {
        // 10/8、172.16/12、192.168/16 三条都要拦：少一条就是少一条通往内网的路。
        assertBlocked("http://10.1.2.3:8788/v1")
        assertBlocked("http://172.20.0.9:8788/v1")
        assertBlocked("http://192.168.1.10:8788/v1")
        assertBlocked("http://[::1]:8788/v1")
        assertBlocked("http://localhost:8788/v1")
    }

    @Test
    fun `用户配置的公网自建端点照旧发得出去`() {
        /*
         * 这是 M30 的另一半：只拦内网，不搞「只许某几家」的白名单 —— 很多人用的就是
         * 自建的 / 第三方的 API 代理，它们本来就该能用。
         *
         * 用 httpbin 之类的公网地址会让单测依赖外网，所以这里只验「判定放行」这一步：
         * 公网主机过闸之后，被放行的正是拼出来的那条地址。
         */
        val gate = PassGate()
        try {
            AiCompletion.run(openAiConfig("https://proxy.example.test/v1"), "s", "p", 0, false) { url -> gate(url) }
        } catch (_: Exception) {
            // 这一步不真的连外网：放行之后可能失败在 DNS / 连接上，与准入判定无关。
        }
        assertEquals(listOf("https://proxy.example.test/v1/chat/completions"), gate.passed)
    }

    @Test
    fun `私有网段按与 httpRequest 相同的口径拦下`() {
        // 这一组和 FoliaPrivateNetworks 共用同一份实现：这里列出来的，httpRequest 那边同样被拦。
        // 期望值是「命中的那一段」，不是主机本身 —— 日志与错误文案只说地址段。
        val ranges = mapOf(
            "127.0.0.1" to "127.0.0.0/8",
            "127.1.2.3" to "127.0.0.0/8",
            "0.0.0.0" to "0.0.0.0/8",
            "10.0.0.1" to "10.0.0.0/8",
            "172.16.0.1" to "172.16.0.0/12",
            "172.31.255.255" to "172.16.0.0/12",
            "192.168.0.1" to "192.168.0.0/16",
            "169.254.1.1" to "169.254.0.0/16",
            "100.64.0.1" to "100.64.0.0/10",
            "198.19.0.1" to "198.18.0.0/15",
            "224.0.0.1" to "224.0.0.0/4",
            "::1" to "::1",
            "::" to "::",
            "fc00::1" to "fc00::/7",
            "fd12:3456::1" to "fc00::/7",
            "fe80::1" to "fe80::/10",
            "::ffff:192.168.0.1" to "::ffff:192.168.0.0/16",
            "localhost" to "localhost",
            "nas.localhost" to "localhost",
        )
        ranges.forEach { (host, range) ->
            assertEquals(host, range, FoliaPrivateNetworks.describePrivateLiteral(host))
            // 上面每一条都同时被判成内网：describe 与 isPrivate 是同一份实现的两种说法。
            assertEquals(host, true, FoliaPrivateNetworks.isPrivateLiteral(host))
        }
        // 公网字面量与解析不出来的东西不算内网（白名单那一步另外管）。
        assertEquals(null, FoliaPrivateNetworks.describePrivateLiteral("8.8.8.8"))
        assertEquals(null, FoliaPrivateNetworks.describePrivateLiteral("api.deepseek.com"))
        assertEquals(null, FoliaPrivateNetworks.describePrivateLiteral("172.32.0.1"))
        assertEquals(false, FoliaPrivateNetworks.isPrivateLiteral("8.8.8.8"))
    }
}