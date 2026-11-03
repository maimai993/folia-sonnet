package top.izuna.foliamajor.wallpaper

import android.content.Context
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

// 后台 AI 只写主题表时，两种桌面样式必须收到同一份底色和重绘信号，不改变播放锚点。
@RunWith(AndroidJUnit4::class)
class WallpaperThemeDeliveryTest {
    private lateinit var context: Context

    @Before
    fun reset() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        WallpaperLyricsState.clear(context)
        context.getSharedPreferences("folia_wallpaper_theme_palette", Context.MODE_PRIVATE).edit().clear().commit()
        WallpaperLyricsState.publish(
            context, "delivery-test", "synthetic", null,
            Color.parseColor("#112233"), Color.parseColor("#09090b"), 1f,
            "color", null, "minimal", 0f, true, true, 180000L,
            arrayOf(WallpaperLyricsState.TimedLine("星光照亮", 0L, 180000L)),
            null, 12000L, true,
        )
    }

    private fun theme(wordColor: String = "#ffcc00") = JSONObject()
        .put("backgroundColor", "#183e52")
        .put("accentColor", "#35d9ba")
        .put("primaryColor", "#f5ebd2")
        .put("secondaryColor", "#b4c7df")
        .put("wordColors", org.json.JSONArray().put(JSONObject().put("word", "星光").put("color", wordColor)))
        .toString()

    @Test
    fun backgroundThemeUpdatesBothSnapshotColorsWithoutMovingPlayback() {
        val before = WallpaperLyricsState.get()
        WallpaperThemePalette.save(context, "#f5ebd2", "#b4c7df", theme())
        val after = WallpaperLyricsState.get()
        assertEquals("两种样式读的快照底色必须同步", Color.parseColor("#183e52"), after.baseColor)
        assertEquals(Color.parseColor("#35d9ba"), after.accent)
        assertTrue("叠层签名和精简调色板需要一次重绘", after.stamp > before.stamp)
        assertEquals(before.anchorElapsedMs, after.anchorElapsedMs)
        assertEquals(before.anchorPositionMs, after.anchorPositionMs)
        assertEquals(before.playing, after.playing)
        assertSame(before.lines, after.lines)
        assertEquals(before.visualizerMode, after.visualizerMode)
        assertEquals(before.backgroundMode, after.backgroundMode)
    }

    @Test
    fun missingOrMalformedThemeColorsKeepSnapshotWithoutCrashing() {
        val before = WallpaperLyricsState.get()
        WallpaperThemePalette.save(context, "#f5ebd2", "#b4c7df", "{}")
        assertEquals(before.baseColor, WallpaperLyricsState.get().baseColor)
        assertEquals(before.accent, WallpaperLyricsState.get().accent)
        WallpaperThemePalette.save(context, "", "", "")
        assertEquals(before.baseColor, WallpaperLyricsState.get().baseColor)
        WallpaperThemePalette.save(context, null, null, "not-json")
        assertEquals(before.accent, WallpaperLyricsState.get().accent)
    }

    @Test
    fun paletteBeforeRestoreDoesNotDiscardPersistedTimeline() {
        val saved = WallpaperLyricsState.get()
        // 模拟进程冷启动：只清内存，保留落盘时间轴。
        WallpaperLyricsState.clear(null)
        WallpaperThemePalette.save(context, "#f5ebd2", "#b4c7df", theme())
        WallpaperLyricsState.restore(context)
        val restored = WallpaperLyricsState.get()
        assertEquals(saved.title, restored.title)
        assertEquals(saved.lines[0].text, restored.lines[0].text)
        assertEquals(saved.backgroundMode, restored.backgroundMode)
        assertEquals(Color.parseColor("#183e52"), restored.baseColor)
    }

    @Test
    fun keywordOnlyThemeChangeInvalidatesDeliveryButHeartbeatAndDuplicatesDoNot() {
        WallpaperThemePalette.save(context, "#f5ebd2", "#b4c7df", theme())
        val first = WallpaperLyricsState.get()
        WallpaperThemePalette.save(context, "#f5ebd2", "#b4c7df", theme("#ff00cc"))
        val changed = WallpaperLyricsState.get()
        assertTrue("颜色相同、只有 AI 标记变化也必须送到已挂载的两种样式", changed.stamp > first.stamp)
        WallpaperThemePalette.save(context, null, null, null)
        WallpaperThemePalette.save(context, "#f5ebd2", "#b4c7df", theme("#ff00cc"))
        assertEquals(changed.stamp, WallpaperLyricsState.get().stamp)
        assertTrue(WallpaperThemePalette.readThemeJson(context).contains("#ff00cc"))
    }
}
