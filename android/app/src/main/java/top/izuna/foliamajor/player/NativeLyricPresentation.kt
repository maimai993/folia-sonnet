package top.izuna.foliamajor.player

import android.content.Context
import android.util.Log
import top.izuna.foliamajor.coloros.ColorOsLyricBridge
import top.izuna.foliamajor.wallpaper.WallpaperLyricsState

// 当前文件：原生兜底切歌时歌词在桌面 / 锁屏上的收尾，以及队列快照的附加字段。

object NativeLyricPresentation {

    private const val TAG = "NativeLyricPresentation"

    /** ColorOS 桥能接受的载荷上限（字节）。硬限制：超了桥那边直接丢掉，所以这里先拦。 */
    private const val COLOR_OS_MAX_PAYLOAD = 200_000

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

    /**
     * 复用已拉到的逐行 LRC 补齐 ColorOS；不捏造逐字时间。
     *
     * 四条提前返回都记一行（issue H11）：以前它们全是静默的，于是
     * 「锁屏停在上一首」这件事在日志里看不出是没词、桥不支持、开关关了还是体积超了。
     * 只记决定，不记经过。
     */
    fun publishColorOs(context: Context, payload: NativeLyricsCache.Snapshot?, title: String, artist: String, album: String, durationMs: Long) {
        if (!ColorOsLyricBridge.detect().supported) {
            Log.i(TAG, "skip ColorOS lyrics: bridge unsupported")
            return
        }
        if (payload == null) {
            Log.i(TAG, "skip ColorOS lyrics: no snapshot yet")
            return
        }
        val enabled = top.izuna.foliamajor.settings.FoliaSettingsStore.get(context)
                .getBoolean("folia.colorOsLyricsEnabled", true)
        if (!enabled) {
            Log.i(TAG, "skip ColorOS lyrics: disabled in settings")
            return
        }
        if (payload.lrc.isEmpty()) {
            Log.i(TAG, "skip ColorOS lyrics: snapshot has no lines")
            return
        }
        val json = org.json.JSONObject().apply {
            put("songName", title); put("artist", artist); put("album", album)
            put("songId", payload.songKey); put("lyricType", 0)
            put("lyric", top.izuna.foliamajor.online.NativeYrcTimeline.asLineLrc(payload.lrc))
            put("noLyric", false); put("provider", "top.izuna.foliamajor"); put("source", "folia-sonnet")
            put("trackKey", payload.songKey); put("sessionGeneration", 1)
            if (payload.translated.isNotEmpty()) put("translationLyric",
                    top.izuna.foliamajor.online.NativeYrcTimeline.asLineLrc(payload.translated))
        }.toString()
        if (json.length <= COLOR_OS_MAX_PAYLOAD) {
            ColorOsLyricBridge.setPending(json, payload.translated.isNotEmpty(), payload.songKey)
        } else {
            /*
             * 超限不推：ColorOS 那边会把整包丢掉，屏幕上就停在上一首。以前这里一声不响，
             * 现象与「没拉到词」长得一样。现在把体积和行数记下来，一眼能分清是哪种。
             */
            Log.w(TAG, "ColorOS lyrics dropped: payload " + json.length + " > " + COLOR_OS_MAX_PAYLOAD
                    + " (lrcChars=" + payload.lrc.length + ", translationChars=" + payload.translated.length + ")")
        }
    }

    /** 把原生媒体与当前歌词塞进队列快照；没有的字段不写，老版本 Web 照旧可用。 */
    fun attach(out: org.json.JSONObject, lyrics: NativeLyricsCache, songKey: String?) {
        FoliaNativePlayerPlugin.mediaSnapshot()?.let { out.put("nativeMedia", it.toJson()) }
        lyrics.snapshot(songKey)?.let { out.put("lyrics", it.toJson()) }
    }
}
