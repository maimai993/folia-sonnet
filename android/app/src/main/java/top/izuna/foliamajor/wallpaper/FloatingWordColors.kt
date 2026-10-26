package top.izuna.foliamajor.wallpaper

import android.graphics.Color

import org.json.JSONArray
import org.json.JSONObject

import java.util.ArrayList
import java.util.Collections
import java.util.Comparator
import java.util.HashMap
import java.util.Locale
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * 简易悬浮窗的**关键字着色**：AI 主题里被单独标了色的那些词。
 *
 * 主题里那一项是 `wordColors: [{ word, color }]`（见 Web 侧的 `Theme.wordColors`），
 * 生成 AI 主题时由模型挑出歌词里有情绪的那几个词各给一个颜色。播放页的可视化
 * （claddagh / lumiere / monet…）画歌词时把被标到的字**换成那个颜色**，
 * 于是「AI 主题的效果」很大一块就落在这些字上。
 *
 * 这一层是原生 Canvas 画的两行字，本来只有「主色 + 高亮色」两个颜色，
 * AI 主题换上去看不出任何区别。所以这里把同一套匹配搬过来：
 * 命中的片段用它自己的颜色当**高亮色**（唱过去的那一段），没唱到的部分仍是主色 ——
 * 和播放页 `finalHighlightColor = charColor || highlightColor` 的做法一致。
 *
 * 匹配规则跟 Web 侧 `src/components/visualizer/wordColoring.ts` 对齐：
 * - 中日韩：整条**短语**在行文本里找（`indexOf`），按字符区间落到字上，
 *   所以「花火」不会顺带染到「火车」的「火」；
 * - 西文：按**词**匹配（归一化：转小写、去掉非 `[A-Za-z0-9_]`）；
 * - 重叠时按「短语更长者优先」取一个（`selectNonOverlappingRanges`）。
 *
 * 为什么必须按**区间**而不是按「这个字等不等于关键词」：后者在西文里会把
 * 每个单独的字母/子串都算命中，中文里也会把同字的其它词一起染了。
 */
class FloatingWordColors private constructor() {

    /** 一条着色规则（主题里的一项 wordColors）。 */
    class Rule internal constructor(color: Int, phrase: String?, words: Array<String>?, priority: Int) {
        @JvmField internal val color: Int = color
        /** 中日韩：整条短语。null = 这条走西文按词匹配。 */
        @JvmField internal val phrase: String? = phrase
        /** 西文：归一化后的词表。 */
        @JvmField internal val words: Array<String>? = words
        /** 冲突时的优先级：短语 / 词的长度，越长越优先。 */
        @JvmField internal val priority: Int = priority
    }

    /** 行文本上一段被着色的区间。 */
    private class Range(@JvmField val start: Int, @JvmField val end: Int,
                        @JvmField val color: Int, @JvmField val priority: Int)

    /** 一个歌词片段在行文本里的位置与它的颜色。 */
    class Segment internal constructor(startOffset: Int, endOffset: Int, color: Int) {
        /** 在行文本里的起始下标（用于量宽度：空格只在行文本里，词的 text 里没有）。 */
        @JvmField val startOffset: Int = startOffset
        @JvmField val endOffset: Int = endOffset
        /** NO_COLOR = 这个片段没被标色，用默认高亮色画。 */
        @JvmField val color: Int = color
    }

    /** 0 = 这个片段没被标色。Color 里 alpha 为 0 的颜色一律按「没标」处理。 */
    companion object {
        const val NO_COLOR = 0

        /** 没有规则时的空表。 */
        @JvmField val EMPTY: Array<Rule> = arrayOf()

        /** 西文的「词」：与 JS 的 `\w+` 一样只认 ASCII。 */
        private val ASCII_WORD = Pattern.compile("\\w+")
        private val NON_WORD = Pattern.compile("[^\\w]")

        /** 中日韩判定：与 Web 侧同一个字符区间。 */
        private val CJK = Pattern.compile("[\\u4e00-\\u9fa5\\u3040-\\u30ff\\uac00-\\ud7af]")

        /**
         * 解析主题 JSON 里的 `wordColors`。
         *
         * 解析失败（不是 JSON / 没有这一项 / 颜色写坏了）一律返回空表 ——
         * 着色是锦上添花，不该因为它把整个小窗弄崩。
         */
        @JvmStatic
        fun parse(themeJson: String?): Array<Rule> {
            if (themeJson == null || themeJson.isEmpty()) {
                return EMPTY
            }
            return try {
                val root = JSONObject(themeJson)
                val array = root.optJSONArray("wordColors")
                if (array == null || array.length() == 0) {
                    EMPTY
                } else {
                    val rules = ArrayList<Rule>()
                    var i = 0
                    while (i < array.length()) {
                        val item = array.optJSONObject(i)
                        if (item != null) {
                            var word: String? = item.optString("word", "")
                            if (word != null) {
                                word = word.trim()
                                if (!word.isEmpty()) {
                                    val color = parseColor(item.optString("color", ""))
                                    if (color != NO_COLOR) {
                                        val rule = ruleOf(word, color)
                                        if (rule != null) {
                                            rules.add(rule)
                                        }
                                    }
                                }
                            }
                        }
                        i += 1
                    }
                    if (rules.isEmpty()) EMPTY else rules.toTypedArray()
                }
            } catch (error: Throwable) {
                EMPTY
            }
        }

        /**
         * 一行的每个片段各落在行文本哪儿、各是什么颜色。
         *
         * 必须拿到**区间**而不只是颜色：西文歌词的 `words` 常常不带空格
         * （空格只在整行文本里），直接把词的宽度累加起来摆字会挤成一团。
         * 有了区间，每个字的 x 就是 `measureText(整行[0, start))`，空格自动算进去。
         *
         * @param lineText 整行文本（TimedLine.text）。
         * @param words    这一行的逐词时间轴；null / 空就返回空数组。
         */
        @JvmStatic
        fun segments(lineText: String?, words: Array<WallpaperLyricsState.TimedWord>?,
                     rules: Array<Rule>?): Array<Segment> {
            val count = words?.size ?: 0
            val out = arrayOfNulls<Segment>(count)
            if (count == 0) {
                return out.requireNoNulls()
            }
            if (lineText == null || lineText.isEmpty()) {
                for (i in 0 until count) {
                    out[i] = Segment(0, 0, NO_COLOR)
                }
                return out.requireNoNulls()
            }
            /*
             * 没有规则时也要把**区间**算出来：摆字要靠它（西文的空格只在整行文本里），
             * 只是颜色一律 NO_COLOR —— 那一层会退回默认高亮色，扫光照旧。
             */
            val colored = rules != null && rules.isNotEmpty()
            val ranges: List<Range> = if (colored) rangesOf(rules!!, lineText) else Collections.emptyList()
            var cursor = 0
            for (i in 0 until count) {
                val word = words!![i]
                val token = word?.text
                if (token == null || token.isEmpty()) {
                    out[i] = Segment(cursor, cursor, NO_COLOR)
                    continue
                }
                var start = lineText.indexOf(token, cursor)
                if (start < 0) {
                    // 对不上（行文本被改过 / 词表来自另一处）：退到游标处，至少不越界。
                    start = Math.min(cursor, lineText.length)
                    out[i] = Segment(start, Math.min(start + token.length, lineText.length),
                            NO_COLOR)
                    continue
                }
                /*
                 * 一律夹回行文本的长度内。
                 *
                 * 这不是防御性冗余：下游要拿这两个下标去 `measureText(text, start, end)`，
                 * 越界会抛 StringIndexOutOfBoundsException —— 而它是在 `onDraw` 里抛的，
                 * 后果是**这一帧后半段全画不出来**（锁图标、拉伸把手一起消失），
                 * 屏幕上只留下半句歌词。词表与整行文本对不上时（行被改过 / 词来自另一处）
                 * 真的会越界。
                 */
                val end = Math.min(start + token.length, lineText.length)
                cursor = end
                out[i] = Segment(start, Math.max(start, end),
                        if (colored) colorAt(ranges, start, end) else NO_COLOR)
            }
            return out.requireNoNulls()
        }

        /** 这一行上所有被着色的区间（已去重）。 */
        private fun rangesOf(rules: Array<Rule>, lineText: String): List<Range> {
            val ranges = ArrayList<Range>()
            val englishByWord = HashMap<String, IntArray>()
            for (rule in rules) {
                if (rule.phrase != null) {
                    var cursor = 0
                    while (cursor < lineText.length) {
                        val start = lineText.indexOf(rule.phrase, cursor)
                        if (start < 0) break
                        ranges.add(Range(start, start + rule.phrase.length,
                                rule.color, rule.priority))
                        cursor = start + Math.max(rule.phrase.length, 1)
                    }
                    continue
                }
                for (word in rule.words!!) {
                    val current = englishByWord[word]
                    if (current == null || rule.priority > current[1]) {
                        englishByWord[word] = intArrayOf(rule.color, rule.priority)
                    }
                }
            }
            if (!englishByWord.isEmpty()) {
                val matcher = ASCII_WORD.matcher(lineText)
                while (matcher.find()) {
                    val hit = englishByWord[normalize(matcher.group())]
                    if (hit != null) {
                        ranges.add(Range(matcher.start(), matcher.end(), hit[0], hit[1]))
                    }
                }
            }
            return selectNonOverlapping(ranges)
        }

        /**
         * 去重叠：按「短语更长者优先、其次靠前」贪心取，再按位置排回来。
         *
         * 和 Web 侧同一个顺序，否则两边颜色会不一样（同一句在播放页和桌面小窗上两种配色）。
         */
        private fun selectNonOverlapping(ranges: List<Range>): List<Range> {
            if (ranges.size <= 1) {
                return ranges
            }
            val sorted = ArrayList<Range>(ranges)
            Collections.sort(sorted, object : Comparator<Range> {
                override fun compare(a: Range, b: Range): Int {
                    if (a.priority != b.priority) return b.priority - a.priority
                    if (a.start != b.start) return a.start - b.start
                    return a.end - b.end
                }
            })
            val selected = ArrayList<Range>()
            for (candidate in sorted) {
                var overlaps = false
                for (taken in selected) {
                    if (candidate.start < taken.end && taken.start < candidate.end) {
                        overlaps = true
                        break
                    }
                }
                if (!overlaps) {
                    selected.add(candidate)
                }
            }
            Collections.sort(selected, object : Comparator<Range> {
                override fun compare(a: Range, b: Range): Int {
                    if (a.start != b.start) return a.start - b.start
                    return a.end - b.end
                }
            })
            return selected
        }

        private fun colorAt(ranges: List<Range>, start: Int, end: Int): Int {
            for (range in ranges) {
                if (start < range.end && range.start < end) {
                    return range.color
                }
            }
            return NO_COLOR
        }

        private fun ruleOf(word: String, color: Int): Rule? {
            if (CJK.matcher(word).find()) {
                return Rule(color, word, null, word.length)
            }
            val parts = word.split("\\s+".toRegex()).dropLastWhile { it.isEmpty() }.toTypedArray()
            val words = ArrayList<String>()
            var longest = 0
            for (part in parts) {
                val normalized = normalize(part)
                if (normalized.isEmpty()) continue
                words.add(normalized)
                if (normalized.length > longest) {
                    longest = normalized.length
                }
            }
            if (words.isEmpty()) {
                return null
            }
            return Rule(color, null, words.toTypedArray(), longest)
        }

        /** 与 Web 侧同一个归一化：转小写 + 去掉非 `\w`。 */
        private fun normalize(value: String?): String {
            if (value == null) return ""
            return NON_WORD.matcher(value.lowercase(Locale.ROOT)).replaceAll("")
        }

        private fun parseColor(value: String?): Int {
            if (value == null || value.isEmpty()) return NO_COLOR
            return try {
                val color = Color.parseColor(value.trim())
                // 全透明等于「没标色」（NO_COLOR 就是 0），别把它当成黑。
                if (Color.alpha(color) == 0) NO_COLOR else color
            } catch (error: Throwable) {
                NO_COLOR
            }
        }
    }
}
