package top.izuna.foliamajor.lyricon

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

import org.json.JSONException
import org.json.JSONObject

// Kotlin 转换注：集合不写 `import java.util.List` / `java.util.ArrayList` —— 那样它们在
// Kotlin 里会变成与 kotlin.collections 互不相通的 Java 名义类型。用默认导入的版本。
import io.github.proify.lyricon.lyric.model.RichLyricLine

/**
 * 状态栏歌词（Lyricon）的 Web 侧入口。
 *
 * 与歌词壁纸同一个套路：换歌时把整条时间轴交过去，播放中只推进度。
 * 原生那边不自己按墙钟推算 —— 中心服务有自己的读取间隔，只需要一个尽量新的位置。
 */
@CapacitorPlugin(name = "FoliaLyricon")
class FoliaLyriconPlugin : Plugin() {

    @PluginMethod
    fun setEnabled(call: PluginCall) {
        val enabled: Boolean? = call.getBoolean("enabled")
        if (enabled == null) {
            call.reject("enabled is required")
            return
        }
        val ok = FoliaLyricon.setEnabled(context, enabled)
        val result = JSObject()
        result.put("enabled", FoliaLyricon.isEnabled(context))
        result.put("connected", ok && FoliaLyricon.isConnected())
        call.resolve(result)
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val result = JSObject()
        result.put("enabled", FoliaLyricon.isEnabled(context))
        result.put("connected", FoliaLyricon.isConnected())
        call.resolve(result)
    }

    /** 换歌：歌名、歌手、时长与整条歌词时间轴。 */
    @PluginMethod
    fun publish(call: PluginCall) {
        val durationSeconds: Float? = call.getFloat("durationMs")
        val lineArray = call.getArray("lines")
        val lines = ArrayList<RichLyricLine>()
        if (lineArray != null) {
            for (i in 0 until lineArray.length()) {
                val line = decodeLine(lineArray.optJSONObject(i))
                if (line != null) {
                    lines.add(line)
                }
            }
        }
        val ok = FoliaLyricon.publish(
                context,
                call.getString("id"),
                call.getString("title"),
                call.getString("artist"),
                if (durationSeconds == null) 0L else durationSeconds.toDouble().toLong(),
                lines)
        val result = JSObject()
        result.put("ok", ok)
        result.put("connected", FoliaLyricon.isConnected())
        call.resolve(result)
    }

    /**
     * 推一次位置。
     *
     * `continuous` 表示「这只是正常播放的延续，不是跳转」：心跳 / 重锚走这条路，
     * 原生就不会把它当成一次 seek（见 FoliaLyricon.applyLocked 的 allowSeek）。
     */
    @PluginMethod
    fun setPosition(call: PluginCall) {
        val positionSeconds: Float? = call.getFloat("positionMs")
        val playing: Boolean? = call.getBoolean("playing")
        val continuous: Boolean? = call.getBoolean("continuous")
        val ok = FoliaLyricon.setPosition(
                context,
                if (positionSeconds == null) 0L else positionSeconds.toDouble().toLong(),
                playing != null && playing,
                continuous != null && continuous)
        val result = JSObject()
        result.put("ok", ok)
        call.resolve(result)
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        FoliaLyricon.clear(context)
        call.resolve()
    }

    companion object {

        /**
         * 一条歌词行。SDK 的 RichLyricLine 有 12 个参数，Kotlin 的默认参数对 Java 不可见，
         * 所以不用的那几个（逐字、双行、罗马音）一律传空列表 / null。
         */
        private fun decodeLine(entry: JSONObject?): RichLyricLine? {
            if (entry == null) return null
            val text = entry.optString("text", "")
            if (text.isEmpty()) return null
            val start = entry.optLong("start", 0L)
            val end = entry.optLong("end", 0L)
            // optString 对 JSONObject.NULL 返回的是字符串 "null" 而不是 Java 的 null，
            // 直接传下去状态栏就会真的显示「null」。所以这里按「空或字面 null 都算没有」处理：
            // 没有翻译的行走单行，而不是把 "null" 当第二行推出去。
            val raw: String? = entry.optString("translation", null)
            val translation = if (raw == null || raw.isEmpty() || "null" == raw) null else raw
            try {
                // duration 是 begin/end 之外的第三个独立字段，不是 SDK 自己算的。
                // 一直传 0 的话，中心服务拿它算「这一行唱到哪了」就是除以 0，
                // 行内高亮的位置每帧都乱跳 —— 这就是状态栏歌词抽搐的来源。
                return RichLyricLine(
                        start,
                        Math.max(start, end),
                        Math.max(0L, end - start),
                        false,
                        null,
                        text,
                        ArrayList(),
                        null,
                        ArrayList(),
                        translation,
                        ArrayList(),
                        null)
            } catch (error: Throwable) {
                return null
            }
        }
    }
}
