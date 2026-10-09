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
    private static final String KEY_VISUALIZER = "visualizer";
    private static final String KEY_BLUR = "blur";
    private static final String KEY_PROGRESS = "progress";
    private static final String KEY_TRANSLATION = "translation";
    private static final String KEY_TUNING = "tuning";
    private static final String KEY_DURATION = "duration";
    /** 行分隔符与字段分隔符都挑不可能出现在歌词里的字符。 */
    private static final String LINE_SEPARATOR = "␟";
    private static final String FIELD_SEPARATOR = "␞";
    private static final String TUNING_PAIR_SEPARATOR = "␝";
    private static final String TUNING_VALUE_SEPARATOR = "␜";

    /** 与应用默认值一致（useVisualizerSettingsStore 的 DEFAULT_WALLPAPER_BLUR）。 */
    static final float DEFAULT_BLUR = 0.35f;

    private WallpaperLyricsState() {}

    /** 纯音乐时的占位文案。没有歌词就画它，别留一块黑屏。 */
    private static final String INSTRUMENTAL_TEXT = "纯音乐，请欣赏";

    public static final class TimedLine {
        public final String text;
        public final long startMs;
        public final long endMs;
        /**
         * 翻译行。null = 这一行没有翻译（不是空串 —— 空串会让下游分不清「没有」和「有但是空」，
         * 而过桥时传 null 会变成 JSONObject.NULL，读出来是字符串 "null"）。
         */
        public final String translation;

        public TimedLine(String text, long startMs, long endMs) {
            this(text, startMs, endMs, null);
        }

        public TimedLine(String text, long startMs, long endMs, String translation) {
            this.text = text == null ? "" : text;
            this.startMs = startMs;
            this.endMs = endMs;
            this.translation = translation;
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
        /** 背景模式：cover = 模糊封面，color = 主题色渐变，image = 用户自选图片。 */
        public final String backgroundMode;
        /**
         * 自选背景图的 key（见 WallpaperBackgroundImage）。只在 mode=image 时生效。
         * 存的是「当前磁盘上是哪张图」的轻量判据，不是图本身 —— 图在私有文件里，
         * 进程怎么重启都在，也不会有几百 KB 的字符串在桥上反复传。
         */
        public final String image;
        /**
         * 歌词字体的 key（见 WallpaperLyricsFont）；null = 用系统 sans-serif。
         * 同理只存判据，字体文件本身在私有目录里。
         */
        public final String font;
        /** App 当前的可视化模式，决定壁纸的动画风格（见 LyricsRenderer 的风格表）。 */
        public final String visualizerMode;
        /** 背景模糊强度 0..1。作用于模糊封面与自选背景图：0 保留原图清晰度，1 糊成色块。 */
        public final float blur;
        /** 是否在歌词上方画一条整首歌的进度条。 */
        public final boolean showProgress;
        /** 是否在主行下面再画一行翻译。没翻译的行不会因此多出空行。 */
        public final boolean showTranslation;
        /** 整首歌时长（毫秒）。0 = 未知（应用没给 / 流媒体），此时不画进度条。 */
        public final long durationMs;
        public final TimedLine[] lines;
        /** 整条时间轴里有没有任何一行带翻译。没有的话行距不用为翻译留位置。 */
        public final boolean hasTranslation;
        public final boolean playing;
        /** 锚点：elapsedRealtime 为 anchorElapsedMs 时，播放位置是 anchorPositionMs。 */
        public final long anchorElapsedMs;
        public final long anchorPositionMs;
        public final long stamp;
        /**
         * 这一份歌词是「纯音乐」占位，不是真歌词。
         *
         * 没有歌词时不能什么都不画 —— 那样整块屏幕就是黑的，看着像坏了。
         * 所以在构造点补一行占位文案交给正常的歌词管线去画。
         * 但叠层那边「纯音乐不显示」的判定要看这个标记，而不是看行数为 0，
         * 否则占位行会被当成真歌词、开关就失效了。
         */
        public final boolean placeholderOnly;

        Snapshot(String title, String artist, String cover, int accent, int baseColor, float motion,
                 String backgroundMode, String image, String font, String visualizerMode,
                 float blur, boolean showProgress, boolean showTranslation, long durationMs,
                 TimedLine[] lines, boolean playing, long anchorElapsedMs, long anchorPositionMs,
                 long stamp) {
            this.title = title == null ? "" : title;
            this.artist = artist == null ? "" : artist;
            this.cover = cover;
            this.accent = accent;
            this.baseColor = baseColor;
            this.motion = motion;
            this.backgroundMode = backgroundMode == null ? "cover" : backgroundMode;
            this.image = image;
            this.font = font;
            this.visualizerMode = visualizerMode == null ? "sonnet" : visualizerMode;
            this.blur = blur < 0f ? 0f : blur > 1f ? 1f : blur;
            this.showProgress = showProgress;
            this.showTranslation = showTranslation;
            this.durationMs = durationMs > 0L ? durationMs : 0L;
            TimedLine[] resolvedLines = lines == null ? new TimedLine[0] : lines;
            // 有歌但没有歌词 = 纯音乐：补一行占位文案，别让屏幕空着。
            // 冷启动（连歌都没有）不补 —— 那种情况走的是待机配色，不该出现"纯音乐"字样。
            boolean instrumental = resolvedLines.length == 0 && !this.title.isEmpty();
            if (instrumental) {
                // 6 秒走完这一行的扫光，之后就是常亮，不会整首歌慢慢划过去。
                resolvedLines = new TimedLine[]{new TimedLine(INSTRUMENTAL_TEXT, 0L, 6000L)};
            }
            this.lines = resolvedLines;
            this.placeholderOnly = instrumental;
            this.hasTranslation = scanForTranslation(this.lines);
            this.playing = playing;
            this.anchorElapsedMs = anchorElapsedMs;
            this.anchorPositionMs = anchorPositionMs;
            this.stamp = stamp;
        }

        private static boolean scanForTranslation(TimedLine[] lines) {
            for (TimedLine line : lines) {
                if (line != null && line.translation != null && !line.translation.trim().isEmpty()) {
                    return true;
                }
            }
            return false;
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
            "", "", null, 0xFF7C5CFF, 0xFF09090B, 1f, "cover", null, null, "sonnet",
            DEFAULT_BLUR, true, true, 0L, new TimedLine[0], false, 0L, 0L, 0L);

    private static volatile Snapshot current = EMPTY;

    /** 最近一次写进磁盘的自选图，用来跳过重复写入。 */
    private static String lastStoredImage = null;
    private static String lastStoredKey = null;
    /** 当前歌词字体的 key。字体不随换歌变化，所以只在 setFont 时更新。 */
    private static String currentFontKey = null;

    /**
     * 歌词动画实验台里那一整套可调项（每个模式十几二十个，十几个模式合计一百多项）。
     *
     * 为什么不逐个做成 Snapshot 的字段：每加一项就要改构造器、七个调用点、还有落盘格式。
     * 这里用一张扁平的键值表：Web 侧每次只下发**当前生效那个模式**自己的字段名，
     * 原生按表名取值。同名冲突不存在 —— 同一时刻只有一个模式在渲染。
     */
    private static volatile java.util.Map<String, Float> tuning =
            java.util.Collections.emptyMap();

    public static java.util.Map<String, Float> tuning() {
        return tuning;
    }

    /** null 表示「这次没带配置来」，沿用上一次的。 */
    private static java.util.Map<String, Float> resolveTuning(java.util.Map<String, Float> incoming) {
        return incoming == null ? tuning : java.util.Collections.unmodifiableMap(incoming);
    }

    public static Snapshot get() {
        return current;
    }

    /** 播放位置推进：只更新锚点，不动时间轴，也不落盘。 */
    public static void setAnchor(long positionMs, boolean playing) {
        Snapshot previous = current;
        current = new Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                previous.baseColor, previous.motion, previous.backgroundMode, previous.image,
                previous.font, previous.visualizerMode, previous.blur, previous.showProgress,
                previous.showTranslation, previous.durationMs, previous.lines, playing,
                SystemClock.elapsedRealtime(), positionMs, previous.stamp);
    }

    /**
     * 换歌词字体。base64 为空表示清除、回落到系统 sans-serif。
     * 字体不进 `publish`：它跟歌无关，没必要每次换歌都跟着走一遍。
     */
    public static void setLyricsFont(Context context, String fontBase64) {
        currentFontKey = fontBase64 == null || fontBase64.trim().isEmpty()
                ? WallpaperLyricsFont.store(context, null)
                : WallpaperLyricsFont.store(context, fontBase64);
        applyFontKey();
    }

    /** 原生已经把字体文件拷好了（系统文件选择器路径），这里只把新 key 同步进状态。 */
    public static void refreshLyricsFont(Context context) {
        currentFontKey = WallpaperLyricsFont.key(context);
        applyFontKey();
    }

    /**
     * 走系统文件选择器：原生自己把 URI 指向的文件拷进私有目录，再同步 key。
     * 返回拷贝后的 key，null = 没拷成功（用户取消 / 选中文件读不了 / 不是合法字体）。
     */
    public static String setLyricsFontFromUri(Context context, android.net.Uri uri) {
        currentFontKey = WallpaperLyricsFont.copyFrom(context, uri);
        applyFontKey();
        return currentFontKey;
    }

    private static void applyFontKey() {
        Snapshot previous = current;
        current = new Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                previous.baseColor, previous.motion, previous.backgroundMode, previous.image,
                currentFontKey, previous.visualizerMode, previous.blur, previous.showProgress,
                previous.showTranslation, previous.durationMs, previous.lines, previous.playing,
                previous.anchorElapsedMs, previous.anchorPositionMs, previous.stamp);
    }

    public static void publish(Context context, String title, String artist, String cover,
                               int accent, int baseColor, float motion, String backgroundMode,
                               String imageBase64, String visualizerMode, float blur,
                               Boolean showProgress, Boolean showTranslation, long durationMs,
                               TimedLine[] lines, java.util.Map<String, Float> tuningPatch,
                               long positionMs, boolean playing) {
        Snapshot previous = current;
        tuning = resolveTuning(tuningPatch);
        Snapshot next = new Snapshot(
                title != null ? title : previous.title,
                artist != null ? artist : previous.artist,
                cover != null ? cover : previous.cover,
                accent != 0 ? accent : previous.accent,
                baseColor != 0 ? baseColor : previous.baseColor,
                motion > 0f ? motion : previous.motion,
                backgroundMode != null ? backgroundMode : previous.backgroundMode,
                storeImage(context, imageBase64),
                previous.font,
                visualizerMode != null ? visualizerMode : previous.visualizerMode,
                blur >= 0f ? blur : previous.blur,
                showProgress != null ? showProgress : previous.showProgress,
                showTranslation != null ? showTranslation : previous.showTranslation,
                durationMs >= 0L ? durationMs : previous.durationMs,
                lines != null ? lines : previous.lines,
                playing,
                SystemClock.elapsedRealtime(),
                positionMs,
                System.currentTimeMillis());
        current = next;
        if (context != null && (lines != null || tuningPatch != null)) {
            persist(context, next);
        }
    }

    /** 只改外观（背景模式 / 自选图 / 可视化风格），不动时间轴，也避免整条时间轴重新落盘。 */
    public static void setAppearance(Context context, String backgroundMode, String imageBase64,
                                     String visualizerMode, float blur, Boolean showProgress,
                                     Boolean showTranslation, long durationMs,
                                     java.util.Map<String, Float> tuningPatch) {
        Snapshot previous = current;
        tuning = resolveTuning(tuningPatch);
        Snapshot next = new Snapshot(previous.title, previous.artist, previous.cover,
                previous.accent, previous.baseColor, previous.motion,
                backgroundMode != null ? backgroundMode : previous.backgroundMode,
                storeImage(context, imageBase64),
                previous.font,
                visualizerMode != null ? visualizerMode : previous.visualizerMode,
                blur >= 0f ? blur : previous.blur,
                showProgress != null ? showProgress : previous.showProgress,
                showTranslation != null ? showTranslation : previous.showTranslation,
                durationMs >= 0L ? durationMs : previous.durationMs,
                previous.lines, previous.playing, previous.anchorElapsedMs,
                previous.anchorPositionMs, previous.stamp);
        current = next;
        if (context != null) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_BACKGROUND, next.backgroundMode)
                    .putString(KEY_VISUALIZER, next.visualizerMode)
                    .putInt(KEY_BASE, next.baseColor)
                    .putInt(KEY_ACCENT, next.accent)
                    .putFloat(KEY_MOTION, next.motion)
                    .putFloat(KEY_BLUR, next.blur)
                    .putBoolean(KEY_PROGRESS, next.showProgress)
                    .putBoolean(KEY_TRANSLATION, next.showTranslation)
                    .putString(KEY_TUNING, encodeTuning(tuning))
                    .putLong(KEY_DURATION, next.durationMs)
                    .apply();
        }
    }

    public static void clear(Context context) {
        current = EMPTY;
        if (context != null) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        }
        // 关掉推送不等于放弃选好的图：下次开回来还要用。图只在用户主动清除时才删。
    }

    /** 忘掉自选图（用户点「清除图片」）。 */
    public static void clearBackgroundImage(Context context) {
        lastStoredImage = null;
        lastStoredKey = null;
        WallpaperBackgroundImage.store(context, null);
        Snapshot previous = current;
        current = new Snapshot(previous.title, previous.artist, previous.cover, previous.accent,
                previous.baseColor, previous.motion, previous.backgroundMode, null,
                previous.font, previous.visualizerMode, previous.blur, previous.showProgress,
                previous.showTranslation, previous.durationMs, previous.lines, previous.playing,
                previous.anchorElapsedMs, previous.anchorPositionMs, previous.stamp);
    }

    /**
     * 把 Web 侧给的自选图写成文件，只在图真的换了时才动磁盘 ——
     * `publish` 每次换歌都会走一遍，重复写一张几百 KB 的图没意义。
     */
    private static String storeImage(Context context, String base64) {
        if (context == null) {
            return lastStoredKey;
        }
        if (base64 == null) {
            // 没带图来：图可能来自上一次进程（文件还在），也可能用户已经清掉了。
            // 这里不删文件，只是沿用磁盘现状，避免把上一轮的图误删。
            if (lastStoredImage == null) {
                lastStoredKey = WallpaperBackgroundImage.key(context);
            }
            return lastStoredKey;
        }
        if (base64.equals(lastStoredImage) && lastStoredKey != null) {
            return lastStoredKey;
        }
        lastStoredImage = base64;
        lastStoredKey = WallpaperBackgroundImage.store(context, base64);
        return lastStoredKey;
    }

    /**
     * 进程被拉起时把落盘的时间轴与外观读回来。
     *
     * **只在内存还是空的时候才恢复。** 壁纸服务由系统按需绑定，绑定时机可能晚于应用已经推过
     * 一轮状态 —— 那时无条件覆盖会把刚设好的自选背景图冲掉，表现就是「选了图还是纯色」。
     * 冷启动时内存必然是 EMPTY，恢复如期发生；热路径则一律不打断现有状态。
     */
    public static void restore(Context context) {
        if (context == null || current != EMPTY) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!prefs.contains(KEY_BACKGROUND) && !prefs.contains(KEY_TIMELINE)) {
            return;
        }
        String joined = prefs.getString(KEY_TIMELINE, null);
        String[] encoded = joined == null || joined.isEmpty()
                ? new String[0]
                : joined.split(LINE_SEPARATOR, -1);
        TimedLine[] lines = new TimedLine[encoded.length];
        for (int i = 0; i < encoded.length; i++) {
            String[] fields = encoded[i].split(FIELD_SEPARATOR, -1);
            long start = fields.length > 0 ? parseLong(fields[0]) : 0L;
            long end = fields.length > 1 ? parseLong(fields[1]) : 0L;
            String text = fields.length > 2 ? fields[2] : "";
            // 第 4 段是翻译，空串表示「这一行没有翻译」。
            String translation = fields.length > 3 && !fields[3].isEmpty() ? fields[3] : null;
            lines[i] = new TimedLine(text, start, end, translation);
        }
        tuning = decodeTuning(prefs.getString(KEY_TUNING, null));
        current = new Snapshot(
                prefs.getString(KEY_TITLE, ""),
                prefs.getString(KEY_ARTIST, ""),
                null,
                prefs.getInt(KEY_ACCENT, EMPTY.accent),
                prefs.getInt(KEY_BASE, EMPTY.baseColor),
                prefs.getFloat(KEY_MOTION, EMPTY.motion),
                prefs.getString(KEY_BACKGROUND, "cover"),
                WallpaperBackgroundImage.key(context),
                WallpaperLyricsFont.key(context),
                prefs.getString(KEY_VISUALIZER, "sonnet"),
                prefs.getFloat(KEY_BLUR, DEFAULT_BLUR),
                prefs.getBoolean(KEY_PROGRESS, true),
                prefs.getBoolean(KEY_TRANSLATION, true),
                prefs.getLong(KEY_DURATION, 0L),
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
                    .append(line.text.replace(LINE_SEPARATOR, " ").replace(FIELD_SEPARATOR, " "))
                    .append(FIELD_SEPARATOR)
                    .append(line.translation == null ? "" : line.translation
                            .replace(LINE_SEPARATOR, " ").replace(FIELD_SEPARATOR, " "));
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
                .putString(KEY_VISUALIZER, snapshot.visualizerMode)
                .putFloat(KEY_BLUR, snapshot.blur)
                .putBoolean(KEY_PROGRESS, snapshot.showProgress)
                .putBoolean(KEY_TRANSLATION, snapshot.showTranslation)
                .putString(KEY_TUNING, encodeTuning(tuning))
                .putLong(KEY_DURATION, snapshot.durationMs)
                .putLong(KEY_STAMP, snapshot.stamp)
                .apply();
    }

    private static String encodeTuning(java.util.Map<String, Float> values) {
        if (values == null || values.isEmpty()) {
            return "";
        }
        StringBuilder joined = new StringBuilder();
        for (java.util.Map.Entry<String, Float> entry : values.entrySet()) {
            if (joined.length() > 0) {
                joined.append(TUNING_PAIR_SEPARATOR);
            }
            joined.append(entry.getKey())
                    .append(TUNING_VALUE_SEPARATOR)
                    .append(entry.getValue());
        }
        return joined.toString();
    }

    private static java.util.Map<String, Float> decodeTuning(String encoded) {
        if (encoded == null || encoded.isEmpty()) {
            return java.util.Collections.emptyMap();
        }
        java.util.Map<String, Float> values = new java.util.HashMap<>();
        for (String pair : encoded.split(TUNING_PAIR_SEPARATOR, -1)) {
            int split = pair.indexOf(TUNING_VALUE_SEPARATOR);
            if (split <= 0) {
                continue;
            }
            try {
                values.put(pair.substring(0, split),
                        Float.parseFloat(pair.substring(split + 1)));
            } catch (NumberFormatException error) {
                // 单个值坏了不影响其余配置项。
            }
        }
        return java.util.Collections.unmodifiableMap(values);
    }

    private static long parseLong(String value) {
        try {
            return Long.parseLong(value);
        } catch (NumberFormatException error) {
            return 0L;
        }
    }
}
