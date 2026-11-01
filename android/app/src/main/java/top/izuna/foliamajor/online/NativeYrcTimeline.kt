package top.izuna.foliamajor.online

import top.izuna.foliamajor.wallpaper.WallpaperLyricsState

// 原生网易 YRC 的逐字时间轴适配；网络和歌曲认领仍由 MusicGateway / 播放服务负责。
object NativeYrcTimeline {
    private val linePattern = Regex("^\\[(\\d+),(\\d+)\\](.*)$")
    private val wordPattern = Regex("\\((\\d+),(\\d+),\\d+\\)([^()]*)")

    /** ColorOS lyricType=0 只收逐行 LRC，不能把 YRC 原文当普通时间戳交过去。 */
    fun asLineLrc(text: String): String {
        val lines = parse(text, null) ?: return text
        return lines.joinToString("\n") { line ->
            val ms = line.startMs
            val stamp = String.format(java.util.Locale.ROOT, "[%02d:%02d.%03d]",
                    ms / 60000, ms / 1000 % 60, ms % 1000)
            stamp + line.text
        }
    }

    /** 非 YRC 返回 null，让调用者继续使用原来的 LRC 解析；YRC 不再被判成无词。 */
    fun parse(main: String?, translated: String?): List<WallpaperLyricsState.TimedLine>? {
        if (main.isNullOrBlank()) return null
        val rawLines = main.removePrefix("\uFEFF").lineSequence().map { it.trim() }.toList()
        if (rawLines.none { linePattern.matches(it) }) return null
        val translations = if (translated.isNullOrBlank()) emptyMap() else
            MusicGateway.parseLrc(translated, null).associate { it.startMs to it.text }
        return rawLines.mapNotNull { raw ->
            val match = linePattern.matchEntire(raw) ?: return@mapNotNull null
            val start = match.groupValues[1].toLongOrNull() ?: return@mapNotNull null
            val duration = match.groupValues[2].toLongOrNull() ?: return@mapNotNull null
            if (duration > Long.MAX_VALUE - start) return@mapNotNull null
            val words = wordPattern.findAll(match.groupValues[3]).mapNotNull { word ->
                val wordStart = word.groupValues[1].toLongOrNull() ?: return@mapNotNull null
                val wordDuration = word.groupValues[2].toLongOrNull() ?: return@mapNotNull null
                val text = word.groupValues[3]
                if (text.isEmpty() || wordDuration > Long.MAX_VALUE - wordStart) return@mapNotNull null
                WallpaperLyricsState.TimedWord(text, wordStart, wordStart + wordDuration)
            }.toList()
            if (words.isEmpty()) return@mapNotNull null
            WallpaperLyricsState.TimedLine(
                words.joinToString("") { it.text }, start, start + duration,
                translations[start], words.toTypedArray())
        }.sortedBy { it.startMs }
    }
}
