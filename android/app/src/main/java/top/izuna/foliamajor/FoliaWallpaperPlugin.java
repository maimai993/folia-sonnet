package top.izuna.foliamajor;

import android.app.WallpaperManager;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import top.izuna.foliamajor.wallpaper.LyricsWallpaperService;
import top.izuna.foliamajor.wallpaper.WallpaperLyricsState;

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
                    timeline[i] = new WallpaperLyricsState.TimedLine(text, start, end);
                } catch (JSONException error) {
                    // 单行解析失败不影响整条时间轴。
                }
            }
        }

        Float positionSeconds = call.getFloat("positionMs");
        long positionMs = positionSeconds == null ? -1L : (long) (double) positionSeconds;
        Boolean playing = call.getBoolean("playing");
        boolean isPlaying = playing != null && playing;

        if (timeline == null && positionMs >= 0L) {
            // 常规心跳：只挪时间锚点，不碰时间轴，也不落盘。
            WallpaperLyricsState.setAnchor(positionMs, isPlaying);
        } else {
            Float motion = call.getFloat("motion");
            WallpaperLyricsState.publish(
                    getContext(),
                    call.getString("title"),
                    call.getString("artist"),
                    call.getString("cover"),
                    parseColor(call.getString("accent")),
                    parseColor(call.getString("backgroundColor")),
                    motion == null ? 0f : motion,
                    call.getString("background"),
                    timeline,
                    Math.max(0L, positionMs),
                    isPlaying);
        }
        call.resolve();
    }

    /** 只改背景模式：cover = 模糊封面，color = 只用主题色渐变。 */
    @PluginMethod
    public void setBackground(PluginCall call) {
        String mode = call.getString("mode");
        WallpaperLyricsState.setBackgroundMode(getContext(), mode);
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
