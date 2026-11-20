package top.izuna.foliamajor.ai

import java.net.URI
import java.net.URLEncoder

/**
 * 三套协议的请求端点解析。规则与 Web 侧逐一对应：
 *
 *  · OpenAI 兼容：shared/openAICompatibleRequest.mjs 的 normalizeChatCompletionsUrl
 *  · Anthropic：src/services/aiSettings.ts 的 normalizeAnthropicMessagesUrl
 *  · Gemini：shared/geminiEndpoint.mjs 的 resolveGeminiGenerateContentUrl
 *
 * 解析不出来一律回落默认，不抛错 —— 地址是用户随手填的，一个拼错的地址不该变成
 * 「AI 不可用」，回落到默认至少还能试一次。
 */
object AiEndpoints {

    private const val DEFAULT_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
    private const val DEFAULT_GEMINI_API_BASE = "https://apig.tangbot.xyz"

    /** 默认地址：官方域名的反向代理（见 shared/geminiEndpoint.mjs 的说明）。 */
    private const val GEMINI_DEFAULT_MODEL = "gemini-3-flash-preview"

    /** DeepSeek 的兜底模型：resolveOpenAICompatibleModel 对它有特殊处理。 */
    private const val DEEPSEEK_DEFAULT_MODEL = "deepseek-flash"
    private const val GENERIC_DEFAULT_MODEL = "gpt-5.6-luna"

    /** OpenAI 兼容端点的 chat/completions 地址。 */
    fun chatCompletions(rawUrl: String): String {
        val trimmed = rawUrl.trim()
        if (trimmed.isEmpty()) return DEFAULT_CHAT_COMPLETIONS_URL
        return try {
            val parsed = URI(trimmed)
            var path = parsed.rawPath ?: ""
            path = path.trimEnd('/')
            val out = if (path.isEmpty() || path == "/") {
                parsed.resolve("/v1/chat/completions")
            } else if (Regex("/v\\d+$").containsMatchIn(path)) {
                parsed.resolve("$path/chat/completions")
            } else {
                // 已带资源段的照原样用（用户填的就是完整端点）。
                URI(parsed.scheme, parsed.rawAuthority, path, parsed.rawQuery, null)
            }
            out.toString()
        } catch (error: Exception) {
            trimmed.trimEnd('/')
        }
    }

    /** Anthropic 的 messages 端点：去掉尾部资源段，空路径补 /v1，再接 /messages。 */
    fun anthropicMessages(rawUrl: String): String {
        val candidate = rawUrl.trim().ifEmpty { "https://api.anthropic.com/v1" }
        return try {
            val parsed = URI(candidate)
            val path = (parsed.rawPath ?: "").trimEnd('/')
                .replace(Regex("/(?:messages|chat/completions|models)$"), "")
            URI(parsed.scheme, parsed.rawAuthority, "${if (path.isEmpty()) "/v1" else path}/messages", null).toString()
        } catch (error: Exception) {
            "https://api.anthropic.com/v1/messages"
        }
    }

    /** Gemini 的 generateContent 端点（三种填法都接受，见 shared/geminiEndpoint.mjs）。 */
    fun geminiGenerateContent(rawUrl: String, model: String): String {
        val modelName = model.trim().ifEmpty { GEMINI_DEFAULT_MODEL }
        val fallback = "$DEFAULT_GEMINI_API_BASE/v1beta/models/$modelName:generateContent"
        // 空格与中文冒号是最常见的两种手抄问题（见 sanitizeGeminiUrlInput）。
        val raw = rawUrl.trim().replace(Regex("\\s+"), "").replace("：", ":")
        if (raw.isEmpty()) return fallback
        if (Regex(":generateContent(?:[?#]|$)").containsMatchIn(raw)) return raw
        return try {
            val parsed = URI(raw)
            if (parsed.scheme != "http" && parsed.scheme != "https") return fallback
            val path = (parsed.rawPath ?: "").trimEnd('/')
            val newPath = if (Regex("/models/[^/]+$").containsMatchIn(path)) {
                "$path:generateContent"
            } else {
                "$path/v1beta/models/$modelName:generateContent"
            }
            URI(parsed.scheme, parsed.rawAuthority, newPath, parsed.rawQuery, null).toString()
        } catch (error: Exception) {
            fallback
        }
    }

    /** 留空模型时按端点猜：只有 DeepSeek 有特殊处理，其余用通用默认（与 Web 侧一致）。 */
    fun resolveModel(apiUrl: String, configuredModel: String): String {
        val trimmed = configuredModel.trim()
        if (trimmed.isNotEmpty()) return trimmed
        return try {
            val host = URI(apiUrl).host?.lowercase() ?: ""
            if (host == "api.deepseek.com" || host.endsWith(".deepseek.com")) DEEPSEEK_DEFAULT_MODEL
            else GENERIC_DEFAULT_MODEL
        } catch (error: Exception) {
            GENERIC_DEFAULT_MODEL
        }
    }

    /** 与 Web 侧 detectOpenAICompatibleProvider 一致：openai 本尊不作参数降级。 */
    fun detectProvider(apiUrl: String): String {
        return try {
            val host = URI(apiUrl).host?.lowercase() ?: ""
            if (host == "api.deepseek.com" || host.endsWith(".deepseek.com")) "deepseek"
            else if (host == "api.openai.com" || host.endsWith(".openai.com")) "openai"
            else "generic"
        } catch (error: Exception) {
            "generic"
        }
    }

    /**
     * 凭据的值不进日志、也不进给用户看的错误文案（H32）。
     *
     * 规则必须和 Web 侧 `src/utils/errorText.ts` 的 `REDACTION_RULES` **同等强度**：同一段文本
     * 经两条路径处理应当得到同样的结果。原来这里只有四条（Bearer、x-goog-api-key、URL query、
     * 几个键名），漏掉了「一眼能认出来的明文密钥形态」—— 而服务商在错误消息里原样回显 API key
     * 是常见现象，用户填错 key 时那串明文正好绕过原生侧，随文案回到页面、进日志、进截图反馈。
     *
     * 顺序与 Web 侧一致：先认形态，再按键名收，最后收没有键名的那种。
     */
    fun redact(text: String): String = text
        .replace(Regex("(bearer\\s+)[A-Za-z0-9._~+/=-]{8,}", RegexOption.IGNORE_CASE), "$1[redacted]")
        // 各家签发的明文密钥形态：一眼能认出来的，值不会留全。
        .replace(
            Regex("\\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})"),
            "[redacted]",
        )
        .replace(Regex("(x-goog-api-key[\"']?\\s*[:=]\\s*[\"']?)[^\\s\"',;]+", RegexOption.IGNORE_CASE), "$1[redacted]")
        .replace(Regex("([?&](?:key|api[_-]?key|token|access_token)=)[^&\\s\"']+", RegexOption.IGNORE_CASE), "$1[redacted]")
        /*
         * 带引号的整段值，以及没有引号的值。
         *
         * 键名比原来更宽，和 Web 侧对齐：secret / password / cookie / credential 也算。
         * 「没有引号」那条**必须**排除 true/false/null/undefined —— 那些是开关不是凭据；
         * 而且规则只在键名后面跟 `:` 或 `=` 时才动手，`page=2`、`model=gpt-5` 里的
         * page / model 都不在键名里，不会被误伤。
         *
         * 键名与分隔符用捕获组**留着**（`$1`）：`Authorization: Bearer xxx` 这种，
         * 换成整段 `[redacted]` 会把「谁被遮了」这条线索也一起吃掉，读日志的人反而看不懂。
         */
        .replace(
            Regex(
                "([A-Za-z0-9_-]*(?:api[\\s_-]?key|token|secret|password|passwd|pwd|credential|cookie|authorization|key)[\"']?\\s*[:=]\\s*(?:bearer\\s+)?[\"'])" +
                    "(?:(?![\"']).)*([\"'])",
                RegexOption.IGNORE_CASE,
            ),
            "$1[redacted]$2",
        )
        .replace(
            Regex(
                "([A-Za-z0-9_-]*(?:api[\\s_-]?key|token|secret|password|passwd|pwd|credential|cookie|authorization|key)[\"']?\\s*[:=]\\s*(?:bearer\\s+)?)" +
                    "(?!(?:true|false|null|undefined)(?![A-Za-z0-9_-]))(?=[^\\s\"',;&}])[^\\s\"',;&}]+",
                RegexOption.IGNORE_CASE,
            ),
            "$1[redacted]",
        )

    /** 设置里没填站点时给 Gemini 的默认反代地址（导出给日志/诊断用）。 */
    const val GEMINI_FALLBACK_BASE = DEFAULT_GEMINI_API_BASE

    @Suppress("unused")
    private fun unusedEncode(s: String): String = URLEncoder.encode(s, "UTF-8")
}
