package top.izuna.foliamajor.wallpaper;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 壁纸与应用之间的歌词中转站。
 *
 * 动态壁纸（LyricsWallpaperService）和应用跑在**同一个进程**里（同一个 APK、同一个
 * applicationId 的 WallpaperService 由系统在本进程内实例化），所以不需要跨进程 IPC，
 * 一个进程内的静态引用就够了 —— 进度这种每 100ms 更新一次的数据走内存才不卡。
 *
 * 但进程被系统回收后静态引用就没了，壁纸会被重新创建在全新进程里，
 * 那时应用可能根本没启动。所以「慢字段」（歌名/歌词行/当前行）另外落一份
 * SharedPreferences，保证壁纸至少不是一片空白；进度这种高频字段不落盘。
 */
public final class WallpaperLyricsState {

    private static final String PREFS = "folia_wallpaper_lyrics";
    private static final String KEY_TITLE = "title";
    private static final String KEY_ARTIST = "artist";
    private static final String KEY_LINES = "lines";
    private static final String KEY_INDEX = "index";
    private static final String KEY_ACCENT = "accent";
    private static final String KEY_PLAYING = "playing";
    private static final String KEY_STAMP = "stamp";
    /** 歌词行之间用一个不可能出现在歌词里的分隔符拼接，避免引入 JSON 依赖。 */
    private static final String LINE_SEPARATOR = "␟";

    private WallpaperLyricsState() {}

    public static final class Snapshot {
        public final String title;
        public final String artist;
        public final String[] lines;
        public final int index;
        public final float progress;
        public final boolean playing;
        public final int accent;
        public final String cover;
        public final long stamp;

        Snapshot(String title, String artist, String[] lines, int index, float progress,
                 boolean playing, int accent, String cover, long stamp) {
            this.title = title == null ? "" : title;
            this.artist = artist == null ? "" : artist;
            this.lines = lines == null ? new String[0] : lines;
            this.index = index;
            this.progress = progress;
            this.playing = playing;
            this.accent = accent;
            this.cover = cover;
            this.stamp = stamp;
        }

        public boolean isEmpty() {
            return lines.length == 0 && title.isEmpty();
        }
    }

    private static final Snapshot EMPTY =
            new Snapshot("", "", new String[0], 0, 0f, false, 0xFF7C5CFF, null, 0L);

    /** 唯一的可变状态：整个对象一次替换，读侧永远看到自洽的一帧。 */
    private static volatile Snapshot current = EMPTY;
    /** 封面单独存：它体积大、只在换歌时变，不该跟着进度一起被替换。 */
    private static volatile String cover = null;

    public static Snapshot get() {
        Snapshot snapshot = current;
        if (snapshot.cover == null && cover != null) {
            return new Snapshot(snapshot.title, snapshot.artist, snapshot.lines, snapshot.index,
                    snapshot.progress, snapshot.playing, snapshot.accent, cover, snapshot.stamp);
        }
        return snapshot;
    }

    public static void publish(Context context, String title, String artist, String[] lines,
                               int index, float progress, boolean playing, int accent,
                               String newCover, boolean slowFieldsChanged) {
        if (newCover != null) {
            cover = newCover;
        }
        Snapshot previous = current;
        Snapshot next = new Snapshot(
                title != null ? title : previous.title,
                artist != null ? artist : previous.artist,
                lines != null ? lines : previous.lines,
                index,
                progress,
                playing,
                accent != 0 ? accent : previous.accent,
                newCover != null ? newCover : cover,
                System.currentTimeMillis());
        current = next;
        if (slowFieldsChanged && context != null && lines != null) {
            persist(context, next);
        }
    }

    public static void clear(Context context) {
        current = EMPTY;
        cover = null;
        if (context != null) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        }
    }

    /** 进程刚被拉起时调用：把上次落盘的歌词读回来，避免壁纸一片空白。 */
    public static void restore(Context context) {
        if (context == null) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String joined = prefs.getString(KEY_LINES, null);
        if (joined == null || joined.isEmpty()) {
            return;
        }
        String[] lines = joined.split(LINE_SEPARATOR, -1);
        current = new Snapshot(
                prefs.getString(KEY_TITLE, ""),
                prefs.getString(KEY_ARTIST, ""),
                lines,
                prefs.getInt(KEY_INDEX, 0),
                0f,
                prefs.getBoolean(KEY_PLAYING, false),
                prefs.getInt(KEY_ACCENT, EMPTY.accent),
                null,
                prefs.getLong(KEY_STAMP, System.currentTimeMillis()));
    }

    private static void persist(Context context, Snapshot snapshot) {
        StringBuilder joined = new StringBuilder();
        for (int i = 0; i < snapshot.lines.length; i++) {
            if (i > 0) {
                joined.append(LINE_SEPARATOR);
            }
            joined.append(snapshot.lines[i].replace(LINE_SEPARATOR, " "));
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_TITLE, snapshot.title)
                .putString(KEY_ARTIST, snapshot.artist)
                .putString(KEY_LINES, joined.toString())
                .putInt(KEY_INDEX, snapshot.index)
                .putInt(KEY_ACCENT, snapshot.accent)
                .putBoolean(KEY_PLAYING, snapshot.playing)
                .putLong(KEY_STAMP, snapshot.stamp)
                .apply();
    }
}
