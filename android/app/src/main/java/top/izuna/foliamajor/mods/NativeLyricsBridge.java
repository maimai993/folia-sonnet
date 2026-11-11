package top.izuna.foliamajor.mods;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;

import top.izuna.foliamajor.wallpaper.WallpaperLyricsFont;
import top.izuna.foliamajor.wallpaper.WallpaperLyricsState;

/**
 * 把原生那份常驻歌词（{@link WallpaperLyricsState}）转成模组 overlay 能直接用的 JSON。
 *
 * 为什么不走模组原有的 IPC：桌面端模组的歌词是主进程 `webContents.send` 进页面的，
 * 安卓这条链要经过宿主 WebView，**App 一退后台 WebView 被冻结就断**，歌词永远停在
 * 最后一句。原生这份由 {@code FoliaPlaybackService} 在前后台都推进，是唯一不会停的
 * 数据源。
 *
 * 只读快照，不写任何状态；拿不到就返回 null，让调用方跳过这一拍。
 */
final class NativeLyricsBridge {

    private static final String TAG = "FoliaNativeLyrics";

    /**
     * 字体文件可能有好几 MB，不能跟着 250ms 的歌词节拍反复读。
     *
     * 这里按「路径 + 修改时间 + 大小」判重：换了字体才重新编码一次，平时直接给缓存的
     * 那份（甚至压根不放进 payload，见 {@link #fontPayload()}）。
     */
    private static String fontStamp = null;
    private static String fontData = null;

    private NativeLyricsBridge() {
    }

    /**
     * 把原生正在用的那份歌词字体编成 {@code data:} URL，供页面的 `@font-face` 直接吃。
     *
     * 为什么不传字体名：原生那份存的是**字体文件**（壁纸渲染器自己按路径加载），
     * 不是系统字体名；模组的字体栈写的是桌面端字体（'Microsoft YaHei UI' 等），
     * 安卓上一个都没有，于是用户换字体这边永远不跟着变。把字节递过来才能真正一致。
     *
     * 读不到就返回 null（没装自定义字体时会走「跟随播放页」那份，两个都没有就是 null）。
     */
    static synchronized JSONObject fontPayload(Context context) {
        if (context == null) return null;
        File file;
        try {
            file = WallpaperLyricsFont.Companion.activeFile(context);
        } catch (Throwable error) {
            return null;
        }
        if (file == null || !file.isFile() || file.length() <= 0) {
            fontStamp = null;
            fontData = null;
            return null;
        }
        String stamp = file.getAbsolutePath() + ":" + file.lastModified() + ":" + file.length();
        if (!stamp.equals(fontStamp)) {
            try {
                byte[] bytes = new byte[(int) file.length()];
                try (FileInputStream in = new FileInputStream(file)) {
                    int read = 0;
                    while (read < bytes.length) {
                        int got = in.read(bytes, read, bytes.length - read);
                        if (got <= 0) break;
                        read += got;
                    }
                }
                String mime = file.getName().endsWith(".otf") ? "font/otf" : "font/ttf";
                fontData = "data:" + mime + ";base64,"
                        + Base64.encodeToString(bytes, Base64.NO_WRAP);
                fontStamp = stamp;
            } catch (Throwable error) {
                Log.w(TAG, "读取自定义字体失败", error);
                fontStamp = null;
                fontData = null;
                return null;
            }
        }
        if (fontData == null) return null;
        JSONObject out = new JSONObject();
        try {
            out.put("data", fontData);
            out.put("stamp", fontStamp);
        } catch (Throwable error) {
            return null;
        }
        return out;
    }

    /**
     * 取一份当前播放 + 当前行的快照。
     *
     * 字段故意保持扁平：模组的页面注入脚本只做一次 `JSON.parse` 就能用，不需要理解
     * 原生的时间轴结构。
     */
    static JSONObject snapshot() {
        WallpaperLyricsState.Snapshot state;
        try {
            state = WallpaperLyricsState.get();
        } catch (Throwable error) {
            return null;
        }
        if (state == null) return null;

        JSONObject out = new JSONObject();
        try {
            out.put("title", state.title == null ? "" : state.title);
            out.put("artist", state.artist == null ? "" : state.artist);
            out.put("playing", state.playing);
            out.put("positionMs", state.positionMs());
            // 字体不在这里给：它是文件判据而不是字体名，走 fontPayload() 单独推。

            WallpaperLyricsState.TimedLine[] lines = state.lines;
            out.put("lineCount", lines == null ? 0 : lines.length);

            if (lines != null && lines.length > 0) {
                long position = state.positionMs();
                int index = state.indexAt(position);
                out.put("index", index);
                if (index >= 0 && index < lines.length) {
                    WallpaperLyricsState.TimedLine line = lines[index];
                    out.put("text", line.text == null ? "" : line.text);
                    if (line.translation != null) out.put("translation", line.translation);
                    out.put("startMs", line.startMs);
                    out.put("endMs", line.endMs);
                }
                // 前后各带一行：模组的排版会用到「上一句 / 下一句」。
                if (index + 1 >= 0 && index + 1 < lines.length) {
                    WallpaperLyricsState.TimedLine next = lines[index + 1];
                    out.put("nextText", next.text == null ? "" : next.text);
                }
                if (index - 1 >= 0 && index - 1 < lines.length) {
                    WallpaperLyricsState.TimedLine prev = lines[index - 1];
                    out.put("prevText", prev.text == null ? "" : prev.text);
                }
            }
        } catch (Throwable error) {
            return null;
        }
        return out;
    }
}
