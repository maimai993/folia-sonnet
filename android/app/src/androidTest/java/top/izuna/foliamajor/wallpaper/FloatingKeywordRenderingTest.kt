package top.izuna.foliamajor.wallpaper

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// 直接执行实际精简 Canvas 的 paintRow，比较关键词像素，不把“主题表已有JSON”当成绘制通过。
@RunWith(AndroidJUnit4::class)
class FloatingKeywordRenderingTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val theme = """{"wordColors":[{"word":"星光","color":"#ff00ff"}]}"""

    private fun render(words: Array<WallpaperLyricsState.TimedWord>?, position: Long = 10000L,
                       themeJson: String = theme, lineText: String = "星光照亮", alpha: Float = 1f): Bitmap {
        val owner = FloatingLyricsOverlay.shared(context)
        val type = Class.forName("top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay\$LyricsFloatView")
        val constructor = type.declaredConstructors.single().apply { isAccessible = true }
        val view = constructor.newInstance(owner, context)
        fun field(name: String, value: Any) {
            type.getDeclaredField(name).apply { isAccessible = true }.set(view, value)
        }
        field("wordRules", FloatingWordColors.parse(themeJson))
        field("accentColor", Color.GREEN)
        val line = WallpaperLyricsState.TimedLine(lineText, 0, 10000, null, words)
        val bitmap = Bitmap.createBitmap(600, 180, Bitmap.Config.ARGB_8888)
        val method = type.declaredMethods.single { it.name == "drawRow" }.apply { isAccessible = true }
        method.invoke(view, Canvas(bitmap), line.text, 600, 80f, 60f, Color.WHITE, alpha, position / 10000f,
            line, position, false, false)
        return bitmap
    }

    private fun keywordPixels(bitmap: Bitmap): Int {
        var count = 0
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val color = bitmap.getPixel(x, y)
            if (Color.alpha(color) > 120 && Color.red(color) > 180 && Color.blue(color) > 180 && Color.green(color) < 80) count++
        }
        bitmap.recycle()
        return count
    }

    @Test
    fun lineWithoutWordAxisStillDrawsAiKeywordColor() {
        assertTrue("纯LRC/后台恢复无words时，精简小窗仍须绘制AI关键词品红而非全用通用绿色", keywordPixels(render(null)) > 20)
    }

    @Test
    fun broadTimedWordDoesNotLoseKeywordInsideVocabSegment() {
        val words = arrayOf(WallpaperLyricsState.TimedWord("星光照亮", 0, 10000))
        assertTrue("整句单token不能因ICU片段中点落在关键词外而丢色", keywordPixels(render(words)) > 20)
    }

    @Test
    fun noWordAxisRespectsSungClipAndDoesNotColorUnmarkedText() {
        org.junit.Assert.assertEquals(0, keywordPixels(render(null, 0)))
        org.junit.Assert.assertEquals(0, keywordPixels(render(null, themeJson = "{}")))
        org.junit.Assert.assertEquals(0, keywordPixels(render(null, lineText = "月色照亮")))
        assertTrue("唱过部分保留关键词色", keywordPixels(render(null, 6000)) > 20)
    }

    @Test
    fun keywordOverlayKeepsRowFadeAlpha() {
        val bitmap = render(null, alpha = 0.1f)
        var maxAlpha = 0
        var hits = 0
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val color = bitmap.getPixel(x, y)
            // 透明位图多层叠加后RGB会混色，直接检查所有实绘像素的alpha，不能按不透明品红筛。
            if (Color.alpha(color) > 0) {
                hits++
                maxAlpha = maxOf(maxAlpha, Color.alpha(color))
            }
        }
        bitmap.recycle()
        assertTrue("关键词确实被画出", hits > 20)
        assertTrue("关键词不得因Paint.color覆盖而忽略行淡入alpha", maxAlpha < 100)
    }

    @Test
    fun restoredTimelineWithoutWordsKeepsKeywordDrawing() {
        WallpaperLyricsState.clear(context)
        val words = arrayOf(WallpaperLyricsState.TimedWord("星光", 0, 5000), WallpaperLyricsState.TimedWord("照亮", 5000, 10000))
        WallpaperLyricsState.publish(context, "keyword-restore", "fixture", null, Color.GREEN,
            Color.BLACK, 1f, "color", null, "minimal", 0f, true, true, 10000,
            arrayOf(WallpaperLyricsState.TimedLine("星光照亮", 0, 10000, null, words)), null, 6000, false)
        WallpaperLyricsState.clear(null)
        WallpaperLyricsState.restore(context)
        val restored = WallpaperLyricsState.get().lines[0]
        org.junit.Assert.assertNull("当前持久化契约不会保存words，这是实际后台恢复路径", restored.words)
        assertTrue(keywordPixels(render(restored.words, 6000, lineText = restored.text)) > 20)
    }

    @Test
    fun actualNativeWindowShowsKeywordWithoutWordAxis() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val overlay = FloatingLyricsOverlay.shared(context)
        WallpaperLyricsState.clear(context)
        WallpaperLyricsState.publish(context, "keyword-window", "fixture", null, Color.GREEN,
            Color.parseColor("#102030"), 1f, "color", null, "minimal", 0f, true, true, 180000,
            arrayOf(WallpaperLyricsState.TimedLine("星光照亮静静的夜晚", 0, 180000)),
            mapOf("wp.overlayEnabled" to 1f, "wp.overlayAllApps" to 1f,
                "wp.floatingWidth" to 0.95f, "wp.floatingBackgroundOpacity" to 1f), 120000, false)
        WallpaperThemePalette.save(context, "#ffffff", "#aaaaaa", theme)
        try {
            instrumentation.runOnMainSync { overlay.setPreview(true); overlay.start(); overlay.invalidateOverlay() }
            instrumentation.waitForIdleSync()
            Thread.sleep(1200) // 实际窗口入场动画落定后取系统合成截图，不是只读字段。
            val screenshot = instrumentation.uiAutomation.takeScreenshot()
            val file = java.io.File(context.getExternalFilesDir(null), "issue249-native-window.png")
            java.io.FileOutputStream(file).use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
            assertTrue("系统合成截图中应有无词轴AI关键词色", keywordPixels(screenshot) > 20)
        } finally {
            instrumentation.runOnMainSync { overlay.setPreview(false); overlay.stop() }
        }
    }

    @Test
    fun perCharacterWordAxisDrawsAiKeywordColor() {
        val words = "星光照亮".mapIndexed { index, char ->
            WallpaperLyricsState.TimedWord(char.toString(), index * 2500L, (index + 1) * 2500L)
        }.toTypedArray()
        assertTrue("逐字词轴对照必须真的有AI颜色", keywordPixels(render(words)) > 20)
    }
}
