package top.izuna.foliamajor.ai

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Locale

// android/app/src/main/java/top/izuna/foliamajor/ai/BackgroundThemeRules.kt
// 后台主题的纯规则：配置解析、证据词、模板注入、identity 指纹、叠层 sanitize 与 payload 形状。
// 不碰 Android context、网络、设置存储和播放器，便于在 JVM 单测里直接跑。

/** 云端 resolve 的一条候选：只有缓存键和模型标出的证据词。 */
internal data class CloudCandidate(
    val key: String,
    val words: List<String>,
)

/** Lead 通过 FoliaSettingsStore 的 `backgroundTheme.config` 写入的整份配置。 */
internal data class BackgroundThemeConfig(
    val enabled: Boolean = false,
    val cloudEnabled: Boolean = true,
    val cloudBaseUrl: String = "",
    val system: String = "",
    val promptTemplate: String = "",
    val policy: String = "",
    val daylight: Boolean = false,
)

/** 纯规则：证据词、模板注入、缓存 identity、叠层 sanitize 与 payload 形状；不碰 Android、网络和设置。 */
internal object BackgroundThemeRules {

    const val CONFIG_KEY = "backgroundTheme.config"

    /** 模型输出上限与 aiStage 的 stage 请求一致。 */
    const val MAX_TOKENS = 8192

    /** 云端一次最多拉几条候选的 entry，与 src/services/aiCloudCache.ts 一致。 */
    const val MAX_ENTRY_FETCHES = 4

    /** 叠层 wordColors / lyricsIcons 的硬上限：模型输出再多也只留这么多。 */
    const val MAX_WORD_COLORS = 128
    const val MAX_LYRICS_ICONS = 12

    val DEFAULT_SYSTEM: String = """
        你是 Folia 的舞台主题设计器。只返回一个 JSON 对象，不要 Markdown 代码围栏。
        JSON 顶层是 stage：theme.light 与 theme.dark 都必须是对象，各自含 backgroundColor、primaryColor、accentColor、secondaryColor（字符串色值）、fontStyle、animationIntensity；可选 wordColors 数组（word、color）。
    """.trimIndent()

    val DEFAULT_PROMPT_TEMPLATE: String = """
        歌名：{{FOLIA_TITLE}}
        歌手：{{FOLIA_ARTIST}}

        歌词：
        {{FOLIA_LYRICS}}

        请根据歌词生成一套适合这首歌的舞台主题（stage），只返回 JSON。
    """.trimIndent()

    private val CLOUD_KEY = Regex("^[a-f0-9]{32}$")
    private val PLACEHOLDER = Regex("""\{\{(FOLIA_LYRICS|FOLIA_TITLE|FOLIA_ARTIST)\}\}""")
    private val WHITESPACE = Regex("""\s+""")
    private val OPTIONAL_COLOR_KEYS = listOf("accentColor", "secondaryColor")
    private val HEX_COLOR = Regex("^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
    private val ICON_NAME = Regex("^[A-Za-z][A-Za-z0-9]{0,39}$")
    private val FONT_STYLES = setOf("sans", "serif", "mono")
    private val ANIMATIONS = setOf("calm", "normal", "chaotic")

    /** 与 src/services/themeSanitizer.ts 的 FALLBACK_* 同一套兜底色。 */
    private val FALLBACK_LIGHT = arrayOf("#ffffff", "#111827", "#2563eb", "#475569")
    private val FALLBACK_DARK = arrayOf("#0f172a", "#f8fafc", "#7dd3fc", "#cbd5e1")

    /** `backgroundTheme.config` 可能是 JSON 字符串，也可能已经是 JSONObject。 */
    fun parseConfig(raw: Any?): BackgroundThemeConfig {
        val json = when (raw) {
            is JSONObject -> raw
            is String -> if (raw.isBlank()) {
                null
            } else {
                try {
                    JSONObject(raw)
                } catch (error: Exception) {
                    null
                }
            }
            else -> null
        } ?: return BackgroundThemeConfig()

        return BackgroundThemeConfig(
            enabled = json.optBoolean("enabled", false),
            cloudEnabled = json.optBoolean("cloudEnabled", true),
            cloudBaseUrl = json.optString("cloudBaseUrl", "").trim(),
            system = json.optString("system", ""),
            promptTemplate = json.optString("promptTemplate", ""),
            policy = json.optString("policy", ""),
            daylight = json.optBoolean("daylight", false),
        )
    }

    /**
     * 结果配置指纹：云端开关 / 端点 / system / prompt。
     *
     * 同一首歌、同一 policy、同一份歌词，只要这些配置变了就是另一份答案；
     * `daylight` 故意不进来——切明暗只影响叠层取哪一侧，不该重烧 AI。
     */
    fun configFingerprint(config: BackgroundThemeConfig): String = lyricHash(
        listOf(
            config.cloudEnabled.toString(),
            config.cloudBaseUrl,
            config.system,
            config.promptTemplate,
        ).joinToString("\u0000"),
    )

    /** 去空白、转小写；证据词与歌词用同一套规范化。 */
    fun flatten(value: String): String = value.replace(WHITESPACE, "").lowercase(Locale.ROOT)

    /**
     * 能当证据用的高亮词：单字不算，代词 / 助词 / 连词 / 介词等任何歌里都有的虚词也不算。
     *
     * 这张表和 src/services/aiCloudCache.ts 的 NON_EVIDENCE_WORDS 同一份，改动要两边同步。
     */
    fun evidenceWords(words: List<String>): List<String> = words
        .map { flatten(it) }
        .filter { it.length >= 2 && !NON_EVIDENCE_WORDS.contains(it) }

    /** 证据词必须在本曲歌词里 100% 全在场；空词表 / 全是虚词不算有凭据。 */
    fun highlightWordsPresent(words: List<String>, lyricText: String): Boolean {
        val evidence = evidenceWords(words)
        val haystack = flatten(lyricText)
        if (evidence.isEmpty() || haystack.isEmpty()) return false
        return evidence.all { haystack.contains(it) }
    }

    /**
     * 模板注入：只扫模板本身，注入进去的值不会再被当成占位符。
     *
     * 否则歌词里出现 `{{FOLIA_TITLE}}` 就会被替换成歌名，等于把歌词改了。
     */
    fun injectTemplate(template: String, title: String, artist: String, lyrics: String): String {
        val source = template.ifBlank { DEFAULT_PROMPT_TEMPLATE }
        return PLACEHOLDER.replace(source) { match ->
            when (match.groupValues[1]) {
                "FOLIA_LYRICS" -> lyrics
                "FOLIA_TITLE" -> title
                "FOLIA_ARTIST" -> artist
                else -> match.value
            }
        }
    }

    /** 内存 identity：歌 + policy + 歌词指纹 + 配置指纹；任一变化都是另一份答案。 */
    fun resultKey(songKey: String, policy: String, lyricHash: String = "", configFingerprint: String = ""): String =
        "$songKey\n$policy\n$lyricHash\n$configFingerprint"

    /**
     * 压平空白后取 SHA-256 前 16 位十六进制。
     *
     * 歌词与 AI 配置指纹共用：同一首歌换一版歌词（换源 / 翻译 / 逐字轴变化）必须
     * 命中不同结果，否则旧歌词的主题会被当成新歌词的答案读出去。
     */
    fun lyricHash(lyricText: String): String {
        val normalized = lyricText.replace(WHITESPACE, " ").trim()
        if (normalized.isEmpty()) return ""
        val bytes = MessageDigest.getInstance("SHA-256").digest(normalized.toByteArray(Charsets.UTF_8))
        return bytes.take(8).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }

    /** `#rgb` / `#rrggbb` 归一成小写 `#rrggbb`；rgb()、命名色、注入串一律 null。 */
    fun normalizeHexColor(value: Any?): String? {
        if (value !is String) return null
        val trimmed = value.trim()
        if (!HEX_COLOR.matches(trimmed)) return null
        val hex = trimmed.substring(1).lowercase(Locale.ROOT)
        return if (hex.length == 3) "#" + hex.map { "$it$it" }.joinToString("") else "#$hex"
    }

    /**
     * 叠层只认一份单主题（WallpaperThemePalette 存的是 App 当前主题的序列化）。
     *
     * 只白名单叠层真正会用的字段：四个十六进制颜色、fontStyle、animationIntensity、
     * wordColors（≤128）与 lyricsIcons（≤12）。其余键全部丢掉 —— 模型输出是外部数据，
     * 不能原样塞进叠层的样式值里。颜色写坏 / 字段缺失时按 daylight 取内置兜底色。
     *
     * @return 可直接交给 `WallpaperThemePalette.save` 的主题 JSON；payload 完全不可用时 null。
     */
    fun sanitizeForOverlay(payload: JSONObject?, daylight: Boolean = false): JSONObject? {
        val stage = payload?.optJSONObject("theme") ?: payload ?: return null
        val source = stage.optJSONObject(if (daylight) "light" else "dark")
            ?: stage.optJSONObject(if (daylight) "dark" else "light")
            ?: stage
        val fallback = if (daylight) FALLBACK_LIGHT else FALLBACK_DARK
        val accent = normalizeHexColor(source.opt("accentColor")) ?: fallback[2]

        val words = JSONArray()
        val rawWords = source.optJSONArray("wordColors")
        if (rawWords != null) {
            for (index in 0 until rawWords.length()) {
                if (words.length() >= MAX_WORD_COLORS) break
                val item = rawWords.optJSONObject(index) ?: continue
                val word = item.optString("word", "").trim()
                if (word.isEmpty()) continue
                words.put(JSONObject().put("word", word).put("color", normalizeHexColor(item.opt("color")) ?: accent))
            }
        }

        val icons = JSONArray()
        val seen = HashSet<String>()
        val rawIcons = source.optJSONArray("lyricsIcons")
        if (rawIcons != null) {
            for (index in 0 until rawIcons.length()) {
                if (icons.length() >= MAX_LYRICS_ICONS) break
                val icon = rawIcons.opt(index)
                if (icon !is String) continue
                val name = icon.trim()
                if (ICON_NAME.matches(name) && seen.add(name.lowercase(Locale.ROOT))) icons.put(name)
            }
        }

        return JSONObject()
            .put("backgroundColor", normalizeHexColor(source.opt("backgroundColor")) ?: fallback[0])
            .put("primaryColor", normalizeHexColor(source.opt("primaryColor")) ?: fallback[1])
            .put("accentColor", accent)
            .put("secondaryColor", normalizeHexColor(source.opt("secondaryColor")) ?: fallback[3])
            .put("fontStyle", source.optString("fontStyle").takeIf { it in FONT_STYLES } ?: "sans")
            .put("animationIntensity", source.optString("animationIntensity").takeIf { it in ANIMATIONS } ?: "normal")
            .put("wordColors", words)
            .put("lyricsIcons", icons)
    }

    /** 候选证据和条目下载不是原子操作，取回的实际主题也必须再验一次词证据。 */
    fun payloadMatchesLyrics(payload: JSONObject, lyricText: String): Boolean {
        if (lyricText.isBlank()) return true
        val theme = payload.optJSONObject("theme") ?: payload
        val words = ArrayList<String>()
        for (side in listOf("light", "dark")) {
            val list = theme.optJSONObject(side)?.optJSONArray("wordColors") ?: continue
            for (i in 0 until list.length()) list.optJSONObject(i)?.optString("word", "")?.let { words.add(it) }
        }
        return words.isEmpty() || highlightWordsPresent(words, lyricText)
    }

    /** `/api/ai-cache/resolve`：真实契约是 POST JSON，不是 GET query。 */
    fun resolveCandidatesUrl(baseUrl: String): String? = apiUrl(baseUrl, "ai-cache/resolve")

    /** `/api/ai-cache/stage/<key>`：按候选键取一条 entry。 */
    fun entryUrl(baseUrl: String, key: String): String? {
        if (!CLOUD_KEY.matches(key)) return null
        return apiUrl(baseUrl, "ai-cache/stage/$key")
    }

    private fun apiUrl(baseUrl: String, path: String): String? {
        val base = baseUrl.trim().trimEnd('/')
        if (base.isEmpty()) return null
        if (!base.startsWith("https://") && !base.startsWith("http://")) return null
        if (base.contains('?') || base.contains('#')) return null
        return "$base/api/$path"
    }

    /** 服务端按歌名返回的候选；键必须是 32 位小写十六进制，其余一律丢掉。 */
    fun parseCandidates(root: JSONObject?): List<CloudCandidate> {
        val list = root?.optJSONArray("candidates") ?: return emptyList()
        val out = ArrayList<CloudCandidate>(list.length())
        for (index in 0 until list.length()) {
            val entry = list.optJSONObject(index) ?: continue
            val key = entry.optString("key", "").trim().lowercase(Locale.ROOT)
            if (!CLOUD_KEY.matches(key)) continue

            val words = ArrayList<String>()
            val rawWords = entry.optJSONArray("words")
            if (rawWords != null) {
                for (wordIndex in 0 until rawWords.length()) {
                    val word = rawWords.opt(wordIndex)
                    if (word is String && word.trim().isNotEmpty()) words.add(word.trim())
                }
            }
            out.add(CloudCandidate(key, words))
        }
        return out
    }

    /** 只做「形状与基本色值类型」校验；具体 sanitize 见 [sanitizeForOverlay]。 */
    fun isStagePayload(payload: JSONObject?): Boolean {
        if (payload == null) return false
        val theme = payload.optJSONObject("theme") ?: payload
        val light = theme.optJSONObject("light") ?: return false
        val dark = theme.optJSONObject("dark") ?: return false
        return isThemeShaped(light) && isThemeShaped(dark)
    }

    /**
     * 统一成 stage 形状：老条目 / 主题条目可能整份就是 DualTheme（light/dark 在顶层），
     * 这里给它套一层 `theme`，JS 只按 stage 读。
     */
    fun asStagePayload(payload: JSONObject?): JSONObject? {
        val value = payload ?: return null
        if (!isStagePayload(value)) return null
        return if (value.optJSONObject("theme") != null) value else JSONObject().put("theme", value)
    }

    private fun isThemeShaped(theme: JSONObject): Boolean {
        val background = theme.opt("backgroundColor")
        val primary = theme.opt("primaryColor")
        if (background !is String || background.isBlank()) return false
        if (primary !is String || primary.isBlank()) return false

        for (key in OPTIONAL_COLOR_KEYS) {
            val value = theme.opt(key)
            if (value != null && value != JSONObject.NULL && value !is String) return false
        }

        val wordColors = theme.opt("wordColors")
        if (wordColors != null && wordColors != JSONObject.NULL) {
            if (wordColors !is JSONArray) return false
            for (index in 0 until wordColors.length()) {
                val item = wordColors.optJSONObject(index) ?: return false
                val word = item.opt("word")
                val color = item.opt("color")
                if (word !is String || color !is String) return false
            }
        }
        return true
    }

    /** 模型偶尔包一层 Markdown；取第一个 `{` 到最后一个 `}`。 */
    fun extractJson(text: String): String? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        val start = trimmed.indexOf('{')
        val end = trimmed.lastIndexOf('}')
        if (start < 0 || end <= start) return null
        return trimmed.substring(start, end + 1)
    }

    fun parseStagePayload(text: String): JSONObject? {
        val json = extractJson(text) ?: return null
        val payload = try {
            JSONObject(json)
        } catch (error: Exception) {
            null
        }
        return asStagePayload(payload)
    }

    private val NON_EVIDENCE_WORDS = setOf(
        // 代词与指称
        "我", "我们", "咱", "咱们", "你", "你们", "他", "他们", "她", "她们", "它", "它们",
        "自己", "大家", "这", "这个", "这些", "那", "那个", "那些", "谁", "什么", "怎么",
        "怎样", "怎么样", "这么", "那么", "多少", "哪里", "哪儿", "这里", "那里",
        // 助词 / 语气
        "的", "地", "得", "了", "着", "过", "吗", "呢", "吧", "啊", "呀", "哦", "啦",
        // 系词 / 助动词 / 否定
        "是", "在", "有", "没", "没有", "不", "别", "无", "要", "会", "能", "可以", "应该",
        "需要", "就是", "还是", "也是", "都是",
        // 连词 / 介词
        "和", "与", "跟", "或", "而", "且", "但", "但是", "却", "因为", "所以", "然后",
        "而且", "如果", "虽然", "于是", "把", "被", "给", "让", "使", "对", "从", "向",
        "往", "到", "于", "为", "用",
        // 程度 / 频率 / 范围
        "也", "都", "就", "又", "再", "还", "很", "太", "更", "最", "才", "只", "一直",
        "总是", "一个", "一样", "一些", "所有", "一切", "时候", "现在", "已经", "知道",
        "觉得", "感觉", "一起",
        // 英文里同样没有区分度的那些
        "the", "and", "of", "to", "in", "on", "at", "as", "an", "be", "by", "if", "or",
        "is", "it", "we", "me", "my", "up", "so", "no", "do", "am", "are", "was", "you",
        "your", "this", "that", "what", "when", "not",
    )
}
