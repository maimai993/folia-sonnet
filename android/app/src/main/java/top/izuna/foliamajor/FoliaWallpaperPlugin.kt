package top.izuna.foliamajor

import android.app.Activity
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.net.Uri

import androidx.activity.result.ActivityResult

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

import org.json.JSONException

import top.izuna.foliamajor.wallpaper.LyricsWallpaperService
import top.izuna.foliamajor.wallpaper.WallpaperBackgroundVideo
import top.izuna.foliamajor.wallpaper.WallpaperLyricsFont
import top.izuna.foliamajor.wallpaper.WallpaperLyricsState
import top.izuna.foliamajor.wallpaper.WallpaperOverlay
import top.izuna.foliamajor.wallpaper.WallpaperThemePalette

/**
 * 歌词壁纸的 Web 侧入口。
 *
 * 应用把「当前行 + 行内进度」推进来，壁纸那边直接读同一份进程内状态。
 * 每 100ms 一次的高频推送只走内存，慢字段（歌名/歌词行）另外落盘，
 * 这样即使壁纸先于应用被系统拉起也不会是一片空白。
 */
@CapacitorPlugin(name = "FoliaWallpaper")
class FoliaWallpaperPlugin : Plugin() {

    @PluginMethod
    fun publish(call: PluginCall) {
        var timeline: Array<WallpaperLyricsState.TimedLine>? = null
        val timelineArray = call.getArray("timeline")
        if (timelineArray != null) {
            val count = timelineArray.length()
            val lines = Array(count) { WallpaperLyricsState.TimedLine("", 0L, 0L) }
            for (i in 0 until count) {
                try {
                    val entry: org.json.JSONObject = timelineArray.getJSONObject(i)
                    val start = entry.optLong("start", 0L)
                    val end = entry.optLong("end", 0L)
                    val text = entry.optString("text", "")
                    val translation = readTranslation(entry)
                    lines[i] = WallpaperLyricsState.TimedLine(
                            text, start, end, translation, readWords(entry, start))
                } catch (error: JSONException) {
                    // 单行解析失败不影响整条时间轴。
                }
            }
            timeline = lines
        }

        val positionSeconds: Float? = call.getFloat("positionMs")
        val positionMs = if (positionSeconds == null) -1L else positionSeconds.toDouble().toLong()
        val playing: Boolean? = call.getBoolean("playing")
        val isPlaying = playing != null && playing
        val showTranslation: Boolean? = call.getBoolean("translation")
        val tuning = readTuning(call.getObject("tuning"))

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
            context,
            call.getString("primaryColor"),
            call.getString("secondaryColor"),
            call.getString("themeJson"))

        /*
         * 封面地址单独存一份，不跟着 Snapshot 走。
         * 见 WallpaperLyricsState.lastCoverUrl：base64 那份抓不成功时它不动，
         * 叠层就一直挂着上一首的封面。地址每首必变，是封面更新的可靠依据。
         */
        WallpaperLyricsState.setCoverUrl(call.getString("coverUrl"))

        if (timeline == null && positionMs >= 0L) {
            /*
             * 常规心跳：只挪时间锚点，不碰时间轴，也不落盘。
             * 开关本身走 setAppearance，心跳不带时间轴时不重复写盘。
             *
             * ⚠️ 原生**正在播**的时候这一份要让位。Web 给的是**插值**出来的位置
             * （`nativePlaybackEngine.getPositionSec()` 往后补的那一截），而播放器自己
             * 每 250ms 报一次采样值（见 FoliaNativePlayerPlugin 里写锚点那一段）。
             * 两边交替写同一个锚点，时间轴会被拽得来回抖。
             *
             * ⚠️ 判据是「在播」而不是「手上有一首」：暂停之后原生就不再报位置了，
             * 那时这里必须接着写，否则锚点谁都不给 —— 叠层会按暂停把自己收起来。
             */
            if (!top.izuna.foliamajor.player.FoliaNativePlayerPlugin.isNativePlaying()) {
                WallpaperLyricsState.setAnchor(positionMs, isPlaying)
            } else {
                /*
                 * 位置让位的那一支**不能把 playing 也一起吞掉**。
                 *
                 * 以前这里是整块跳过：原生在播时 Web 推来的一切（包括「我按了暂停」）
                 * 都不落地。于是叠层按 playing=true 一路外推、发现原生不再报位置也没人
                 * 告诉它停 —— 表现就是用户说的「原生在放的时候按暂停，歌词还在走」。
                 * 位置归原生，但「播 / 停」这个事实两边都可能是最先知道的，必须收下。
                 */
                WallpaperLyricsState.setPlaying(isPlaying)
            }
        } else {
            val motion: Float? = call.getFloat("motion")
            val blur: Float? = call.getFloat("blur")
            val durationSeconds: Float? = call.getFloat("durationMs")
            WallpaperLyricsState.publish(
                    context,
                    call.getString("title"),
                    call.getString("artist"),
                    call.getString("cover"),
                    parseColor(call.getString("accent")),
                    parseColor(call.getString("backgroundColor")),
                    if (motion == null) 0f else motion,
                    call.getString("background"),
                    call.getString("image"),
                    call.getString("visualizer"),
                    if (blur == null) -1f else blur,
                    call.getBoolean("progress"),
                    showTranslation,
                    if (durationSeconds == null) -1L else durationSeconds.toDouble().toLong(),
                    timeline,
                    tuning,
                    Math.max(0L, positionMs),
                    isPlaying)
        }
        call.resolve()
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
    fun getLockScreenStatus(call: PluginCall) {
        val status: WallpaperOverlay.LockScreenStatus =
                WallpaperOverlay.shared(context).lockScreenStatus()
        val result = JSObject()
        result.put("started", status.started)
        result.put("blocked", status.blocked)
        result.put("hosted", status.hosted)
        result.put("attempts", status.attempts)
        if (status.lastError != null) {
            result.put("error", status.lastError)
        }
        if (status.lastExit != null) {
            result.put("lastExit", status.lastExit)
        }
        /*
         * ROM 与那几道开关的状态。
         *
         * 只报 started/blocked 的话，用户看到"被拦了"也不知道该去哪儿开 ——
         * ColorOS 要的是「后台弹出界面 + 锁屏显示 + 自启动」，而且悬浮窗权限在
         * Android 14 上是后台启动的主要豁免来源，缺了它多半起不来。
         */
        result.put("rom", top.izuna.foliamajor.lockscreen.RomPermissionGuide.romLabel())
        result.put("overlayGranted",
                top.izuna.foliamajor.lockscreen.RomPermissionGuide.canDrawOverlays(context))
        call.resolve(result)
    }

    /**
     * 把用户送到 ROM 那几道开关对应的页面。
     *
     * target 见 RomPermissionGuide：overlay（悬浮窗）/ background（后台弹出界面 ·
     * 锁屏显示）/ power（自启动 · 耗电）/ details（应用详情，兜底）。
     */
    @PluginMethod
    fun openRomPermission(call: PluginCall) {
        val target = call.getString("target")
        val opened = top.izuna.foliamajor.lockscreen.RomPermissionGuide
                .open(context, target)
        val result = JSObject()
        result.put("opened", opened)
        call.resolve(result)
    }

    /**
     * 叠层最近做了什么（新的在前），给设置页的诊断区看。
     *
     * 和上面那条同源：真机上 logcat 常常取不到，而「叠层放着放着突然消失、然后又淡入」
     * 在代码里至少有四条完全不同的来路（窗口淡出 / 整页重载 / 息屏摘窗口 / 被系统摘窗口），
     * 观感一模一样。把动作连同当时的原因记成一串短行读出来，就不必再靠猜。
     */
    @PluginMethod
    fun getOverlayEventLog(call: PluginCall) {
        val lines = WallpaperOverlay.shared(context).overlayEventLog()
        val array = JSArray()
        for (line in lines) {
            array.put(line)
        }
        val result = JSObject()
        result.put("events", array)
        call.resolve(result)
    }

    /** 只改外观（背景模式 / 自选背景图 / 可视化风格），不动时间轴。 */
    @PluginMethod
    fun setAppearance(call: PluginCall) {
        val blur: Float? = call.getFloat("blur")
        val durationSeconds: Float? = call.getFloat("durationMs")
        WallpaperLyricsState.setAppearance(
                context,
                call.getString("background"),
                call.getString("image"),
                call.getString("visualizer"),
                if (blur == null) -1f else blur,
                call.getBoolean("progress"),
                call.getBoolean("translation"),
                if (durationSeconds == null) -1L else durationSeconds.toDouble().toLong(),
                readTuning(call.getObject("tuning")))
        // 叠层总开关打开就由应用进程托管同一份叠层实例（见 WallpaperOverlay.shared）：
        // 这样它不再要求系统的动态壁纸是我们 —— 没设壁纸、甚至壁纸是别人的静态图，
        // 桌面 / 锁屏上照样能挂这一层。
        val tuning = WallpaperLyricsState.tuning()
        val overlayEnabled: Float? = tuning.get("wp.overlayEnabled")
        top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .shared(context)
                .setAppDriven(overlayEnabled == null || overlayEnabled >= 0.5f)
        // 这两个模式是互斥的两层：跟随样式走 WebView 叠层，精简走原生小悬浮窗。
        // 用户在设置里切样式的那一刻就要生效，所以这里顺手催一次，不等 600ms 巡检。
        val overlay = top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay.shared(context)
        overlay.start()
        /*
         * 叠加模式下「左右 / 宽度」是设置里的滑条管的，而位置只在挂窗口和转屏时才算 ——
         * 少了这一下，滑条拖到头小窗也一动不动。这里每次外观下发都重新摆一次，
         * 滑条边拖边看得到（这就是设置里那几根条要的「实时预览」）。
         */
        overlay.applyOverlayTuning()
        call.resolve()
    }

    /**
     * 壁纸歌词字体。传 null / 空串表示清除、回落到系统 sans-serif。
     * 字体文件几 MB，桥上过一趟不小，但只在用户真的换字体时才走一次。
     */
    @PluginMethod
    fun setFont(call: PluginCall) {
        WallpaperLyricsState.setLyricsFont(context, call.getString("font"))
        // 敲一帧：换字体不产生任何播放 / 动画事件，已经挂着的小窗自己不会重画，
        // 于是「选了字体没反应」要等窗口重挂才看得到。
        top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                .shared(context).invalidateOverlay()
        call.resolve()
    }

    /**
     * 「跟随播放页」：网页把播放页那个字体的字节托管过来（base64）。传 null = 清除。
     *
     * 播放页的字体是网页侧 FontFace 注册的，原生这两层读不到，只能把字节推下来落盘。
     * 字体几 MB，过一趟桥不便宜 —— 只在「来路」切到跟随、或播放页那个字体真的换了才调。
     */
    @PluginMethod
    fun setFollowFont(call: PluginCall) {
        WallpaperLyricsState.setFollowLyricsFont(context, call.getString("font"))
        top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                .shared(context).invalidateOverlay()
        call.resolve()
    }

    /**
     * 开 / 关「精简小窗」的预览。
     *
     * 单独开一条通道，不走 setAppearance 那张 tuning 表 —— 那张表是**落盘**的，
     * 而预览是瞬时状态：落一次盘，只要应用没来得及把它关掉（被杀 / 崩 / 回收），
     * 它就永久卡在开。详见 FloatingLyricsOverlay 里 PREVIEW_LEASE_MS 那段。
     *
     * 前端在设置页期间会定期续约，租约过期自动失效。
     */
    @PluginMethod
    fun setFloatingPreview(call: PluginCall) {
        val on = java.lang.Boolean.TRUE.equals(call.getBoolean("on"))
        top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                .shared(context).setPreview(on)
        call.resolve()
    }

    /**
     * 打开系统文件选择器挑一个 .ttf / .otf 给壁纸歌词用。
     *
     * 为什么不走 base64：一个中文字体动辄好几 MB，转 base64 过桥既慢又吃内存，
     * 所以原生自己拿到 URI 拷进私有目录，Web 侧只拿到「成没成」。
     */
    @PluginMethod
    fun pickFont(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
        intent.addCategory(Intent.CATEGORY_OPENABLE)
        // 各家文件管理器给字体报的 MIME 很乱（font/ttf、application/x-font-ttf，
        // 甚至干脆是 application/octet-stream），所以主类型放宽、只用 EXTRA 做倾向性过滤。
        intent.setType("*/*")
        intent.putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(
                "font/ttf", "font/otf", "font/ttx", "font/sfnt",
                "application/font-sfnt", "application/x-font-ttf", "application/x-font-otf",
                "application/vnd.ms-opentype"))
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivityForResult(call, intent, "handleFontPicked")
    }

    @ActivityCallback
    private fun handleFontPicked(call: PluginCall?, result: ActivityResult?) {
        if (call == null) {
            return
        }
        var picked = false
        var rejected = false
        if (result != null && result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val uri = if (data == null) null else data.getData()
            if (uri != null) {
                try {
                    context.getContentResolver()
                            .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (ignored: Throwable) {
                    // 拿不到长期权限也没关系：文件是一次性拷进私有目录的。
                }
                picked = WallpaperLyricsState.setLyricsFontFromUri(context, uri) != null
                // 选了文件、但那不是个能用的字体 —— 跟「用户取消」要区分开，UI 得给出提示。
                rejected = !picked
            }
        }
        // 同上：挑完字体要让已经挂着的那层小窗当场重画一次。
        top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                .shared(context).invalidateOverlay()
        val out = JSObject()
        out.put("picked", picked)
        out.put("rejected", rejected)
        call.resolve(out)
    }

    /** 壁纸歌词当前有没有自选字体。UI 用它决定按钮显示「更换」还是「选择」。 */
    @PluginMethod
    fun getFont(call: PluginCall) {
        // 状态里的 font 只在应用推过一轮之后才有；冷启动时以磁盘上的文件为准。
        var font: String? = WallpaperLyricsState.get().font
        if (font == null) {
            font = WallpaperLyricsFont.key(context)
        }
        val out = JSObject()
        out.put("font", font != null)
        call.resolve(out)
    }

    /** 用户主动「清除图片」：删掉磁盘上的副本。关掉推送开关不删，下次开回来还要用。 */
    @PluginMethod
    fun clearImage(call: PluginCall) {
        WallpaperLyricsState.clearBackgroundImage(context)
        call.resolve()
    }

    /**
     * 打开系统文件选择器挑一个视频当壁纸背景。
     *
     * 视频动辄几十 MB，绝不过桥：原生拿到 URI 自己拷进私有目录，
     * Web 侧只拿到「成没成」（见 WallpaperBackgroundVideo 为什么必须拷一份）。
     */
    @PluginMethod
    fun pickVideo(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
        intent.addCategory(Intent.CATEGORY_OPENABLE)
        intent.setType("video/*")
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivityForResult(call, intent, "handleVideoPicked")
    }

    @ActivityCallback
    private fun handleVideoPicked(call: PluginCall?, result: ActivityResult?) {
        if (call == null) {
            return
        }
        var picked = false
        if (result != null && result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val uri = if (data == null) null else data.getData()
            if (uri != null) {
                try {
                    context.getContentResolver()
                            .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (ignored: Throwable) {
                    // 拷贝是一次性的，拿不到长期权限没关系。
                }
                picked = WallpaperBackgroundVideo.store(context, uri) != null
            }
        }
        val out = JSObject()
        out.put("picked", picked)
        // 选了文件却用不了（太大 / 读不出来）：要跟「用户取消」区分开，UI 得给提示。
        out.put("rejected", !picked && result != null
                && result.resultCode == Activity.RESULT_OK)
        call.resolve(out)
    }

    /** 有没有上传过视频背景：决定按钮显示「上传」还是「更换 / 清除」。 */
    @PluginMethod
    fun getVideo(call: PluginCall) {
        val out = JSObject()
        out.put("has", WallpaperBackgroundVideo.key(context) != null)
        call.resolve(out)
    }

    @PluginMethod
    fun clearVideo(call: PluginCall) {
        WallpaperBackgroundVideo.clear(context)
        call.resolve()
    }

    @PluginMethod
    fun getBackground(call: PluginCall) {
        val result = JSObject()
        result.put("mode", WallpaperLyricsState.get().backgroundMode)
        call.resolve(result)
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        WallpaperLyricsState.clear(context)
        call.resolve()
    }

    /**
     * 心跳：Web 层每两秒敲一下「我还活着」。
     *
     * 什么都不推、什么都不改 —— 只是把壁纸那边的心跳时间戳刷新一次。
     * 一旦它停了（应用被划掉后台 / WebView 死透），壁纸与两层叠层超时后就只画背景，
     * 不再画没人听的歌词和进度条（见 WallpaperLyricsState.heartbeatAlive）。
     */
    @PluginMethod
    fun heartbeat(call: PluginCall) {
        WallpaperLyricsState.heartbeat()
        call.resolve()
    }

    /**
     * 壁纸那层「可视化叠层」要画在壁纸之上，必须有 SYSTEM_ALERT_WINDOW。
     *
     * 没拿到权限时叠层是**静默不启用**的（退回原生 GLES 渲染），
     * 用户只会看到「壁纸和以前一样」，完全想不到是需要授权 ——
     * 所以设置页得能主动查这个状态并一键跳去授权。
     */
    @PluginMethod
    fun hasOverlayPermission(call: PluginCall) {
        val result = JSObject()
        result.put("granted", top.izuna.foliamajor.wallpaper.WallpaperOverlay
                .canOverlay(context))
        call.resolve(result)
    }

    /** 跳到系统的「显示在其他应用上层」授权页，直接定位到本应用。 */
    @PluginMethod
    fun openOverlaySettings(call: PluginCall) {
        try {
            val intent = android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + context.getPackageName()))
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (error: Throwable) {
            call.reject("无法打开授权页面")
        }
    }

    /**
     * 把「简易悬浮歌词」那颗小窗恢复默认（位置 / 大小 / 锁一起清掉）。
     *
     * 设置页那颗按钮走这里。见 FloatingLyricsOverlay.resetLayout 里为什么必须留这个出口。
     */
    @PluginMethod
    fun resetFloatingLyrics(call: PluginCall) {
        top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                .shared(context)
                .resetLayout()
        call.resolve()
    }

    /** 当前系统壁纸是不是我们这个。UI 用它决定按钮显示「设置」还是「已启用」。 */
    @PluginMethod
    fun isActive(call: PluginCall) {
        val result = JSObject()
        result.put("active", isOurWallpaperActive())
        call.resolve(result)
    }

    /** 打开系统壁纸选择器，并直接定位到歌词壁纸。 */
    @PluginMethod
    fun openPicker(call: PluginCall) {
        val opened = openLiveWallpaperPicker()
        val result = JSObject()
        result.put("opened", opened)
        call.resolve(result)
    }

    private fun openLiveWallpaperPicker(): Boolean {
        val component = ComponentName(
                context.getPackageName(), LyricsWallpaperService::class.java.getName())
        try {
            val intent = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
            intent.putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, component)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            return true
        } catch (error: Throwable) {
            // 少数 ROM 没有实现上面那个 action，退回老的选择器入口。
            try {
                val intent = Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER)
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                return true
            } catch (fallbackError: Throwable) {
                return false
            }
        }
    }

    private fun isOurWallpaperActive(): Boolean {
        val manager = WallpaperManager.getInstance(context)
        val info = manager.getWallpaperInfo()
        return info != null
                && context.getPackageName() == info.getPackageName()
    }

    companion object {

        /**
         * 读一行的翻译。没有翻译的行一律返回 null（不是空串）——
         * 空串会让渲染侧分不清「没翻译」和「翻译是空的」，从而多画出一条空行。
         */
        private fun readTranslation(entry: org.json.JSONObject): String? {
            val value: String? = entry.optString("translation", null)
            if (value == null || value.isEmpty() || value == "null") {
                return null
            }
            return value
        }

        /**
         * 一行的逐字时间轴。
         *
         * 段的时间必须**夹在行的 [start, end] 之内**：有些歌词格式里第一个片段会用行本身的
         * 起止、个别还会越过行边界几个毫秒，而渐变进度是按 [start, end] 归一算的 ——
         * 越界那部分就变成「最后一个片段永远点不亮」或「上一行还在显示它就开始亮了」。
         * 桥上给的是毫秒整数，取一个上下界夹一下最省事。
         *
         * 只有多于一段才有意义 —— 一段等于整行，传下去和没传一样。
         */
        private fun readWords(
                entry: org.json.JSONObject, lineStartMs: Long): Array<WallpaperLyricsState.TimedWord>? {
            val array = entry.optJSONArray("words")
            if (array == null || array.length() <= 1) {
                return null
            }
            val words = Array(array.length()) { WallpaperLyricsState.TimedWord("", 0L, 0L) }
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i)
                if (item == null) {
                    return null
                }
                val start = Math.max(lineStartMs, item.optLong("start", lineStartMs))
                val end = Math.max(start, item.optLong("end", start))
                words[i] = WallpaperLyricsState.TimedWord(item.optString("text", ""), start, end)
            }
            return words
        }

        /**
         * 歌词动画实验台的配置。
         *
         * 一律压成 float：布尔开关当 0/1 用，字符串枚举由 Web 侧先转成序号。
         * 表里只放**当前生效那个模式**的字段，所以 native 那边按字段名取值不会有歧义。
         * 拿不到（没传 / 不是数字）的字段直接跳过 —— 缺项时渲染器会退回默认值。
         */
        @Suppress("UNCHECKED_CAST")
        private fun readTuning(tuning: JSObject?): Map<String, Float>? {
            if (tuning == null) {
                return null
            }
            val values = java.util.HashMap<String, Float>()
            val keys: Iterator<String> = tuning.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = tuning.opt(key)
                if (value is Number) {
                    values.put(key, value.toFloat())
                } else if (value is Boolean) {
                    values.put(key, if (value) 1f else 0f)
                }
            }
            // Kotlin 侧统一收 Kotlin Map；HashMap 在 JVM 层本就实现了它，无需再转。
            return values
        }

        private fun parseColor(value: String?): Int {
            if (value == null || value.isEmpty()) {
                return 0
            }
            try {
                return Color.parseColor(value)
            } catch (error: IllegalArgumentException) {
                return 0
            }
        }
    }
}
