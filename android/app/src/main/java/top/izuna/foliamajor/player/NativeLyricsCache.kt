package top.izuna.foliamajor.player

import org.json.JSONObject

// 当前文件：原生兜底切歌这一段的歌词缓存；只服务 FoliaPlaybackService 的快照。

class NativeLyricsCache {
    private var songKey: String = ""
    private var lrc: String = ""
    private var translated: String = ""
    private var fetched = false

    /** 换到 [songKey]：立即丢掉上一首的歌词，等这一首的结果回来再填。 */
    fun clear(songKey: String) {
        this.songKey = songKey
        lrc = ""
        translated = ""
        fetched = false
    }

    /** 这一首拉完了（含拉不到词）：空串也是显式结果，不能留着别首。 */
    fun store(songKey: String, lrc: String?, translated: String?) {
        // 已经换到别的歌了：上一首的异步结果晚到，直接丢。
        if (this.songKey.isNotEmpty() && songKey != this.songKey) return
        this.songKey = songKey
        this.lrc = lrc ?: ""
        this.translated = translated ?: ""
        fetched = true
    }

    /** 当前首已经拉过才返回；没拉过（或还是别首）返回 null。 */
    fun snapshot(currentSongKey: String?): Snapshot? {
        if (!fetched || currentSongKey.isNullOrEmpty() || songKey != currentSongKey) return null
        return Snapshot(songKey, lrc, translated)
    }

    data class Snapshot(val songKey: String, val lrc: String, val translated: String) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("songKey", songKey)
            put("lrc", lrc)
            put("translated", translated)
        }
    }
}
