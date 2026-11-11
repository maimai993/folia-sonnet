package top.izuna.foliamajor

import android.app.Activity
import android.app.WallpaperManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.provider.Settings
import android.util.Log

import androidx.activity.result.ActivityResult

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin

import org.json.JSONException

import top.izuna.foliamajor.wallpaper.FontArchiveDownloader
import top.izuna.foliamajor.wallpaper.LyricsWallpaperService
import top.izuna.foliamajor.wallpaper.WallpaperBackgroundImage
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
            /*
             * 整包推送同样要让位给原生在播的位置 —— 与上面那条心跳同一个理由，
             * 而这条更严重：它带着时间轴，覆盖得更彻底。
             *
             * 原生在播时 Web 给的位置是插值出来的（`nativePlaybackEngine.getPositionSec()`
             * 往后补的那一截），播放器自己另有每 250ms 一次的采样值在写锚点。两边交替写，
             * 界面上就是桌面歌词「突然往回走一下、又恢复正常」—— 用户报的抽搐。
             *
             * 只把位置这一项让出去：时间轴、标题、封面、主题都得照常更新，否则换歌之后
             * 叠层会挂着上一首的歌词和封面。
             */
            val nativeOwnsPosition = top.izuna.foliamajor.player.FoliaNativePlayerPlugin.isNativePlaying()
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
                    if (nativeOwnsPosition) -1L else Math.max(0L, positionMs),
                    isPlaying)
        }
        call.resolve()
    }

    /**
     * 群唱（Cappella）自定义头像 / 表情图推给原生。
     *
     * 叠层是另一个 WebView，它读不到主应用 IndexedDB 里的上传图 —— 不推这一份，Cappella
     * 在叠层上就按「没有自定义头像」回退到封面（用户报的「群唱自定义头像显示的是封面」）。
     *
     * 两个参数都是 JSON 数组字符串（[{id,name,url}]，url 是 data URL）。字符串而不是
     * JSArray：几百 KB 的 base64 走 Capacitor 的数组解析只会更慢，且这里根本不需要拆开。
     */
    @PluginMethod
    fun publishCappellaImages(call: PluginCall) {
        top.izuna.foliamajor.wallpaper.WallpaperCappellaImages.set(
            call.getString("avatars"),
            call.getString("emojis"),
        )
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

    /**
     * 按地址下载一个视频当壁纸背景（背景市场用）。
     *
     * 为什么不让网页层下载：市场里的视频几十到上百 MB，走 WebView 的 fetch 再转 base64
     * 既慢又容易把内存打爆。这里由原生下载并落盘，和 [pickVideo] 走同一套存储。
     *
     * 参数：url（必填）、progressId（可选，用来回传进度事件）。
     */
    @PluginMethod
    fun downloadVideo(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("缺少 url")
            return
        }
        val progressId = call.getString("progressId")
        /*
         * 旋转角度（0 / 90 / 180 / 270）。
         *
         * 视频不像图片那样能在这里重编码 —— 几十 MB 转一遍太慢，也没法保证画质。
         * 所以只把角度记下来，由壁纸渲染那一层在画的时候转
         * （见 LyricsRenderer 的 drawVideo 读 wp.videoRotation）。
         *
         * ⚠️ 这里必须**真的存下来**：以前只把它读进一个局部变量就丢掉了，
         * 结果市场里「旋转 90°」对桌面壁纸毫无作用 —— 视频横躺着，用户以为功能没做。
         * 存进 SharedPreferences，LyricsRenderer 读 wp.videoRotation 时用它兜底
         * （Web 侧下发的 tuning 仍然是首选，两者一致；Web 侧没下发时才用这里这份）。
         */
        val rotation = call.getInt("rotation", 0) ?: 0
        if (rotation != 0) {
            context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
                .edit()
                .putInt(KEY_VIDEO_ROTATION, ((rotation % 360) + 360) % 360)
                .apply()
        }
        // 下载是阻塞 IO，必须离开主线程；进度通过事件回传，Web 侧按 id 对应。
        Thread {
            val key = WallpaperBackgroundVideo.storeFromUrl(context, url) { percent ->
                if (progressId != null) {
                    val payload = JSObject()
                    payload.put("id", progressId)
                    payload.put("percent", percent)
                    notifyListeners("videoDownloadProgress", payload)
                }
            }
            val out = JSObject()
            out.put("downloaded", key != null)
            call.resolve(out)
        }.start()
    }

    /**
     * 把一个**已经下载好的**本地文件安装成壁纸视频，不再下载。
     *
     * 为什么需要：背景市场里同时勾「桌面壁纸」和「App 内」时，视频层那边已经通过
     * `downloadVideoLayerFile` 把同一个视频下到 cache 里了；桌面壁纸再走一次
     * `downloadVideo` 就是同一个几十 MB 的文件下两遍。这里直接拿那份文件落成壁纸层的
     * 那一份（`WallpaperBackgroundVideo` 仍要自己的文件名，所以是拷贝而不是引用）。
     *
     * `path` 是原生自己给的路径（video layer 的下载结果），不接受任意外部路径之外的
     * 用法 —— 调用方只会把刚下载的那一份传进来。
     */
    @PluginMethod
    fun adoptDownloadedVideo(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrBlank()) {
            call.reject("缺少 path")
            return
        }
        val source = java.io.File(path)
        if (!source.isFile || source.length() <= 0) {
            call.reject("文件不存在")
            return
        }
        Thread {
            val key = try {
                WallpaperBackgroundVideo.store(context, android.net.Uri.fromFile(source))
            } catch (error: Throwable) {
                android.util.Log.w(TAG, "adopting the downloaded video failed", error)
                null
            }
            val out = JSObject()
            out.put("downloaded", key != null)
            call.resolve(out)
        }.start()
    }

    /**
     * 按地址下载一张图当壁纸背景（背景市场用）。
     *
     * 和 downloadVideo 同一个道理：不让 WebView 碰字节，原生下完直接解码压成 JPEG 落盘，
     * 之后壁纸层读的还是那个文件。
     *
     * ⚠️ 图片这一路没有像视频那样做「下一次、两边装」：
     * 壁纸层要的是**压过的高质量 JPEG**（铺满一屏，体积敏感），而 App 内要的是
     * 原始图片拿去当莫奈来源 —— 两者产物不同，硬凑一份反而会掉画质。
     * 视频是字节完全一致的同一个文件，才值得共用（见 adoptDownloadedVideo）。
     */
    @PluginMethod
    fun downloadImage(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) {
            call.reject("缺少 url")
            return
        }
        // 裁切与旋转：壁纸多是横屏，手机是竖屏，让用户在界面上选要保留哪一块。
        val rotation = call.getInt("rotation", 0) ?: 0
        val cropLeft = call.getFloat("cropLeft", 0f) ?: 0f
        val cropTop = call.getFloat("cropTop", 0f) ?: 0f
        val cropRight = call.getFloat("cropRight", 1f) ?: 1f
        val cropBottom = call.getFloat("cropBottom", 1f) ?: 1f
        Thread {
            val key = WallpaperBackgroundImage.storeFromUrl(
                context, url, rotation, cropLeft, cropTop, cropRight, cropBottom,
            )
            val out = JSObject()
            out.put("downloaded", key != null)
            call.resolve(out)
        }.start()
    }

    /**
     * 下载字体天下（fonts.net.cn）的字体包并解出可用字体。
     *
     * 为什么必须原生做：包是几 MB 的 zip，要下载、要解 deflate、要按后缀挑文件。
     * WebView 里既没有文件系统，也扛不住这个内存。原生下完解完，只回结果。
     *
     * 参数：fontId（字体天下的数字 ID）。
     * 返回：{ downloaded, fileName, error }，error 是接口的原始失败码
     *      （FontDownloadPurchaseRequired 等），由 Web 侧翻译成文案。
     */
    @PluginMethod
    fun downloadFontArchive(call: PluginCall) {
        val fontId = call.getString("fontId")
        if (fontId.isNullOrBlank()) {
            call.reject("缺少 fontId")
            return
        }
        // 下载 + 解压都是阻塞 IO，必须离开主线程。
        Thread {
            // 游标放在线程里，两个字体同时下也不会互相踩。
            var lastReported = 0L
            val result = FontArchiveDownloader.download(fontId, context.filesDir) { downloaded, total ->
                /*
                 * 下载进度按字节节流上报：每 128 KB 一次。
                 *
                 * 不节流的话一个小包能刷上千条事件过桥，反而卡界面；
                 * 而字体包通常几 MB，这个粒度看着已经是连续的。
                 */
                if (downloaded - lastReported >= PROGRESS_STEP_BYTES || (total > 0 && downloaded >= total)) {
                    lastReported = downloaded
                    val payload = JSObject()
                    payload.put("fontId", fontId)
                    payload.put("downloaded", downloaded)
                    payload.put("total", total)
                    notifyListeners("fontDownloadProgress", payload)
                }
            }
            val out = JSObject()
            out.put("downloaded", result.fontFile != null)
            out.put("fileName", result.fileName)
            // 绝对路径要给回 Web 侧：filesDir 在 JS 里拿不到，拼不出文件地址。
            out.put("path", result.fontFile?.absolutePath ?: "")
            out.put("error", result.error)
            call.resolve(out)
        }.start()
    }

    /** 进度事件的最小间隔字节数。 */
    private val PROGRESS_STEP_BYTES = 128L * 1024L

    /**
     * 把下载好的字体文件内容读回来（base64）。
     *
     * 为什么要多这一步：Web 侧要让它走**用户上传字体**那条既有链路
     * （handleUploadLyricsCustomFont），那条链路收的是 File 对象。
     * 只有绝对路径的话 JS 拿不到内容 —— WebView 读不了 file://。
     *
     * 会有大小上限：base64 过桥是字符串，几十 MB 的字体传过去
     * 既慢又可能被桥截断，截断后的数据在 FontFace 里就是
     * 「Invalid font data in ArrayBuffer」—— 和文件本身完好时的报错一模一样，
     * 完全看不出是被截断的。所以宁可在这里明确拒绝。
     */
    @PluginMethod
    fun readFontFile(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrBlank()) {
            call.reject("缺少 path")
            return
        }
        Thread {
            val file = java.io.File(path)
            val out = JSObject()
            if (!file.exists() || !file.isFile) {
                out.put("found", false)
                out.put("error", "FileMissing")
                call.resolve(out)
                return@Thread
            }
            if (file.length() > MAX_FONT_READ_BYTES) {
                out.put("found", false)
                out.put("error", "FontTooLarge")
                call.resolve(out)
                return@Thread
            }
            try {
                val bytes = file.readBytes()
                // 先确认真的是字体，别把坏数据推过桥让 FontFace 去猜。
                if (!looksLikeFontBytes(bytes)) {
                    out.put("found", false)
                    out.put("error", "NotAFontFile")
                    call.resolve(out)
                    return@Thread
                }
                out.put("found", true)
                out.put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
                out.put("mime", when (file.extension.lowercase()) {
                    "otf" -> "font/otf"
                    "ttc" -> "font/collection"
                    "woff" -> "font/woff"
                    "woff2" -> "font/woff2"
                    else -> "font/ttf"
                })
                out.put("fileName", file.name)
                out.put("size", bytes.size)
            } catch (error: Throwable) {
                out.put("found", false)
                out.put("error", error.message ?: "ReadFailed")
            }
            call.resolve(out)
        }.start()
    }

    /** 过桥上限：6 MB 的字体（base64 后 8 MB 左右）已经够大，再大就该走别的路子。 */
    private val MAX_FONT_READ_BYTES = 6L * 1024L * 1024L

    /** 文件头是否是字体（与 FontArchiveDownloader 里同一套判断）。 */
    private fun looksLikeFontBytes(bytes: ByteArray): Boolean {
        if (bytes.size < 4) return false
        fun at(index: Int) = bytes[index].toInt() and 0xFF
        if (at(0) == 0x00 && at(1) == 0x01 && at(2) == 0x00 && at(3) == 0x00) return true
        if (at(0) == 0x74 && at(1) == 0x72 && at(2) == 0x75 && at(3) == 0x65) return true
        if (at(0) == 0x4F && at(1) == 0x54 && at(2) == 0x54 && at(3) == 0x4F) return true
        if (at(0) == 0x74 && at(1) == 0x74 && at(2) == 0x63 && at(3) == 0x66) return true
        if (at(0) == 0x77 && at(1) == 0x4F && at(2) == 0x46 && (at(3) == 0x46 || at(3) == 0x32)) return true
        return false
    }

    /** 有没有上传过视频背景：决定按钮显示「上传」还是「更换 / 清除」。 */
    @PluginMethod
    fun getVideo(call: PluginCall) {        val out = JSObject()
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

    /**
     * 打开系统壁纸选择器，并直接定位到歌词壁纸。
     *
     * 为什么要把失败原因带回去：
     * 部分 ROM 在没有「设为壁纸」相关权限 / 没装壁纸服务时，startActivity 会直接抛异常。
     * 这里原来把异常吞掉只返回 opened=false，界面又不看这个字段 ——
     * 用户看到的就是「点了没反应」，完全没有线索。
     * 现在返回 opened + reason + active，界面据此决定提示还是引导去授权。
     */
    @PluginMethod
    fun openPicker(call: PluginCall) {
        val already = isOurWallpaperActive()
        if (already) {
            val result = JSObject()
            result.put("opened", true)
            result.put("active", true)
            result.put("reason", "already-active")
            call.resolve(result)
            return
        }
        val failure = openLiveWallpaperPicker()
        val result = JSObject()
        result.put("opened", failure == null)
        result.put("active", false)
        if (failure != null) {
            result.put("reason", failure)
        }
        call.resolve(result)
    }

    /**
     * 打开动态壁纸选择器。
     *
     * @return null 表示成功；否则是失败原因字符串。
     */
    private fun openLiveWallpaperPicker(): String? {
        val component = ComponentName(
                context.getPackageName(), LyricsWallpaperService::class.java.getName())
        try {
            val intent = Intent(WallpaperManager.ACTION_CHANGE_LIVE_WALLPAPER)
            intent.putExtra(WallpaperManager.EXTRA_LIVE_WALLPAPER_COMPONENT, component)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            return null
        } catch (error: Throwable) {
            Log.w(TAG, "ACTION_CHANGE_LIVE_WALLPAPER failed, falling back", error)
        }
        // 少数 ROM 没实现上面那个 action，退回老的选择器入口。
        try {
            val intent = Intent(WallpaperManager.ACTION_LIVE_WALLPAPER_CHOOSER)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            return null
        } catch (error: Throwable) {
            Log.w(TAG, "ACTION_LIVE_WALLPAPER_CHOOSER failed too", error)
        }
        // 两个入口都进不去：多半是被系统权限拦了。直接给出可以去授权的设置页。
        return try {
            val intent = Intent(Settings.ACTION_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            "settings-opened"
        } catch (error2: Throwable) {
            "unavailable"
        }
    }

    private fun isOurWallpaperActive(): Boolean {
        val manager = WallpaperManager.getInstance(context)
        val info = manager.getWallpaperInfo()
        return info != null
                && context.getPackageName() == info.getPackageName()
    }

    companion object {
        private const val TAG = "FoliaWallpaper"

        /** 视频壁纸的旋转角度存在这里，见 downloadVideo 的注释。 */
        private const val PREFS = "folia_wallpaper"
        private const val KEY_VIDEO_ROTATION = "video_rotation_degrees"

        /** 供 LyricsRenderer 在没有 Web 侧 tuning 时兜底读出现已保存的角度。 */
        @JvmStatic
        fun storedVideoRotation(context: android.content.Context?): Int {
            if (context == null) return 0
            return context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
                .getInt(KEY_VIDEO_ROTATION, 0)
        }

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
