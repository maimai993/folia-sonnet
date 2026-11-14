package top.izuna.foliamajor.ai

import org.junit.Assert.assertEquals
import org.junit.Test

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
}
