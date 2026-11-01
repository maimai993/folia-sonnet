package top.izuna.foliamajor.ai

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// test/unit/android/BackgroundThemeWorkerTest.kt
// 后台主题 worker 的纯规则回归：证据词、模板注入、缓存 identity、叠层 sanitize 与 payload 形状。
// 只跑 JVM 纯函数，不发网络请求、不读设置、不碰播放器。
class BackgroundThemeWorkerTest {

    @Test
    fun `证据词去掉单字与虚词并压平空白大小写`() {
        val words = listOf(" 留住 ", "我", "什么", "把", "你", "LoVe", "a", "小黄花")
        assertEquals(listOf("留住", "love", "小黄花"), BackgroundThemeRules.evidenceWords(words))

        assertTrue(BackgroundThemeRules.highlightWordsPresent(listOf("留住", "我"), "我 留 住"))
        assertFalse(BackgroundThemeRules.highlightWordsPresent(listOf("留住", "小黄花"), "留住"))
        assertFalse(BackgroundThemeRules.highlightWordsPresent(listOf("我", "你"), "我你"))
    }

    @Test
    fun `模板只替换三个占位符且不递归替换注入值`() {
        val prompt = BackgroundThemeRules.injectTemplate(
            "T={{FOLIA_TITLE}}|A={{FOLIA_ARTIST}}|L={{FOLIA_LYRICS}}|X={{OTHER}}",
            "{{FOLIA_ARTIST}}",
            "歌手",
            "第一行\n第二行",
        )

        assertTrue(prompt.contains("T={{FOLIA_ARTIST}}"))
        assertTrue(prompt.contains("A=歌手"))
        assertTrue(prompt.contains("L=第一行\n第二行"))
        assertTrue(prompt.contains("X={{OTHER}}"))
        assertFalse(prompt.contains("{{FOLIA_TITLE}}"))
    }

    @Test
    fun `配置读取 daylight 且缺省关闭`() {
        assertFalse(BackgroundThemeRules.parseConfig(null).enabled)
        assertFalse(BackgroundThemeRules.parseConfig(null).daylight)

        val config = BackgroundThemeRules.parseConfig(
            """{"enabled":true,"cloudEnabled":false,"cloudBaseUrl":"https://example.test","system":"s","promptTemplate":"p","policy":"x","daylight":true}""",
        )
        assertTrue(config.enabled)
        assertFalse(config.cloudEnabled)
        assertTrue(config.daylight)
        assertEquals("https://example.test", config.cloudBaseUrl)
        assertEquals("x", config.policy)
    }

    @Test
    fun `结果 identity 隔离云端配置但不隔离 daylight`() {
        val base = BackgroundThemeConfig(
            enabled = true,
            cloudBaseUrl = "https://a.test",
            system = "s",
            promptTemplate = "p",
        )
        val fingerprint = BackgroundThemeRules.configFingerprint(base)

        assertNotEquals(fingerprint, BackgroundThemeRules.configFingerprint(base.copy(cloudBaseUrl = "https://b.test")))
        assertNotEquals(fingerprint, BackgroundThemeRules.configFingerprint(base.copy(system = "s2")))
        assertNotEquals(fingerprint, BackgroundThemeRules.configFingerprint(base.copy(promptTemplate = "p2")))
        assertNotEquals(fingerprint, BackgroundThemeRules.configFingerprint(base.copy(cloudEnabled = false)))
        assertEquals(fingerprint, BackgroundThemeRules.configFingerprint(base.copy(daylight = true)))

        assertNotEquals(
            BackgroundThemeRules.resultKey("song:1", "p", "hash", fingerprint),
            BackgroundThemeRules.resultKey(
                "song:1", "p", "hash",
                BackgroundThemeRules.configFingerprint(base.copy(system = "s2")),
            ),
        )
        assertEquals(
            BackgroundThemeRules.resultKey("song:1", "p", "hash", fingerprint),
            BackgroundThemeRules.resultKey(
                "song:1", "p", "hash",
                BackgroundThemeRules.configFingerprint(base.copy(daylight = true)),
            ),
        )
    }

    @Test
    fun `缓存 identity 同时区分歌曲 policy 与歌词`() {
        assertEquals(
            BackgroundThemeRules.resultKey("song:1", "p"),
            BackgroundThemeRules.resultKey("song:1", "p"),
        )
        assertNotEquals(
            BackgroundThemeRules.resultKey("song:1", "p"),
            BackgroundThemeRules.resultKey("song:1", "p2"),
        )
        assertNotEquals(
            BackgroundThemeRules.resultKey("song:1", "p"),
            BackgroundThemeRules.resultKey("song:2", "p"),
        )
        assertNotEquals(
            BackgroundThemeRules.resultKey("song:1", "p", "aaa"),
            BackgroundThemeRules.resultKey("song:1", "p", "bbb"),
        )
    }

    @Test
    fun `歌词指纹压平空白且同歌不同歌词不同结果`() {
        val hash = BackgroundThemeRules.lyricHash("第一行\n第二行  第三行")
        assertEquals(hash, BackgroundThemeRules.lyricHash("第一行 第二行 第三行"))
        assertNotEquals(hash, BackgroundThemeRules.lyricHash("第一行 第二行 第四行"))
        assertEquals("", BackgroundThemeRules.lyricHash(" \n "))
        assertEquals(16, hash.length)

        assertNotEquals(
            BackgroundThemeRules.resultKey("song:1", "p", hash),
            BackgroundThemeRules.resultKey("song:1", "p", BackgroundThemeRules.lyricHash("别的歌词")),
        )
    }

    @Test
    fun `候选只收合法键并保留字符串证据词`() {
        val root = JSONObject(
            """{"candidates":[
                {"key":"0123456789abcdef0123456789ABCDEF","words":[" 留住 "," ",3,"我"]},
                {"key":"not-a-key","words":["x"]},
                {"key":"ffffffffffffffffffffffffffffffff","words":[]}
            ]}""",
        )

        val candidates = BackgroundThemeRules.parseCandidates(root)
        assertEquals(2, candidates.size)
        assertEquals("0123456789abcdef0123456789abcdef", candidates[0].key)
        assertEquals(listOf("留住", "我"), candidates[0].words)
        assertEquals(emptyList<String>(), candidates[1].words)
    }

    @Test
    fun `stage payload 要求 light dark 对象和基本色值类型`() {
        val nested = JSONObject(
            """{"theme":{"light":{"backgroundColor":"#fff","primaryColor":"#000"},"dark":{"backgroundColor":"#000","primaryColor":"#fff"}}}""",
        )
        assertTrue(BackgroundThemeRules.isStagePayload(nested))

        val direct = JSONObject(
            """{"light":{"backgroundColor":"#fff","primaryColor":"#000"},"dark":{"backgroundColor":"#000","primaryColor":"#fff"}}""",
        )
        assertTrue(BackgroundThemeRules.isStagePayload(direct))
        assertTrue(BackgroundThemeRules.asStagePayload(direct)?.optJSONObject("theme") != null)

        val missingDark = JSONObject(
            """{"light":{"backgroundColor":"#fff","primaryColor":"#000"}}""",
        )
        assertFalse(BackgroundThemeRules.isStagePayload(missingDark))

        val badColor = JSONObject(
            """{"light":{"backgroundColor":1,"primaryColor":"#000"},"dark":{"backgroundColor":"#000","primaryColor":"#fff"}}""",
        )
        assertFalse(BackgroundThemeRules.isStagePayload(badColor))

        val badWordColor = JSONObject(
            """{"light":{"backgroundColor":"#fff","primaryColor":"#000","wordColors":[{"word":"x","color":2}]},"dark":{"backgroundColor":"#000","primaryColor":"#fff"}}""",
        )
        assertFalse(BackgroundThemeRules.isStagePayload(badWordColor))
    }

    @Test
    fun `模型输出可以从 Markdown 围栏里取出 stage JSON`() {
        val payload = BackgroundThemeRules.parseStagePayload(
            "```json\n" +
                """{"light":{"backgroundColor":"#fff","primaryColor":"#000"},"dark":{"backgroundColor":"#000","primaryColor":"#fff"}}""" +
                "\n```",
        )
        assertTrue(payload != null)
    }

    @Test
    fun `sanitizeForOverlay 只白名单字段并归一颜色`() {
        val payload = JSONObject(
            """{"theme":{
                "light":{"backgroundColor":"#ABC","primaryColor":"red","accentColor":"#123456","secondaryColor":"#789","fontStyle":"serif","animationIntensity":"chaotic","wordColors":[{"word":" 留住 ","color":"#ABC"},{"word":"","color":"#000"},{"word":"坏色","color":"rgb(0,0,0)"}],"lyricsIcons":["Sun","sun","bad icon","Heart"],"evil":"x"},
                "dark":{"backgroundColor":"#000","primaryColor":"#fff"}
            }}""",
        )

        val theme = BackgroundThemeRules.sanitizeForOverlay(payload, daylight = true)!!

        assertEquals("#aabbcc", theme.getString("backgroundColor"))
        assertEquals("#111827", theme.getString("primaryColor"))
        assertEquals("#123456", theme.getString("accentColor"))
        assertEquals("#778899", theme.getString("secondaryColor"))
        assertEquals("serif", theme.getString("fontStyle"))
        assertEquals("chaotic", theme.getString("animationIntensity"))
        assertFalse(theme.has("evil"))

        val words = theme.getJSONArray("wordColors")
        assertEquals(2, words.length())
        assertEquals("留住", words.getJSONObject(0).getString("word"))
        assertEquals("#aabbcc", words.getJSONObject(0).getString("color"))
        assertEquals("#123456", words.getJSONObject(1).getString("color"))

        val icons = theme.getJSONArray("lyricsIcons")
        assertEquals(2, icons.length())
        assertEquals("Sun", icons.getString(0))
        assertEquals("Heart", icons.getString(1))
    }

    @Test
    fun `sanitizeForOverlay 颜色不可用时回落并截断数组`() {
        val words = JSONArray()
        for (index in 0 until 200) {
            words.put(JSONObject().put("word", "w$index").put("color", "not-a-color"))
        }
        val icons = JSONArray()
        for (index in 0 until 20) {
            icons.put("Icon$index")
        }

        val payload = JSONObject()
            .put(
                "theme",
                JSONObject()
                    .put(
                        "light",
                        JSONObject()
                            .put("backgroundColor", "rgba(0,0,0,.5)")
                            .put("primaryColor", 1)
                            .put("wordColors", words)
                            .put("lyricsIcons", icons)
                            .put("fontStyle", "comic-sans")
                            .put("animationIntensity", "fast"),
                    )
                    .put("dark", JSONObject().put("backgroundColor", "#000").put("primaryColor", "#fff")),
            )

        val theme = BackgroundThemeRules.sanitizeForOverlay(payload, daylight = true)!!

        assertEquals("#ffffff", theme.getString("backgroundColor"))
        assertEquals("#111827", theme.getString("primaryColor"))
        assertEquals("#2563eb", theme.getString("accentColor"))
        assertEquals("#475569", theme.getString("secondaryColor"))
        assertEquals("sans", theme.getString("fontStyle"))
        assertEquals("normal", theme.getString("animationIntensity"))
        assertEquals(128, theme.getJSONArray("wordColors").length())
        assertEquals("#2563eb", theme.getJSONArray("wordColors").getJSONObject(0).getString("color"))
        assertEquals(12, theme.getJSONArray("lyricsIcons").length())

        assertNull(BackgroundThemeRules.sanitizeForOverlay(null))
    }

    @Test
    fun `sanitizeForOverlay 按 daylight 取对应一侧并接受单主题`() {
        val payload = JSONObject(
            """{"theme":{
                "light":{"backgroundColor":"#fff","primaryColor":"#111"},
                "dark":{"backgroundColor":"#000","primaryColor":"#eee"}
            }}""",
        )

        assertEquals(
            "#ffffff",
            BackgroundThemeRules.sanitizeForOverlay(payload, daylight = true)?.getString("backgroundColor"),
        )
        assertEquals(
            "#000000",
            BackgroundThemeRules.sanitizeForOverlay(payload, daylight = false)?.getString("backgroundColor"),
        )

        val single = JSONObject("""{"backgroundColor":"#000","primaryColor":"#fff","fontStyle":"mono"}""")
        val theme = BackgroundThemeRules.sanitizeForOverlay(single)
        assertEquals("#000000", theme?.getString("backgroundColor"))
        assertEquals("mono", theme?.getString("fontStyle"))
    }

    @Test
    fun `payload 复验词证据且颜色不可注入`() {
        val payload = JSONObject(
            """{"theme":{
                "light":{"backgroundColor":"#fff","primaryColor":"#111","wordColors":[{"word":"留住","color":"#ABC"}]},
                "dark":{"backgroundColor":"#000","primaryColor":"#eee","wordColors":[{"word":"留住","color":"#ABC"}]}
            }}""",
        )

        assertTrue(BackgroundThemeRules.payloadMatchesLyrics(payload, "我 留 住"))
        assertFalse(BackgroundThemeRules.payloadMatchesLyrics(payload, "完全不同的歌词"))
        assertTrue(BackgroundThemeRules.payloadMatchesLyrics(payload, " "))

        assertNull(BackgroundThemeRules.normalizeHexColor("rgb(0,0,0)"))
        assertNull(BackgroundThemeRules.normalizeHexColor("red;background:url(javascript:alert(1))"))
        assertNull(BackgroundThemeRules.normalizeHexColor("#12"))
        assertEquals("#aabbcc", BackgroundThemeRules.normalizeHexColor("#ABC"))

        val theme = BackgroundThemeRules.sanitizeForOverlay(payload, daylight = true)!!
        assertEquals("#aabbcc", theme.getJSONArray("wordColors").getJSONObject(0).getString("color"))
        assertFalse(theme.has("javascript"))

        val injected = JSONObject(
            """{"theme":{
                "light":{"backgroundColor":"#fff","primaryColor":"#111","wordColors":[{"word":"留住","color":"url(javascript:alert(1))"}]},
                "dark":{"backgroundColor":"#000","primaryColor":"#eee"}
            }}""",
        )
        val sanitized = BackgroundThemeRules.sanitizeForOverlay(injected, daylight = true)!!
        assertEquals("#2563eb", sanitized.getJSONArray("wordColors").getJSONObject(0).getString("color"))
    }
}
