package top.izuna.foliamajor.wallpaper;

import android.content.Context;
import android.content.SharedPreferences;

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
 */
public final class WallpaperThemePalette {
    private static final String PREFS = "folia_wallpaper_theme_palette";
    private static final String KEY_PRIMARY = "primary";
    private static final String KEY_SECONDARY = "secondary";
    private static final String KEY_THEME_JSON = "theme_json";

    private WallpaperThemePalette() {}

    /**
     * null = 这次没带，**保持原值**；空串 = 明确清除；非空 = 覆盖。
     *
     * 为什么要区分：`publish` 是心跳也在走的入口（播放暂停、跳变校正都只带
     * positionMs/playing），那些调用里主题字段全部缺席 —— 如果把缺席当成清除，
     * 换歌时刚存好的主题在下一个 500ms 心跳里就被抹掉了，
     * 叠层随即退回内置主题，表现正是「AI 主题在桌面叠层上没生效」。
     */
    public static void save(Context context, String primary, String secondary, String themeJson) {
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        boolean changed = false;
        if (primary != null) {
            if (primary.isEmpty()) editor.remove(KEY_PRIMARY);
            else editor.putString(KEY_PRIMARY, primary);
            changed = true;
        }
        if (secondary != null) {
            if (secondary.isEmpty()) editor.remove(KEY_SECONDARY);
            else editor.putString(KEY_SECONDARY, secondary);
            changed = true;
        }
        if (themeJson != null) {
            if (themeJson.isEmpty()) editor.remove(KEY_THEME_JSON);
            else editor.putString(KEY_THEME_JSON, themeJson);
            changed = true;
        }
        // 三个字段都没带就别动盘：心跳一次都不落盘，省掉无谓的写放大。
        if (changed) editor.apply();
    }

    /** 下标 0 = 主文本色，1 = 次色；没有就是空串。 */
    public static String[] read(Context context) {
        String[] result = { "", "" };
        if (context == null) return result;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        result[0] = prefs.getString(KEY_PRIMARY, "");
        result[1] = prefs.getString(KEY_SECONDARY, "");
        return result;
    }

    /** App 当前整份主题的 JSON（含 wordColors / lyricsIcons 这类非颜色字段）。没有就是空串。 */
    public static String readThemeJson(Context context) {
        if (context == null) return "";
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String value = prefs.getString(KEY_THEME_JSON, "");
        return value == null ? "" : value;
    }
}
