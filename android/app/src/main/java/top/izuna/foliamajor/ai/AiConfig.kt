package top.izuna.foliamajor.ai

import org.json.JSONObject

/**
 * 服务商预设。与 shared/ai/providerRegistry.mjs（经 src/services/aiSettings.ts 读）同一份
 * 数据的 Kotlin 侧拷贝：地址、推荐模型、协议三样，只服务「原生直接发 AI 请求」这一条路。
 *
 * **改动两边要同步**：这里少一家，那一家的用户在原生补全这条路上就发不出请求
 * （Web 侧会回落到自己的 fetch 实现，功能还在，只是退回「网页发起」那一路）。
 *
 * 除 Gemini 与 Anthropic 外都是 OpenAI 兼容端点 —— 区别只是预设地址与推荐模型。
 */
data class AiProviderPreset(
    val id: String,
    val protocol: String,           // openai | anthropic | gemini
    val baseUrl: String,
    val recommendedModel: String,
) {
    companion object {
        val GEMINI = AiProviderPreset("gemini", "gemini",
                "https://generativelanguage.googleapis.com/v1beta", "gemini-3-flash-preview")
        val DEEPSEEK = AiProviderPreset("deepseek", "openai",
                "https://api.deepseek.com", "deepseek-flash")
        /**
         * 免费渠道：地址与模型写死，密钥是本机的机器码（由 Web 侧生成后推上来）。
         *
         * 协议就是普通的 OpenAI 兼容 —— 服务端那把机器码建出来的是一把普通 Key，
         * 走的也是同一个网关。所以原生这条补全路径**照常适用**，不需要为它开例外；
         * 它与别家唯一的差别只是「密钥不是用户填的」。
         */
        val FOLIAWORK = AiProviderPreset("foliawork", "openai",
                "https://apiai.tangbot.xyz/v1", "deepseek-v4.1-flash")
        val MIMO = AiProviderPreset("mimo", "openai",
                "https://api.xiaomimimo.com/v1", "mimo-v2.6-flash")
        val QWEN = AiProviderPreset("qwen", "openai",
                "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.8-flash")
        val TENCENTCLOUD = AiProviderPreset("tencentcloud", "openai",
                "https://tokenhub.tencentmaas.com/v1", "deepseek-v4-flash")
        val OPENAI = AiProviderPreset("openai", "openai",
                "https://api.openai.com/v1", "gpt-5.6-luna")
        val ANTHROPIC = AiProviderPreset("anthropic", "anthropic",
                "https://api.anthropic.com/v1", "claude-haiku-5-5")
        val KIMI = AiProviderPreset("kimi", "openai",
                "https://api.moonshot.cn/v1", "kimi-k2.6")
        val GLM = AiProviderPreset("glm", "openai",
                "https://open.bigmodel.cn/api/paas/v4", "glm-5.2")
        val CUSTOM = AiProviderPreset("custom", "openai", "", "")

        val ALL: Map<String, AiProviderPreset> = listOf(
                GEMINI, DEEPSEEK, FOLIAWORK, MIMO, QWEN, TENCENTCLOUD,
                OPENAI, ANTHROPIC, KIMI, GLM, CUSTOM).associateBy { it.id }

        fun of(id: String): AiProviderPreset = ALL[id] ?: GEMINI
    }
}

/**
 * 原生侧的 AI 连接配置。字段与 src/services/aiSettings.ts 的 localStorage 形状一致，
 * 由 Web 侧在设置变化与启动时整份推上来（FoliaNative.setAiConfig）。
 *
 * 凭据**只存原生**（FoliaSettingsStore）：Web 那份 localStorage 照旧给设置界面用，
 * 但真正发请求的是原生 —— 与播放链路「真相在原生」同一条纪律。
 */
data class AiConfig(
    val provider: String,
    val geminiApiKey: String,
    val geminiApiUrl: String,
    val apiKey: String,          // 非 Gemini provider 的密钥
    val model: String,           // 留空用预设推荐模型
    val baseUrl: String,         // 留空用预设默认站点（custom 必填）
    val temperature: Double,
) {
    val configured: Boolean
        get() = when (provider) {
            "gemini" -> geminiApiKey.isNotEmpty()
            "custom" -> apiKey.isNotEmpty() && baseUrl.isNotEmpty()
            else -> apiKey.isNotEmpty()
        }

    fun toJson(): JSONObject = JSONObject().apply {
        put("provider", provider)
        put("geminiApiKey", geminiApiKey)
        put("geminiApiUrl", geminiApiUrl)
        put("apiKey", apiKey)
        put("model", model)
        put("baseUrl", baseUrl)
        put("temperature", temperature)
    }

    companion object {
        fun fromJson(o: JSONObject): AiConfig = AiConfig(
            provider = o.optString("provider", "gemini"),
            geminiApiKey = o.optString("geminiApiKey", ""),
            geminiApiUrl = o.optString("geminiApiUrl", ""),
            apiKey = o.optString("apiKey", ""),
            model = o.optString("model", ""),
            baseUrl = o.optString("baseUrl", ""),
            temperature = if (o.has("temperature")) o.optDouble("temperature", 0.7) else 0.7,
        )
    }
}
