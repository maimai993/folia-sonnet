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
        String[] lines = null;
        JSArray linesArray = call.getArray("lines");
        if (linesArray != null) {
            int count = linesArray.length();
            lines = new String[count];
            for (int i = 0; i < count; i++) {
                try {
                    lines[i] = linesArray.getString(i);
                } catch (JSONException error) {
                    lines[i] = "";
                }
            }
        }

        Integer index = call.getInt("index");
        Float progress = call.getFloat("progress");
        Boolean playing = call.getBoolean("playing");
        Boolean slowChanged = call.getBoolean("slowChanged");

        WallpaperLyricsState.publish(
                getContext(),
                call.getString("title"),
                call.getString("artist"),
                lines,
                index == null ? 0 : index,
                progress == null ? 0f : progress,
                playing != null && playing,
                parseAccent(call.getString("accent")),
                call.getString("cover"),
                slowChanged != null && slowChanged);
        call.resolve();
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

    private static int parseAccent(String value) {
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
