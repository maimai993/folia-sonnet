package top.izuna.foliamajor.ai

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * 原生 AI 补全：拼三套协议的请求体、OkHttp 发出、带 OpenAI 兼容端的参数降级重试。
 *
 * **为什么搬**：请求由原生发起后，WebView 冻不冻结都与它无关 —— OkHttp 在自己的
 * 线程池里跑完，答案落盘给下次拉取。Web 侧那条 createAiFetch → aiRequest 只是把
 * HTTP 搬过桥，发起那一刻 JS 必须活着；这条不再有那个依赖。
 *
 * 协议规则与 src/services/aiCompletion.ts 的 runOpenAi / runAnthropic / runGemini
 * 一一对应；参数降级与 shared/openAICompatibleRequest.mjs 的 sendOpenAICompatibleRequest
 * 同一套判据（param 字段点名拒绝 → 重试）。
 */
object AiCompletion {

    private const val TAG = "AiCompletion"

    private val client: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(180, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    /** 端点能力缓存：降级学到的（某端点不认 response_format / max_tokens）下次直接不带。 */
    private data class Caps(val key: String) {
        var responseFormat: Boolean? = null
        var tokenField: String? = null    // "max_tokens" | "max_completion_tokens"
    }
    private val caps = ConcurrentHashMap<String, Caps>()

    private fun capsFor(apiUrl: String, model: String): Caps =
            caps.computeIfAbsent("$apiUrl|$model") { Caps(it) }

    class AiException(val code: String, detail: String) : Exception(detail.ifEmpty { code })

    /**
     * 跑一次补全。返回模型文本。
     *
     * @param system 系统提示词
     * @param prompt 用户提示词
     * @param maxTokens 输出上限（0 = 不带）
     * @param jsonMode true 时请求 JSON 输出（Gemini 用 responseMimeType，OpenAI 用 response_format）
     */
    fun run(config: AiConfig, system: String, prompt: String,
            maxTokens: Int, jsonMode: Boolean): String {
        if (!config.configured) {
            throw AiException("ai-not-configured", "AI 未配置")
        }
        return when (AiProviderPreset.of(config.provider).protocol) {
            "gemini" -> runGemini(config, system, prompt, maxTokens, jsonMode)
            "anthropic" -> runAnthropic(config, system, prompt, maxTokens)
            else -> runOpenAiCompatible(config, system, prompt, maxTokens, jsonMode)
        }
    }

    // ---- Gemini ----

    private fun runGemini(config: AiConfig, system: String, prompt: String,
                          maxTokens: Int, jsonMode: Boolean): String {
        val model = config.model.trim().ifEmpty { AiProviderPreset.of("gemini").recommendedModel }
        val url = AiEndpoints.geminiGenerateContent(config.geminiApiUrl, model)
        val body = JSONObject().apply {
            put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", system))))
            put("contents", JSONArray().put(JSONObject().put("parts", JSONArray().put(JSONObject().put("text", prompt)))))
            put("generationConfig", JSONObject().apply {
                if (jsonMode) put("responseMimeType", "application/json")
                if (maxTokens > 0) put("maxOutputTokens", maxTokens)
            })
        }
        val request = Request.Builder().url(url)
                .header("Content-Type", "application/json")
                .header("x-goog-api-key", config.geminiApiKey)
                .post(body.toString().toRequestBody(jsonMediaType))
                .build()
        val response = execute(request)
        if (!response.isSuccessful) fail(response)
        val payload = JSONObject(response.body?.string() ?: "")
        val parts = payload.optJSONArray("candidates")?.optJSONObject(0)
                ?.optJSONObject("content")?.optJSONArray("parts") ?: JSONArray()
        val text = StringBuilder()
        for (i in 0 until parts.length()) {
            text.append(parts.optJSONObject(i)?.optString("text", "") ?: "")
        }
        if (text.isBlank()) throw AiException("ai-empty-response", "AI 返回为空")
        return text.toString()
    }

    // ---- Anthropic ----

    private fun runAnthropic(config: AiConfig, system: String, prompt: String,
                             maxTokens: Int): String {
        val preset = AiProviderPreset.of("anthropic")
        val base = config.baseUrl.trim().ifEmpty { preset.baseUrl }
        val url = AiEndpoints.anthropicMessages(base)
        val model = config.model.trim().ifEmpty { preset.recommendedModel }
        val body = JSONObject().apply {
            put("model", model)
            put("max_tokens", if (maxTokens > 0) maxTokens else 4096)
            if (system.isNotEmpty()) put("system", system)
            put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", prompt)))
        }
        val request = Request.Builder().url(url)
                .header("Content-Type", "application/json")
                .header("x-api-key", config.apiKey)
                .header("anthropic-version", "2023-06-01")
                .post(body.toString().toRequestBody(jsonMediaType))
                .build()
        val response = execute(request)
        if (!response.isSuccessful) fail(response)
        val payload = JSONObject(response.body?.string() ?: "")
        val blocks = payload.optJSONArray("content") ?: JSONArray()
        val text = StringBuilder()
        for (i in 0 until blocks.length()) {
            val block = blocks.optJSONObject(i) ?: continue
            if (block.optString("type") == "text") text.append(block.optString("text", ""))
        }
        if (text.isBlank()) throw AiException("ai-empty-response", "AI 返回为空")
        return text.toString()
    }

    // ---- OpenAI 兼容（含参数降级重试） ----

    private fun runOpenAiCompatible(config: AiConfig, system: String, prompt: String,
                                    maxTokens: Int, jsonMode: Boolean): String {
        val preset = AiProviderPreset.of(config.provider)
        val base = config.baseUrl.trim().ifEmpty { preset.baseUrl }
        val url = AiEndpoints.chatCompletions(base)
        val model = AiEndpoints.resolveModel(url, config.model)
        val provider = AiEndpoints.detectProvider(url)
        val caps = capsFor(url, model)
        val temperature = config.temperature.coerceIn(0.0, 2.0)

        val requestBody = JSONObject().apply {
            put("model", model)
            put("messages", JSONArray()
                    .put(JSONObject().put("role", "system").put("content", system))
                    .put(JSONObject().put("role", "user").put("content", prompt)))
            put("temperature", temperature)
            if (maxTokens > 0) put("max_tokens", maxTokens)
            // 只有 OpenAI 本尊吃 json_schema；长尾兼容端点会整条拒绝，所以都用纯 JSON 模式。
            if (jsonMode && provider == "openai") {
                put("response_format", JSONObject().put("type", "json_object"))
            }
        }
        // 降级学过的：这条端点不认的字段一开始就不带。
        if (provider != "openai" && caps.responseFormat == false) requestBody.remove("response_format")
        if (caps.tokenField == "max_completion_tokens" && requestBody.has("max_tokens")) {
            requestBody.put("max_completion_tokens", requestBody.getInt("max_tokens"))
            requestBody.remove("max_tokens")
        }

        var droppedFormat = false
        var attempts = 0
        while (true) {
            attempts += 1
            if (attempts > 4) throw AiException("ai-request-failed", "参数降级重试次数用尽")
            val request = Request.Builder().url(url)
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer ${config.apiKey}")
                    .post(requestBody.toString().toRequestBody(jsonMediaType))
                    .build()
            val response = execute(request)
            if (response.isSuccessful) {
                if (provider != "openai") {
                    if (droppedFormat) caps.responseFormat = false
                    if (requestBody.has("max_completion_tokens")) caps.tokenField = "max_completion_tokens"
                    else if (requestBody.has("max_tokens")) caps.tokenField = "max_tokens"
                }
                val payload = JSONObject(response.body?.string() ?: "")
                val message = payload.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
                val refusal = message?.optString("refusal", "") ?: ""
                if (refusal.isNotBlank()) {
                    throw AiException("ai-refused", AiEndpoints.redact(refusal).take(300))
                }
                val content = message?.opt("content")
                val text = when {
                    content is String -> content
                    content is JSONArray -> {
                        val sb = StringBuilder()
                        for (i in 0 until content.length()) {
                            sb.append(content.optJSONObject(i)?.optString("text", "") ?: "")
                        }
                        sb.toString()
                    }
                    else -> ""
                }
                if (text.isBlank()) throw AiException("ai-empty-response", "AI 返回为空")
                return text
            }
            if (provider == "openai" || (response.code != 400 && response.code != 422)) fail(response)
            val errorText = response.body?.string() ?: ""
            if (requestBody.has("response_format") && rejects(response.code, errorText, "response_format")) {
                requestBody.remove("response_format")
                droppedFormat = true
                Log.i(TAG, "[ai] endpoint rejected response_format; retrying without it")
                continue
            }
            if (requestBody.has("max_tokens") && rejects(response.code, errorText, "max_tokens")) {
                requestBody.put("max_completion_tokens", requestBody.getInt("max_tokens"))
                requestBody.remove("max_tokens")
                Log.i(TAG, "[ai] endpoint rejected max_tokens; retrying with max_completion_tokens")
                continue
            }
            fail(response)
        }
    }

    /** 端点点名拒绝了这个参数吗（判据与 shared/openAICompatibleRequest.mjs 同一套）。 */
    private fun rejects(status: Int, text: String, parameter: String): Boolean {
        if ((status != 400 && status != 422) ||
                Regex("rate.?limit|concurrency|quota", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
            return false
        }
        val payload = try { JSONObject(text) } catch (error: Exception) { return false }
        val error = payload.optJSONObject("error")
        val exactParam = error?.optString("param", "") ?: payload.optString("param", "")
        if (exactParam == parameter) {
            val detail = "${error?.optString("code", "") ?: payload.optString("code", "")} " +
                    "${error?.optString("message", "") ?: payload.optString("message", "")}"
            return Regex("unsupported|invalid|unknown|unrecognized|not allowed|extra_forbidden",
                    RegexOption.IGNORE_CASE).containsMatchIn(detail)
        }
        val detailArray = payload.optJSONArray("detail")
        if (detailArray != null) {
            for (i in 0 until detailArray.length()) {
                val issue = detailArray.optJSONObject(i) ?: continue
                val loc = issue.optJSONArray("loc") ?: continue
                var hasParam = false
                for (j in 0 until loc.length()) {
                    if (loc.optString(j) == parameter) hasParam = true
                }
                if (hasParam && (issue.optString("type") == "extra_forbidden" ||
                                issue.optString("msg").contains("extra inputs are not permitted"))) {
                    return true
                }
            }
        }
        val message = error?.optString("message", "") ?: payload.optString("message", "")
        if (message.isEmpty()) return false
        val escaped = Regex.escape(parameter)
        return Regex(
                "(?:unsupported|invalid|unknown|unrecognized|not allowed)\\s+(?:(?:parameter|argument|field)\\s*)?[:=]?\\s*[\"']?$escaped\\b" +
                "|\\b$escaped\\b\\s+(?:is\\s+)?(?:unsupported|not supported|not allowed|invalid)",
                RegexOption.IGNORE_CASE).containsMatchIn(message)
    }

    private fun execute(request: Request): okhttp3.Response =
            try {
                client.newCall(request).execute()
            } catch (error: Exception) {
                throw AiException("ai-request-failed",
                        AiEndpoints.redact(error.message ?: "network error").take(300))
            }

    private fun fail(response: okhttp3.Response): Nothing {
        val body = try { response.body?.string() ?: "" } catch (error: Exception) { "" }
        val detail = try {
            val parsed = JSONObject(body)
            val error = parsed.opt("error")
            when {
                error is String -> error
                error is JSONObject -> error.optString("message", "")
                else -> parsed.optString("message", "")
            }
        } catch (error: Exception) {
            body.trim()
        }
        throw AiException("ai-http-error:${response.code}",
                AiEndpoints.redact(detail).take(300))
    }
}
