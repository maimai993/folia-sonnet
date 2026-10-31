package top.izuna.foliamajor.player

import android.content.Context
import top.izuna.foliamajor.coloros.ColorOsLyricBridge
import top.izuna.foliamajor.wallpaper.WallpaperLyricsState

// 当前文件：原生兜底切歌时歌词在桌面 / 锁屏上的收尾，以及队列快照的附加字段。

object NativeLyricPresentation {

    /** 当前这首没有词（换歌 / 拉不到 / 纯音乐）：清掉上一首的时间轴，标题仍用这首。 */
    fun clear(
        context: Context,
        songKey: String,
        currentSongKey: String?,
        title: String,
        artist: String,
        durationMs: Long,
        playing: Boolean,
    ) {
        if (songKey != currentSongKey) return
        ColorOsLyricBridge.clear()
        WallpaperLyricsState.publish(context, title, artist, null, 0, 0, 0f, null, null,
                null, -1f, null, null, durationMs, emptyArray(), null, 0L, playing)
    }

    /** 复用已拉到的逐行 LRC 补齐 ColorOS；不捏造逐字时间。 */
    fun publishColorOs(context: Context, payload: NativeLyricsCache.Snapshot?, title: String, artist: String, album: String, durationMs: Long) {
        if (!ColorOsLyricBridge.detect().supported || payload == null) return
        val enabled = top.izuna.foliamajor.settings.FoliaSettingsStore.get(context)
                .getBoolean("folia.colorOsLyricsEnabled", true)
        if (!enabled || payload.lrc.isEmpty()) return
        val json = org.json.JSONObject().apply {
            put("songName", title); put("artist", artist); put("album", album)
            put("songId", payload.songKey); put("lyricType", 0); put("lyric", payload.lrc)
            put("noLyric", false); put("provider", "top.izuna.foliamajor"); put("source", "folia-sonnet")
            put("trackKey", payload.songKey); put("sessionGeneration", 1)
            if (payload.translated.isNotEmpty()) put("translationLyric", payload.translated)
        }.toString()
        if (json.length <= 200_000) ColorOsLyricBridge.setPending(json, payload.translated.isNotEmpty(), payload.songKey)
    }

    /** 把原生媒体与当前歌词塞进队列快照；没有的字段不写，老版本 Web 照旧可用。 */
    fun attach(out: org.json.JSONObject, lyrics: NativeLyricsCache, songKey: String?) {
        FoliaNativePlayerPlugin.mediaSnapshot()?.let { out.put("nativeMedia", it.toJson()) }
        lyrics.snapshot(songKey)?.let { out.put("lyrics", it.toJson()) }
    }
}
