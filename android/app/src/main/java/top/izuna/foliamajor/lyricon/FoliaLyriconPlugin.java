package top.izuna.foliamajor.lyricon;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import io.github.proify.lyricon.lyric.model.RichLyricLine;

/**
 * 状态栏歌词（Lyricon）的 Web 侧入口。
 *
 * 与歌词壁纸同一个套路：换歌时把整条时间轴交过去，播放中只推进度。
 * 原生那边不自己按墙钟推算 —— 中心服务有自己的读取间隔，只需要一个尽量新的位置。
 */
@CapacitorPlugin(name = "FoliaLyricon")
public class FoliaLyriconPlugin extends Plugin {

    @PluginMethod
    public void setEnabled(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("enabled is required");
            return;
        }
        boolean ok = FoliaLyricon.setEnabled(getContext(), enabled);
        JSObject result = new JSObject();
        result.put("enabled", FoliaLyricon.isEnabled(getContext()));
        result.put("connected", ok && FoliaLyricon.isConnected());
        call.resolve(result);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", FoliaLyricon.isEnabled(getContext()));
        result.put("connected", FoliaLyricon.isConnected());
        call.resolve(result);
    }

    /** 换歌：歌名、歌手、时长与整条歌词时间轴。 */
    @PluginMethod
    public void publish(PluginCall call) {
        Float durationSeconds = call.getFloat("durationMs");
        JSArray lineArray = call.getArray("lines");
        List<RichLyricLine> lines = new ArrayList<>();
        if (lineArray != null) {
            for (int i = 0; i < lineArray.length(); i++) {
                RichLyricLine line = decodeLine(lineArray.optJSONObject(i));
                if (line != null) {
                    lines.add(line);
                }
            }
        }
        boolean ok = FoliaLyricon.publish(
                getContext(),
                call.getString("id"),
                call.getString("title"),
                call.getString("artist"),
                durationSeconds == null ? 0L : (long) (double) durationSeconds,
                lines);
        JSObject result = new JSObject();
        result.put("ok", ok);
        result.put("connected", FoliaLyricon.isConnected());
        call.resolve(result);
    }

    /**
     * 推一次位置。
     *
     * `continuous` 表示「这只是正常播放的延续，不是跳转」：心跳 / 重锚走这条路，
     * 原生就不会把它当成一次 seek（见 FoliaLyricon.applyLocked 的 allowSeek）。
     */
    @PluginMethod
    public void setPosition(PluginCall call) {
        Float positionSeconds = call.getFloat("positionMs");
        Boolean playing = call.getBoolean("playing");
        Boolean continuous = call.getBoolean("continuous");
        boolean ok = FoliaLyricon.setPosition(
                getContext(),
                positionSeconds == null ? 0L : (long) (double) positionSeconds,
                playing != null && playing,
                continuous != null && continuous);
        JSObject result = new JSObject();
        result.put("ok", ok);
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        FoliaLyricon.clear(getContext());
        call.resolve();
    }

    /**
     * 一条歌词行。SDK 的 RichLyricLine 有 12 个参数，Kotlin 的默认参数对 Java 不可见，
     * 所以不用的那几个（逐字、双行、罗马音）一律传空列表 / null。
     */
    private static RichLyricLine decodeLine(JSONObject entry) {
        if (entry == null) return null;
        String text = entry.optString("text", "");
        if (text.isEmpty()) return null;
        long start = entry.optLong("start", 0L);
        long end = entry.optLong("end", 0L);
        // optString 对 JSONObject.NULL 返回的是字符串 "null" 而不是 Java 的 null，
        // 直接传下去状态栏就会真的显示「null」。所以这里按「空或字面 null 都算没有」处理：
        // 没有翻译的行走单行，而不是把 "null" 当第二行推出去。
        String raw = entry.optString("translation", null);
        String translation = (raw == null || raw.isEmpty() || "null".equals(raw)) ? null : raw;
        try {
            // duration 是 begin/end 之外的第三个独立字段，不是 SDK 自己算的。
            // 一直传 0 的话，中心服务拿它算「这一行唱到哪了」就是除以 0，
            // 行内高亮的位置每帧都乱跳 —— 这就是状态栏歌词抽搐的来源。
            return new RichLyricLine(
                    start,
                    Math.max(start, end),
                    Math.max(0L, end - start),
                    false,
                    null,
                    text,
                    new ArrayList<>(),
                    null,
                    new ArrayList<>(),
                    translation,
                    new ArrayList<>(),
                    null);
        } catch (Throwable error) {
            return null;
        }
    }
}
