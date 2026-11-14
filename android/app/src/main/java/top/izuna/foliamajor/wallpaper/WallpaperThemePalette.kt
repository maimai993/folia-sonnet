package top.izuna.foliamajor.wallpaper

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Color
import android.util.Log
import org.json.JSONObject

/**
 * 叠层要用的「文本主色 / 次色」与整份主题，由主 WebView 下发。
 *
 * 为什么单独放一张表，而不是塞进 WallpaperLyricsState 的 Snapshot：
 * Snapshot 那串构造参数已经有十几个、六个构造点全在用，为了几个字段去动它
 * 风险远大于收益。这里只存叠层需要、而 Snapshot 不带的东西；
 * 高亮色与底色仍然走原来的通路（publish 那一路已经在推）。
 *
 * 为什么必须单独存：叠层页面（wallpaperSurface）的主题是拿
 * `buildBuiltinDualTheme()` 打底、只覆盖高亮色和底色搭出来的 ——
 * 于是**主文本色永远等于内置主题的**，AI / 自定义主题里那套配色一个字都传不过去。
 * 表现就是「App 里换成了 AI 主题，桌面叠层的歌词还是老样子」。
 *
 * 后来又加了 themeJson（整份主题的 JSON）：只推四个颜色是不够的 ——
 * AI 主题真正有辨识度的那部分往往**不是颜色**，而是 `wordColors`（给指定的词上色）
 * 和 `lyricsIcons`（可视化里飘的那些图标）。按字段一个个加永远是补不全的，
 * 所以整份主题直接序列化推下来，叠层拿它打底。
 *
 * 这张表是**唯一**一条把「主题本体配色」送到原生的通路（高亮色与底色走 Snapshot），
 * 所以写入 / 读取两边都留一条变更日志：真机上出现「叠层 / 小窗只有高亮色、没有主题色」
 * 时，先要回答的就是这张表里到底有没有东西、是空在哪一项。
 */
class WallpaperThemePalette private constructor() {

    companion object {
        private const val PREFS = "folia_wallpaper_theme_palette"
        private const val KEY_PRIMARY = "primary"
        private const val KEY_SECONDARY = "secondary"
        private const val KEY_THEME_JSON = "theme_json"
        private const val TAG = "WallpaperThemePalette"

        /** 上一次记过的写入状态签名 / 上一次记过的读取状态掩码，只为日志去重（读是每帧都在读的）。 */
        private var lastWriteSignature: String? = null
        private var lastReadMask: String? = null

        /**
         * null = 这次没带，**保持原值**；空串 = 明确清除；非空 = 覆盖。
         *
         * 为什么要区分：`publish` 是心跳也在走的入口（播放暂停、跳变校正都只带
         * positionMs/playing），那些调用里主题字段全部缺席 —— 如果把缺席当成清除，
         * 换歌时刚存好的主题在下一个 500ms 心跳里就被抹掉了，
         * 叠层随即退回内置主题，表现正是「AI 主题在桌面叠层上没生效」。
         *
         * 另外：只带了整份主题、两个颜色传空串时，从主题 JSON 里把它们补出来，
         * 而不是照着空串把颜色删掉。理由是两个颜色与那份 JSON 讲的是同一套配色，
         * 调用方（后台 AI 主题落盘那一路）本来就可能只写 JSON；
         * 一旦按「空串 = 清除」执行，表里就留下「有 JSON、没有两个颜色」的半份状态 ——
         * 原生那边读到的主文本色 / 次色退回白灰，主题 JSON 里的 wordColors 却是新的，
         * 看上去就像「主题换了但颜色没换」。JSON 不可用（解析失败 / 里面没这两个键）时
         * 仍然照旧按空串清除，语义不变。
         */
        // 锁序：save → WallpaperLyricsState；read/readThemeJson 不取此锁，避免 publish 反向取锁。
        @JvmStatic
        @Synchronized
        fun save(context: Context?, primary: String?, secondary: String?, themeJson: String?) {
            if (context == null) return
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val previousPrimary = prefs.getString(KEY_PRIMARY, "") ?: ""
            val previousSecondary = prefs.getString(KEY_SECONDARY, "") ?: ""
            val previousThemeJson = prefs.getString(KEY_THEME_JSON, "") ?: ""
            val editor = prefs.edit()
            var changed = false
            var nextPrimary = primary
            var nextSecondary = secondary
            var backfilled = false
            if (!themeJson.isNullOrEmpty() && (nextPrimary.isNullOrEmpty() || nextSecondary.isNullOrEmpty())) {
                val fromTheme = colorsFromThemeJson(themeJson)
                if (nextPrimary.isNullOrEmpty() && fromTheme[0].isNotEmpty()) {
                    nextPrimary = fromTheme[0]
                    backfilled = true
                }
                if (nextSecondary.isNullOrEmpty() && fromTheme[1].isNotEmpty()) {
                    nextSecondary = fromTheme[1]
                    backfilled = true
                }
            }
            if (nextPrimary != null) {
                if (nextPrimary.isEmpty()) editor.remove(KEY_PRIMARY)
                else editor.putString(KEY_PRIMARY, nextPrimary)
                changed = true
            }
            if (nextSecondary != null) {
                if (nextSecondary.isEmpty()) editor.remove(KEY_SECONDARY)
                else editor.putString(KEY_SECONDARY, nextSecondary)
                changed = true
            }
            if (themeJson != null) {
                if (themeJson.isEmpty()) editor.remove(KEY_THEME_JSON)
                else editor.putString(KEY_THEME_JSON, themeJson)
                changed = true
            }
            // 三个字段都没带就别动盘：心跳一次都不落盘，省掉无谓的写放大。
            if (changed) {
                editor.apply()
                val nextThemeJson = prefs.getString(KEY_THEME_JSON, "") ?: ""
                val paletteChanged = previousPrimary != (prefs.getString(KEY_PRIMARY, "") ?: "")
                    || previousSecondary != (prefs.getString(KEY_SECONDARY, "") ?: "")
                    || previousThemeJson != nextThemeJson
                // 后台 AI 没有 Web 整包：主题表落定后也要更新快照底色并通知已挂载的两种样式。
                if (paletteChanged) {
                    val theme = try { JSONObject(nextThemeJson) } catch (_: Exception) { null }
                    fun color(field: String): Int? {
                        val value = theme?.optString(field, "")?.trim().orEmpty()
                        if (value.isEmpty()) return null
                        return try { Color.parseColor(value) } catch (_: IllegalArgumentException) { null }
                    }
                    WallpaperLyricsState.applyThemePalette(context, color("accentColor"), color("backgroundColor"))
                    // 暂停后 Canvas 不再排帧；主题变化也要主动敲一帧，而不是等下次播放。
                    FloatingLyricsOverlay.shared(context).invalidateOverlay()
                }
                logWrite(context, backfilled)
            }
        }

        /** 下标 0 = 主文本色，1 = 次色；没有就是空串。 */
        @JvmStatic
        fun read(context: Context?): Array<String> {
            val result = arrayOf("", "")
            if (context == null) return result
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            result[0] = prefs.getString(KEY_PRIMARY, "") ?: ""
            result[1] = prefs.getString(KEY_SECONDARY, "") ?: ""
            /*
             * 只在「有没有」的形态变化时记一条：读的这一侧是逐帧在跑的
             * （LyricsRenderer / 小窗 / 叠层整包都读它），逐次打会把日志刷满；
             * 而排查要的恰恰就是「读到的是不是空的」这一句。
             */
            val mask = (if (result[0].isEmpty()) "0" else "1") + (if (result[1].isEmpty()) "0" else "1")
            if (mask != lastReadMask) {
                lastReadMask = mask
                Log.i(TAG, "[Wallpaper] 颜色表读取 primary=" + describe(result[0]) +
                    " secondary=" + describe(result[1]) +
                    " themeJson=" + describe(readThemeJson(context)))
            }
            return result
        }

        /** App 当前整份主题的 JSON（含 wordColors / lyricsIcons 这类非颜色字段）。没有就是空串。 */
        @JvmStatic
        fun readThemeJson(context: Context?): String {
            if (context == null) return ""
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val value = prefs.getString(KEY_THEME_JSON, "")
            return value ?: ""
        }

        /**
         * 从整份主题里取两个文本色。
         *
         * 认的是 `primaryColor` / `secondaryColor` 这两个键名（与 `Theme` 一致），
         * 缺了就是空串 —— 调用方据此决定「补不出来就照旧按空串处理」。
         */
        private fun colorsFromThemeJson(themeJson: String): Array<String> {
            return try {
                val json = JSONObject(themeJson)
                arrayOf(
                    json.optString("primaryColor", ""),
                    json.optString("secondaryColor", ""),
                )
            } catch (error: Exception) {
                Log.w(TAG, "[Wallpaper] 主题 JSON 用不上，两个文本色按调用方给的值处理", error)
                arrayOf("", "")
            }
        }

        /**
         * 写完之后记一条「表里现在是什么」。
         *
         * 只在状态真的变了时记：`publish` 每一份整包都会走一次 save，
         * 同一条主题在播放期间会被反复写入（值一样），逐次打没有信息量。
         */
        private fun logWrite(context: Context, backfilled: Boolean) {
            val colors = read(context)
            val themeJson = readThemeJson(context)
            val signature = colors[0] + "|" + colors[1] + "|" + themeJson.length
            if (signature == lastWriteSignature) return
            lastWriteSignature = signature
            Log.i(TAG, "[Wallpaper] 颜色表写入 primary=" + describe(colors[0]) +
                " secondary=" + describe(colors[1]) +
                " themeJson=" + describe(themeJson) +
                (if (backfilled) "（本次调用缺颜色位，已按主题 JSON 补齐）" else ""))
        }

        /** 日志里怎么显示一个值：空串说「空」，其余是十六进制或字节数，都短。 */
        private fun describe(value: String): String {
            if (value.isEmpty()) return "空"
            return if (value.startsWith("#")) value else value.length.toString() + "字节"
        }
    }
}
