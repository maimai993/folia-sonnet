package top.izuna.foliamajor;

import android.app.Activity;
import android.app.WallpaperManager;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.Iterator;

import top.izuna.foliamajor.wallpaper.LyricsWallpaperService;
import top.izuna.foliamajor.wallpaper.WallpaperBackgroundVideo;
import top.izuna.foliamajor.wallpaper.WallpaperLyricsFont;
import top.izuna.foliamajor.wallpaper.WallpaperLyricsState;
import top.izuna.foliamajor.wallpaper.WallpaperOverlay;
import top.izuna.foliamajor.wallpaper.WallpaperThemePalette;

/**
 * 歌词壁纸的 Web 侧入口。
 *
 * 应用把「当前行 + 行内进度」推进来，壁纸那边直接读同一份进程内状态。
 * 每 100ms 一次的高频推送只走内存，慢字段（歌名/歌词行）另外落盘，
 * 这样即使壁纸先于应用被系统拉起也不会是一片空白。
 */
@CapacitorPlugin(name = "FoliaWallpaper")
public class FoliaWallpaperPlugin extends Plugin {

    @PluginMethod
    public void publish(PluginCall call) {
        WallpaperLyricsState.TimedLine[] timeline = null;
        JSArray timelineArray = call.getArray("timeline");
        if (timelineArray != null) {
            int count = timelineArray.length();
            timeline = new WallpaperLyricsState.TimedLine[count];
            for (int i = 0; i < count; i++) {
                timeline[i] = new WallpaperLyricsState.TimedLine("", 0L, 0L);
                try {
                    org.json.JSONObject entry = timelineArray.getJSONObject(i);
                    long start = entry.optLong("start", 0L);
                    long end = entry.optLong("end", 0L);
                    String text = entry.optString("text", "");
                    String translation = readTranslation(entry);
                    timeline[i] = new WallpaperLyricsState.TimedLine(text, start, end, translation);
                } catch (JSONException error) {
                    // 单行解析失败不影响整条时间轴。
                }
            }
        }

        Float positionSeconds = call.getFloat("positionMs");
        long positionMs = positionSeconds == null ? -1L : (long) (double) positionSeconds;
        Boolean playing = call.getBoolean("playing");
        boolean isPlaying = playing != null && playing;
        Boolean showTranslation = call.getBoolean("translation");
        java.util.Map<String, Float> tuning = readTuning(call.getObject("tuning"));

        /*
         * 完整主题（含文本主色 / 次色）单独下发。
         *
         * 叠层那份页面是另一个 WebView，它的主题是拿内置主题打底、只覆盖高亮色和底色
         * 搭出来的 —— 主文本色因此永远是内置主题的。App 里换成 AI / 自定义主题之后，
         * 叠层的歌词颜色一点没变（「AI 主题在桌面叠层上不生效」）。
         * 这几个值不走 Snapshot（那串构造参数改动面太大），单独存一张小表。
         *
         * themeJson 是整份主题的序列化：AI 主题的辨识度往往不在四个颜色上，而在
         * wordColors（指定词上色）和 lyricsIcons（可视化里飘的图标）这类字段里，
         * 按字段一个个补永远补不全，所以整份推下来。
         *
         * 注意 save 的语义是「null = 不动」：这条入口心跳也在走（播放暂停 / 跳变
         * 只带 positionMs），那些调用里主题字段全部缺席，绝不能当成清除。
         */
        WallpaperThemePalette.save(
            getContext(),
            call.getString("primaryColor"),
            call.getString("secondaryColor"),
            call.getString("themeJson"));

        if (timeline == null && positionMs >= 0L) {
            // 常规心跳：只挪时间锚点，不碰时间轴，也不落盘。
            // 开关本身走 setAppearance，心跳不带时间轴时不重复写盘。
            WallpaperLyricsState.setAnchor(positionMs, isPlaying);
        } else {
            Float motion = call.getFloat("motion");
            Float blur = call.getFloat("blur");
            Float durationSeconds = call.getFloat("durationMs");
            WallpaperLyricsState.publish(
                    getContext(),
                    call.getString("title"),
                    call.getString("artist"),
                    call.getString("cover"),
                    parseColor(call.getString("accent")),
                    parseColor(call.getString("backgroundColor")),
                    motion == null ? 0f : motion,
                    call.getString("background"),
                    call.getString("image"),
                    call.getString("visualizer"),
                    blur == null ? -1f : blur,
                    call.getBoolean("progress"),
                    showTranslation,
                    durationSeconds == null ? -1L : (long) (double) durationSeconds,
                    timeline,
                    tuning,
                    Math.max(0L, positionMs),
                    isPlaying);
        }
        call.resolve();
    }

    /**
     * 音乐锁屏的自诊断。
     *
     * 真机上 logcat 基本取不到（很多 ROM 根本不给读），而「后台启动 Activity 被系统拦」
     * 又是**静默**的 —— 不抛异常、不返回失败码。没有这一路反馈，用户只能对着一个
     * 没反应的开关猜原因。设置页拿到它就能写明白：是还没到时机，还是被系统拦了
     * （需要 ROM 的「锁屏显示 / 后台弹出界面」权限）。
     */
    @PluginMethod
    public void getLockScreenStatus(PluginCall call) {
        WallpaperOverlay.LockScreenStatus status =
                WallpaperOverlay.shared(getContext()).lockScreenStatus();
        JSObject result = new JSObject();
        result.put("started", status.started);
        result.put("blocked", status.blocked);
        result.put("hosted", status.hosted);
        result.put("attempts", status.attempts);
        if (status.lastError != null) {
            result.put("error", status.lastError);
        }
        if (status.lastExit != null) {
            result.put("lastExit", status.lastExit);
        }
        call.resolve(result);
    }

    /** 只改外观（背景模式 / 自选背景图 / 可视化风格），不动时间轴。 */
    @PluginMethod
    public void setAppearance(PluginCall call) {
        Float blur = call.getFloat("blur");
        Float durationSeconds = call.getFloat("durationMs");
        WallpaperLyricsState.setAppearance(
                getContext(),
                call.getString("background"),
                call.getString("image"),
                call.getString("visualizer"),
                blur == null ? -1f : blur,
                call.getBoolean("progress"),
                call.getBoolean("translation"),
                durationSeconds == null ? -1L : (long) (double) durationSeconds,
                readTuning(call.getObject("tuning")));
        // 叠层总开关打开就由应用进程托管同一份叠层实例（见 WallpaperOverlay.shared）：
        // 这样它不再要求系统的动态壁纸是我们 —— 没设壁纸、甚至壁纸是别人的静态图，
        // 桌面 / 锁屏上照样能挂这一层。
        java.util.Map<String, Float> tuning = WallpaperLyricsState.tuning();
        Float overlayEnabled = tuning.get("wp.overlayEnabled");
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(getContext())
                .setAppDriven(overlayEnabled == null || overlayEnabled >= 0.5f);
        call.resolve();
    }

    /**
     * 壁纸歌词字体。传 null / 空串表示清除、回落到系统 sans-serif。
     * 字体文件几 MB，桥上过一趟不小，但只在用户真的换字体时才走一次。
     */
    @PluginMethod
    public void setFont(PluginCall call) {
        WallpaperLyricsState.setLyricsFont(getContext(), call.getString("font"));
        call.resolve();
    }

    /**
     * 打开系统文件选择器挑一个 .ttf / .otf 给壁纸歌词用。
     *
     * 为什么不走 base64：一个中文字体动辄好几 MB，转 base64 过桥既慢又吃内存，
     * 所以原生自己拿到 URI 拷进私有目录，Web 侧只拿到「成没成」。
     */
    @PluginMethod
    public void pickFont(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        // 各家文件管理器给字体报的 MIME 很乱（font/ttf、application/x-font-ttf，
        // 甚至干脆是 application/octet-stream），所以主类型放宽、只用 EXTRA 做倾向性过滤。
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "font/ttf", "font/otf", "font/ttx", "font/sfnt",
                "application/font-sfnt", "application/x-font-ttf", "application/x-font-otf",
                "application/vnd.ms-opentype"});
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "handleFontPicked");
    }

    @ActivityCallback
    private void handleFontPicked(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        boolean picked = false;
        boolean rejected = false;
        if (result != null && result.getResultCode() == Activity.RESULT_OK) {
            Intent data = result.getData();
            Uri uri = data == null ? null : data.getData();
            if (uri != null) {
                try {
                    getContext().getContentResolver()
                            .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Throwable ignored) {
                    // 拿不到长期权限也没关系：文件是一次性拷进私有目录的。
                }
                picked = WallpaperLyricsState.setLyricsFontFromUri(getContext(), uri) != null;
                // 选了文件、但那不是个能用的字体 —— 跟「用户取消」要区分开，UI 得给出提示。
                rejected = !picked;
            }
        }
        JSObject out = new JSObject();
        out.put("picked", picked);
        out.put("rejected", rejected);
        call.resolve(out);
    }

    /** 壁纸歌词当前有没有自选字体。UI 用它决定按钮显示「更换」还是「选择」。 */
    @PluginMethod
    public void getFont(PluginCall call) {
        // 状态里的 font 只在应用推过一轮之后才有；冷启动时以磁盘上的文件为准。
        String font = WallpaperLyricsState.get().font;
        if (font == null) {
            font = WallpaperLyricsFont.key(getContext());
        }
        JSObject out = new JSObject();
        out.put("font", font != null);
        call.resolve(out);
    }

    /** 用户主动「清除图片」：删掉磁盘上的副本。关掉推送开关不删，下次开回来还要用。 */
    @PluginMethod
    public void clearImage(PluginCall call) {
        WallpaperLyricsState.clearBackgroundImage(getContext());
        call.resolve();
    }

    /**
     * 打开系统文件选择器挑一个视频当壁纸背景。
     *
     * 视频动辄几十 MB，绝不过桥：原生拿到 URI 自己拷进私有目录，
     * Web 侧只拿到「成没成」（见 WallpaperBackgroundVideo 为什么必须拷一份）。
     */
    @PluginMethod
    public void pickVideo(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "handleVideoPicked");
    }

    @ActivityCallback
    private void handleVideoPicked(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        boolean picked = false;
        if (result != null && result.getResultCode() == Activity.RESULT_OK) {
            Intent data = result.getData();
            Uri uri = data == null ? null : data.getData();
            if (uri != null) {
                try {
                    getContext().getContentResolver()
                            .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Throwable ignored) {
                    // 拷贝是一次性的，拿不到长期权限没关系。
                }
                picked = WallpaperBackgroundVideo.store(getContext(), uri) != null;
            }
        }
        JSObject out = new JSObject();
        out.put("picked", picked);
        // 选了文件却用不了（太大 / 读不出来）：要跟「用户取消」区分开，UI 得给提示。
        out.put("rejected", !picked && result != null
                && result.getResultCode() == Activity.RESULT_OK);
        call.resolve(out);
    }

    /** 有没有上传过视频背景：决定按钮显示「上传」还是「更换 / 清除」。 */
    @PluginMethod
    public void getVideo(PluginCall call) {
        JSObject out = new JSObject();
        out.put("has", WallpaperBackgroundVideo.key(getContext()) != null);
        call.resolve(out);
    }

    @PluginMethod
    public void clearVideo(PluginCall call) {
        WallpaperBackgroundVideo.clear(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getBackground(PluginCall call) {
        JSObject result = new JSObject();
        result.put("mode", WallpaperLyricsState.get().backgroundMode);
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        WallpaperLyricsState.clear(getContext());
        call.resolve();
    }

    /**
     * 壁纸那层「可视化叠层」要画在壁纸之上，必须有 SYSTEM_ALERT_WINDOW。
     *
     * 没拿到权限时叠层是**静默不启用**的（退回原生 GLES 渲染），
     * 用户只会看到「壁纸和以前一样」，完全想不到是需要授权 ——
     * 所以设置页得能主动查这个状态并一键跳去授权。
     */
    @PluginMethod
    public void hasOverlayPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .canOverlay(getContext()));
        call.resolve(result);
    }

    /** 跳到系统的「显示在其他应用上层」授权页，直接定位到本应用。 */
    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Throwable error) {
            call.reject("无法打开授权页面");
        }
    }

    /** 当前系统壁纸是不是我们这个。UI 用它决定按钮显示「设置」还是「已启用」。 */
    @PluginMethod
    public void isActive(PluginCall call) {
        JSObject result = new JSObject();
        result.put("active", isOurWallpaperActive());
        call.resolve(result);
    }

    /** 打开系统壁纸选择器，并直接定位到歌词壁纸。 */
    @PluginMethod
    public void openPicker(PluginCall call) {
        boolean opened = openLiveWallpaperPicker();
        JSObject result = new JSObject();
        result.put("opened", opened);
        call.resolve(result);
    }

    private boolean openLiveWallpaperPicker() {
        ComponentName component = new ComponentName(
                getContext().getPackageName(), LyricsWallpaperService.class.getName());
        try {
            Intent intent = new Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER);
            intent.putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, component);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (Throwable error) {
            // 少数 ROM 没有实现上面那个 action，退回老的选择器入口。
            try {
                Intent intent = new Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                return true;
            } catch (Throwable fallbackError) {
                return false;
            }
        }
    }

    private boolean isOurWallpaperActive() {
        WallpaperManager manager = WallpaperManager.getInstance(getContext());
        android.app.WallpaperInfo info = manager.getWallpaperInfo();
        return info != null
                && getContext().getPackageName().equals(info.getPackageName());
    }

    /**
     * 读一行的翻译。没有翻译的行一律返回 null（不是空串）——
     * 空串会让渲染侧分不清「没翻译」和「翻译是空的」，从而多画出一条空行。
     */
    private static String readTranslation(org.json.JSONObject entry) {
        String value = entry.optString("translation", null);
        if (value == null || value.isEmpty() || value.equals("null")) {
            return null;
        }
        return value;
    }

    /**
     * 歌词动画实验台的配置。
     *
     * 一律压成 float：布尔开关当 0/1 用，字符串枚举由 Web 侧先转成序号。
     * 表里只放**当前生效那个模式**的字段，所以 native 那边按字段名取值不会有歧义。
     * 拿不到（没传 / 不是数字）的字段直接跳过 —— 缺项时渲染器会退回默认值。
     */
    private static java.util.Map<String, Float> readTuning(JSObject tuning) {
        if (tuning == null) {
            return null;
        }
        java.util.Map<String, Float> values = new java.util.HashMap<>();
        java.util.Iterator<String> keys = tuning.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = tuning.opt(key);
            if (value instanceof Number) {
                values.put(key, ((Number) value).floatValue());
            } else if (value instanceof Boolean) {
                values.put(key, ((Boolean) value) ? 1f : 0f);
            }
        }
        return values;
    }

    private static int parseColor(String value) {
        if (value == null || value.isEmpty()) {
            return 0;
        }
        try {
            return Color.parseColor(value);
        } catch (IllegalArgumentException error) {
            return 0;
        }
    }
}
