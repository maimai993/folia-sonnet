package top.izuna.foliamajor.wallpaper;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

/**
 * 壁纸与应用之间的歌词中转站。
 *
 * 动态壁纸（LyricsWallpaperService）和应用跑在**同一个进程**里（同一个 APK 的
 * WallpaperService 由系统在本进程内实例化），所以不需要跨进程 IPC，进程内的静态引用就够了。
 *
 * 关键设计：**这里存的是整条时间轴，而不是「当前行」。**
 * 应用退到后台后，WebView 的 JS 定时器会被系统挂起；靠 JS 每 100ms 推一次「当前行」的话，
 * 后台时推送一停，歌词就永远停在那一句。所以改成：换歌时下发一次完整时间轴，
 * 播放中只偶尔推一个「时间锚点」（某时刻对应播放到第几毫秒），
 * 之后由原生按墙钟自己往前推 —— JS 就算再也不推，歌词也照样往下走。
 *
 * 时间轴与慢字段另外落一份 SharedPreferences：进程被回收后壁纸会被重新拉起，
 * 那时应用可能根本没启动过。
 */
public final class WallpaperLyricsState {

    private static final String PREFS = "folia_wallpaper_lyrics";
    private static final String KEY_TITLE = "title";
    private static final String KEY_ARTIST = "artist";
    private static final String KEY_TIMELINE = "timeline";
    private static final String KEY_POSITION = "position";
    private static final String KEY_PLAYING = "playing";
    private static final String KEY_ACCENT = "accent";
    private static final String KEY_BACKGROUND = "background";
    private static final String KEY_BASE = "base";
    private static final String KEY_MOTION = "motion";
    private static final String KEY_STAMP = "stamp";
    /** 行分隔符与字段分隔符都挑不可能出现在歌词里的字符。 */
    private static final String LINE_SEPARATOR = "␟";
    private static final String FIELD_SEPARATOR = "␞";

    private WallpaperLyricsState() {}

    public static final class TimedLine {
        public final String text;
        public final long startMs;
        public final long endMs;

        public TimedLine(String text, long startMs, long endMs) {
            this.text = text == null ? "" : text;
            this.startMs = startMs;
            this.endMs = endMs;
        }
    }

    public static final class Snapshot {
        public final String title;
        public final String artist;
        public final String cover;
        public final int accent;
        /** 与 App 当前主题一致的底色，避免壁纸和 App 两套色调。 */
        public final int baseColor;
        /** 动效强度：calm 0.6 / normal 1.0 / chaotic 1.5，沿用 App 主题的 animationIntensity。 */
        public final float motion;
        /** 背景模式：cover = 模糊封面，color = 只用主题色渐变。 */
        public final String backgroundMode;
        public final TimedLine[] lines;
        public final boolean playing;
        /** 锚点：elapsedRealtime 为 anchorElapsedMs 时，播放位置是 anchorPositionMs。 */
        public final long anchorElapsedMs;
        public final long anchorPositionMs;
        public final long stamp;

        Snapshot(String title, String artist, String cover, int accent, int baseColor, float motion,
                 String backgroundMode, TimedLine[] lines, boolean playing, long anchorElapsedMs,
                 long anchorPositionMs, long stamp) {
            this.title = title == null ? "" : title;
            this.artist = artist == null ? "" : artist;
            this.cover = cover;
            this.accent = accent;
            this.baseColor = baseColor;
            this.motion = motion;
            this.backgroundMode = backgroundMode == null ? "cover" : backgroundMode;
            this.lines = lines == null ? new TimedLine[0] : lines;
            this.playing = playing;
            this.anchorElapsedMs = anchorElapsedMs;
            this.anchorPositionMs = anchorPositionMs;
            this.stamp = stamp;
        }

        /** 按墙钟推算当前播放位置。暂停时冻结在锚点上。 */
        public long positionMs() {
            if (!playing) {
                return anchorPositionMs;
            }
            return anchorPositionMs + (SystemClock.elapsedRealtime() - anchorElapsedMs);
        }

        /** 当前行下标：取最后一个 start <= position 的行。 */
        public int indexAt(long positionMs) {
            if (lines.length == 0) {
                return 0;
            }
            int low = 0;
            int high = lines.length - 1;
            int found = 0;
            while (low <= high) {
                int mid = (low + high) >>> 1;
                if (lines[mid].startMs <= positionMs) {
                    found = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }
            return found;
        }

        /** 行内进度 0..1。两句之间的空档按「上一句唱完」处理。 */
        public float progressAt(long positionMs) {
            int index = indexAt(positionMs);
            if (lines.length == 0) {
                return 0f;
            }
            TimedLine line = lines[index];
            long span = line.endMs - line.startMs;
            if (span <= 0) {
                return 1f;
            }
            float progress = (positionMs - line.startMs) / (float) span;
            return progress < 0f ? 0f : progress > 1f ? 1f : progress;
        }

        public boolean isEmpty() {
            return lines.length == 0;
        }
    }

    private static final Snapshot EMPTY = new Snapshot(
            "", "", null, 0xFF7C5CFF, 0xFF09090B, 1f, "cover", new TimedLine[0], false, 0L, 0L, 0L);

    private static volatile Snapshot current = EMPTY;

    public static Snapshot get() {
        return current;
    }

    /** 播放位置推进：只更新锚点，不动时间轴，也不落盘。 */
    public static void setAnchor(long positionMs, boolean playing) {
        Snapshot previous = current;
        current = new Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                previous.baseColor, previous.motion, previous.backgroundMode, previous.lines,
                playing, SystemClock.elapsedRealtime(), positionMs, previous.stamp);
    }

    public static void publish(Context context, String title, String artist, String cover,
                               int accent, int baseColor, float motion, String backgroundMode,
                               TimedLine[] lines, long positionMs, boolean playing) {
        Snapshot previous = current;
        Snapshot next = new Snapshot(
                title != null ? title : previous.title,
                artist != null ? artist : previous.artist,
                cover != null ? cover : previous.cover,
                accent != 0 ? accent : previous.accent,
                baseColor != 0 ? baseColor : previous.baseColor,
                motion > 0f ? motion : previous.motion,
                backgroundMode != null ? backgroundMode : previous.backgroundMode,
                lines != null ? lines : previous.lines,
                playing,
                SystemClock.elapsedRealtime(),
                positionMs,
                System.currentTimeMillis());
        current = next;
        if (context != null && lines != null) {
            persist(context, next);
        }
    }

    /** 只换背景模式，不动时间轴（避免整条时间轴重新落盘）。 */
    public static void setBackgroundMode(Context context, String backgroundMode) {
        Snapshot previous = current;
        current = new Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                previous.baseColor, previous.motion, backgroundMode, previous.lines,
                previous.playing, previous.anchorElapsedMs, previous.anchorPositionMs,
                previous.stamp);
        if (context != null) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_BACKGROUND, backgroundMode)
                    .apply();
        }
    }

    public static void clear(Context context) {
        current = EMPTY;
        if (context != null) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        }
    }

    /** 进程被拉起时把落盘的时间轴读回来。 */
    public static void restore(Context context) {
        if (context == null) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String joined = prefs.getString(KEY_TIMELINE, null);
        if (joined == null || joined.isEmpty()) {
            return;
        }
        String[] encoded = joined.split(LINE_SEPARATOR, -1);
        TimedLine[] lines = new TimedLine[encoded.length];
        for (int i = 0; i < encoded.length; i++) {
            String[] fields = encoded[i].split(FIELD_SEPARATOR, -1);
            long start = fields.length > 0 ? parseLong(fields[0]) : 0L;
            long end = fields.length > 1 ? parseLong(fields[1]) : 0L;
            String text = fields.length > 2 ? fields[2] : "";
            lines[i] = new TimedLine(text, start, end);
        }
        current = new Snapshot(
                prefs.getString(KEY_TITLE, ""),
                prefs.getString(KEY_ARTIST, ""),
                null,
                prefs.getInt(KEY_ACCENT, EMPTY.accent),
                prefs.getInt(KEY_BASE, EMPTY.baseColor),
                prefs.getFloat(KEY_MOTION, EMPTY.motion),
                prefs.getString(KEY_BACKGROUND, "cover"),
                lines,
                false,
                SystemClock.elapsedRealtime(),
                prefs.getLong(KEY_POSITION, 0L),
                prefs.getLong(KEY_STAMP, System.currentTimeMillis()));
    }

    private static void persist(Context context, Snapshot snapshot) {
        StringBuilder joined = new StringBuilder();
        for (int i = 0; i < snapshot.lines.length; i++) {
            if (i > 0) {
                joined.append(LINE_SEPARATOR);
            }
            TimedLine line = snapshot.lines[i];
            joined.append(line.startMs)
                    .append(FIELD_SEPARATOR)
                    .append(line.endMs)
                    .append(FIELD_SEPARATOR)
                    .append(line.text.replace(LINE_SEPARATOR, " ").replace(FIELD_SEPARATOR, " "));
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_TITLE, snapshot.title)
                .putString(KEY_ARTIST, snapshot.artist)
                .putString(KEY_TIMELINE, joined.toString())
                .putLong(KEY_POSITION, snapshot.anchorPositionMs)
                .putBoolean(KEY_PLAYING, snapshot.playing)
                .putInt(KEY_ACCENT, snapshot.accent)
                .putInt(KEY_BASE, snapshot.baseColor)
                .putFloat(KEY_MOTION, snapshot.motion)
                .putString(KEY_BACKGROUND, snapshot.backgroundMode)
                .putLong(KEY_STAMP, snapshot.stamp)
                .apply();
    }

    private static long parseLong(String value) {
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException error) {
            return 0L;
        }
    }
}
