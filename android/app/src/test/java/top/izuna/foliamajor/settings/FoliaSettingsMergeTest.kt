package top.izuna.foliamajor.settings

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// android/app/src/test/java/top/izuna/foliamajor/settings/FoliaSettingsMergeTest.kt
// 设置合并的语义。**只测纯逻辑**，不测 SharedPreferences（JVM 单测里没有 Android 运行时）：
// 真正容易出错的是「老版本存的 blob 缺新项」这一类合并问题，而不是落盘本身。

class FoliaSettingsMergeTest {

    /** 与 FoliaSettingsStore.merge 同一份实现，抽出来是为了能不起 Android 就测。 */
    private fun merge(base: JSONObject, override: JSONObject): JSONObject {
        val result = JSONObject(base.toString())
        override.keys().forEach { key -> result.put(key, override.opt(key)) }
        return result
    }

    private val defaults = JSONObject(
        """{"loopMode":"off","shuffle":false,"themeAutoFollow":true,"autoLandscapeForVisualizer":false}"""
    )

    @Test
    fun `老版本存的设置缺新项时用默认值补上`() {
        // 用户上一版存的是 {"loopMode":"all"}，这一版新加了 themeAutoFollow。
        val stored = JSONObject("""{"loopMode":"all"}""")
        val merged = merge(defaults, stored)
        assertEquals("all", merged.getString("loopMode"))
        assertTrue("新项要落到默认值", merged.getBoolean("themeAutoFollow"))
        assertTrue("开关类默认关", !merged.getBoolean("autoLandscapeForVisualizer"))
    }

    @Test
    fun `存的值优先于默认值`() {
        val merged = merge(defaults, JSONObject("""{"loopMode":"one","shuffle":true}"""))
        assertEquals("one", merged.getString("loopMode"))
        assertEquals(true, merged.getBoolean("shuffle"))
    }

    @Test
    fun `合并不会改动传入的默认值对象`() {
        // defaults 是单例，被改坏会影响之后每一次读取。
        merge(defaults, JSONObject("""{"loopMode":"one"}"""))
        assertEquals("off", defaults.getString("loopMode"))
    }

    @Test
    fun `空存储等于全默认`() {
        val merged = merge(defaults, JSONObject())
        assertEquals("off", merged.getString("loopMode"))
        assertEquals(false, merged.getBoolean("shuffle"))
    }
}
