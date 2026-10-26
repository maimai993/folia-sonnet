package top.izuna.foliamajor
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Web 层与 FoliaPlaybackService 之间的桥。
 *
 * Web 层不直接 startForegroundService（那需要暴露原生 API 给任意 JS 调用），
 * 而是通过这个插件把意图转成 service 的 startService 动作。
 *
 * 注意 Android 8+ 不允许后台启动服务，所以 startForegroundService 之后
 * 服务端必须在一个「准点」上调用 startForeground 来满足系统的 5 秒要求。
 * 「要前台化」时用 startForegroundService，服务已经在前台时改走普通 startService
 * （见 startServiceCompat）。
 */
@CapacitorPlugin(name = "FoliaPlayback")
class FoliaPlaybackPlugin : Plugin() {

    override fun load() {
        instance = this
    }

    protected override fun handleOnDestroy() {
        instance = null
        super.handleOnDestroy()
    }

    companion object {
        private const val TAG = "FoliaPlaybackPlugin"

        /**
         * 服务发来的控制命令经 MainActivity 的广播接收器转到这里，再派发给 JS。
         * 事件名必须与 Web 层 FoliaPlayback.addListener 订阅的保持一致。
         */
        private const val EVENT_COMMAND = "foliaPlaybackCommand"

        /**
         * 通知栏/耳机按键在后台触发时，Activity 可能已经不在了，
         * 只能从静态引用拿到插件实例（见 FoliaCommandReceiver）。
         */
        @Volatile
        private var instance: FoliaPlaybackPlugin? = null

        /**
         * WebView 这条播放管线还活着吗。
         *
         * 插件实例在桥销毁（Activity 被划掉后台销毁）时清空 —— 它就是「JS 还在不在」的判据：
         * 实例在，WebView 就在（哪怕已退后台、定时器被挂起，音频照样在放）；
         * 实例没了，WebView 就没了，JS 那边不可能再有声音。播放服务的心跳巡检靠它区分
         * 「后台还在放」与「划掉之后的僵尸进程」（见 FoliaPlaybackService.heartbeatTick）。
         */
        @JvmStatic
        fun isBridgeAlive(): Boolean {
            return instance != null
        }

        @JvmStatic
        fun dispatchCommandFromReceiver(command: String, positionMs: Long) {
            dispatchCommandFromReceiver(command, positionMs, null)
        }

        @JvmStatic
        fun dispatchCommandFromReceiver(command: String, positionMs: Long, songKey: String?) {
            val current = instance
            if (current != null) {
                current.dispatchCommand(command, positionMs, songKey)
            }
        }

        /**
         * 把服务端的播放/切歌意图转成一个供 Web 层订阅的 CustomEvent。
         *
         * 服务与 Activity 是不同组件；这里统一由插件在 Activity 存活期间接收广播，
         * 再 notifyListeners 派发给 JS。Web 层据此调用自己的播放控制，
         * 避免在原生侧再实现一套播放器状态机。
         */
        @JvmStatic
        fun dispatchCommandToWeb(context: Context, command: String) {
            // Android 8+ 不再给隐式广播投递给清单注册的接收器，必须写死组件名。
            val intent = Intent(context, FoliaCommandReceiver::class.java)
            intent.setAction(FoliaPlaybackService.ACTION_WEB_COMMAND)
            intent.putExtra(FoliaPlaybackService.EXTRA_COMMAND, command)
            context.sendBroadcast(intent)
        }
    }

    @PluginMethod
    fun update(call: PluginCall) {
        val activity = getActivity()
        if (activity == null) {
            call.reject("Activity unavailable; cannot update playback metadata.")
            return
        }

        val intent = Intent(activity, FoliaPlaybackService::class.java)
        intent.setAction(FoliaPlaybackService.ACTION_UPDATE_METADATA)
        val title = call.getString("title")
        val artist = call.getString("artist")
        val album = call.getString("album")
        val artwork = call.getString("artworkBase64")
        val duration = call.getInt("durationMs")

        if (title != null) intent.putExtra(FoliaPlaybackService.EXTRA_TITLE, title)
        if (artist != null) intent.putExtra(FoliaPlaybackService.EXTRA_ARTIST, artist)
        if (album != null) intent.putExtra(FoliaPlaybackService.EXTRA_ALBAND, album)
        if (artwork != null) intent.putExtra(FoliaPlaybackService.EXTRA_ARTWORK, artwork)
        // 同时把封面地址给过去：原生自己下载，绕开 WebView 的 CORS 限制。
        val artworkUrl = call.getString("artworkUrl")
        if (artworkUrl != null) intent.putExtra(FoliaPlaybackService.EXTRA_ARTWORK_URL, artworkUrl)
        if (duration != null) intent.putExtra(FoliaPlaybackService.EXTRA_DURATION, duration.toLong())
        // 封面角标用哪颗图标：当前播放来源的平台（netease/qq/kugou/bodian/folia）。
        val providerBadge = call.getString("providerBadge")
        if (providerBadge != null) intent.putExtra(FoliaPlaybackService.EXTRA_PROVIDER_BADGE, providerBadge)
        // 当前这首歌的身份：服务端拿它判断是不是换歌了，换歌时要先丢掉上一首的封面。
        val songKey = call.getString("songKey")
        if (songKey != null) intent.putExtra(FoliaPlaybackService.EXTRA_SONG_KEY, songKey)
        // 「喜欢」状态：通知栏那颗心画实心还是空心，以及这颗心该不该出现。
        // 用 hasExtra 语义（JS 侧显式传 boolean 才有这个 extra），不传就是「这次不改」。
        val liked = call.getBoolean("liked")
        if (liked != null) intent.putExtra(FoliaPlaybackService.EXTRA_LIKED, liked)
        val canLike = call.getBoolean("canLike")
        if (canLike != null) intent.putExtra(FoliaPlaybackService.EXTRA_CAN_LIKE, canLike)
        // 红心兜底用的服务器侧身份：WebView 冻结时通知栏那颗心按它直接对各平台补写收藏。
        val providerId = call.getString("providerId")
        if (providerId != null) intent.putExtra(FoliaPlaybackService.EXTRA_PROVIDER_ID, providerId)
        val serverSongId = call.getString("serverSongId")
        if (serverSongId != null) intent.putExtra(FoliaPlaybackService.EXTRA_SERVER_SONG_ID, serverSongId)

        startServiceCompat(activity, intent)
        call.resolve()
    }

    /**
     * App 内点歌 / 切歌走原生（两轨合一）：
     *
     * JS 把刚排好的队列（镜像条目格式）与目标歌一并交过来，原生在后台向平台
     * 要地址（MusicGateway 直连，带预取）、装源起播，再发 syncTo 让界面认领。
     * WebView 里那套 omni 解析 → setAudioSrc 的慢链不再参与，两边抢一首歌的
     * 时序 bug 就此绝迹。回 {@code ok=false} 时（镜像定位不到 / 服务不在）JS
     * 回退到自己的全流程。
     */
    @PluginMethod
    fun playFromQueue(call: PluginCall) {
        val service = FoliaPlaybackService.activeService()
        if (service == null) {
            val result = JSObject()
            result.put("ok", false)
            call.resolve(result)
            return
        }
        val songKey = call.getString("songKey", "")
        val queueJson = call.getString("queueJson", "")
        val index = call.getInt("index", -1) ?: -1
        val ok = service.playFromQueue(songKey, queueJson, index)
        val result = JSObject()
        result.put("ok", ok)
        call.resolve(result)
    }

    /**
     * App 内的下一首 / 上一首走原生：与通知栏同一条直连路径（预取命中即瞬时）。
     * 回 {@code skipped=false} 时（队列缺位 / 越界）JS 回退自己的全流程。
     */
    @PluginMethod
    fun requestSkip(call: PluginCall) {
        val service = FoliaPlaybackService.activeService()
        val direction = call.getInt("direction", 1)
        val step = if (direction == null) 1 else (if (direction < 0) -1 else 1)
        val skipped = service != null && service.transportSkip(step)
        val result = JSObject()
        result.put("skipped", skipped)
        call.resolve(result)
    }

    /**
     * 队列镜像快照：WebView 冻结后通知栏切歌的原生兜底数据源。
     *
     * JS 活着时每次队列/当前歌变化都推一份（当前 ±10 首、带已解析地址的窗口）。
     * 服务把它存成静态字段；{@code onSkipToNext/Previous} 的确认计时器发现 JS
     * 没回话时，就按这份快照在原生直接换源。只转存、不解析 —— 镜像的语义归服务。
     */
    /**
     * 原生补写过的红心（WebView 冻结期间通知栏那颗心在服务器上写成功的）。
     *
     * App 启动时 JS 调一次，取走并把盘上的记录清掉；拿到的每一条都要对齐进自己的
     * 账号缓存（omni.applyNativeLikeOverrides），否则打开 App 那一刻 JS 推的还是
     * 旧缓存，App 里的心与通知栏对不上。
     */
    @PluginMethod
    fun consumeLikeOverrides(call: PluginCall) {
        val overrides =
                top.izuna.foliamajor.online.LikeOverrideStore.consume(getContext())
        val list = JSArray()
        try {
            // keys() 返回的是 Kotlin 可空迭代器；直接用 Kotlin 形态接，空键跳过。
            val keys = overrides.keys()
            while (keys.hasNext()) {
                val songKey = keys.next() ?: continue
                val entry = overrides.optJSONObject(songKey)
                if (entry == null) continue
                val item = JSObject()
                item.put("songKey", songKey)
                item.put("providerId", entry.optString("providerId", ""))
                item.put("serverSongId", entry.optString("serverSongId", ""))
                item.put("liked", entry.optBoolean("liked", false))
                list.put(item)
            }
        } catch (ignored: Throwable) {
            // 解析不了就回空：最坏回到「App 里的心晚一点才对上」。
        }
        val result = JSObject()
        result.put("overrides", list)
        call.resolve(result)
    }

    /**
     * JS「问原生要当前的状态」。
     *
     * 原生是播放的真源：WebView 冻结期间通知栏的镜像换源、原生补写红心都发生在
     * 原生侧，JS 醒来后第一件事是拉这份快照对齐（队列跳到原生的歌、位置对齐、
     * 红心认领），而不是推它自己那份旧状态。服务没在跑时 hasSong=false。
     */
    @PluginMethod
    fun getPlaybackSnapshot(call: PluginCall) {
        try {
            call.resolve(JSObject.fromJSONObject(FoliaPlaybackService.snapshotJson()))
        } catch (error: Throwable) {
            val empty = JSObject()
            empty.put("hasSong", false)
            call.resolve(empty)
        }
    }

    @PluginMethod
    fun setQueueMirror(call: PluginCall) {
        val activity = getActivity()
        if (activity == null) {
            call.resolve()
            return
        }
        val intent = Intent(activity, FoliaPlaybackService::class.java)
        intent.setAction(FoliaPlaybackService.ACTION_UPDATE_QUEUE_MIRROR)
        val queueJson = call.getString("queueJson")
        if (queueJson != null) intent.putExtra(FoliaPlaybackService.EXTRA_QUEUE_MIRROR_JSON, queueJson)
        val index = call.getInt("index")
        if (index != null) intent.putExtra(FoliaPlaybackService.EXTRA_QUEUE_MIRROR_INDEX, index)
        startServiceCompat(activity, intent)
        call.resolve()
    }

    /**
     * 队列没变、只是换了一首正播的：只推游标。全量队列一推几百 KB，不能跟着
     * 切歌反复过桥（桥只有一条，见 FoliaNativePlayerPlugin 的线程规则）。
     */
    @PluginMethod
    fun setQueueMirrorIndex(call: PluginCall) {
        val activity = getActivity()
        if (activity == null) {
            call.resolve()
            return
        }
        val intent = Intent(activity, FoliaPlaybackService::class.java)
        intent.setAction(FoliaPlaybackService.ACTION_UPDATE_QUEUE_INDEX)
        val index = call.getInt("index")
        if (index != null) intent.putExtra(FoliaPlaybackService.EXTRA_QUEUE_MIRROR_INDEX, index)
        startServiceCompat(activity, intent)
        call.resolve()
    }

    @PluginMethod
    fun setState(call: PluginCall) {
        val activity = getActivity()
        if (activity == null) {
            call.reject("Activity unavailable; cannot update playback state.")
            return
        }

        val state = call.getString("state")

        // 只有真正在播放时才值得起前台服务。
        //
        // Web 层在挂载时就会推一次 state='stopped'（currentSong 为空时的初始态），
        // 于是「一打开应用」就会 startForegroundService 把服务拉起来 ——
        // 那段路径此前从未真正执行过（插件没注册成功），一跑就崩。
        // 服务没在跑而状态又是 stopped/paused 时，直接忽略，不做任何原生调用。
        val needsService = "playing".equals(state)
        if (!needsService && !FoliaPlaybackService.isRunning()) {
            call.resolve()
            return
        }

        val intent = Intent(activity, FoliaPlaybackService::class.java)
        intent.setAction(FoliaPlaybackService.ACTION_UPDATE_STATE)
        if (state != null) intent.putExtra(FoliaPlaybackService.EXTRA_STATE, state)
        val position = call.getInt("positionMs")
        if (position != null) intent.putExtra(FoliaPlaybackService.EXTRA_POSITION, position.toLong())
        val speed = call.getFloat("speed")
        if (speed != null) intent.putExtra(FoliaPlaybackService.EXTRA_SPEED, speed)

        startServiceCompat(activity, intent)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val activity = getActivity()
        // 服务没在跑就没什么可停的。注意这里原先会无条件 startService，
        // 于是「打开应用、还没有歌」也会把一个前台服务拉起来再停掉。
        if (activity == null || !FoliaPlaybackService.isRunning()) {
            call.resolve()
            return
        }
        val intent = Intent(activity, FoliaPlaybackService::class.java)
        intent.setAction(FoliaPlaybackService.ACTION_STOP_FOREGROUND)
        activity.startService(intent)
        call.resolve()
    }

    /**
     * 把服务端的播放/切歌意图派发给 Web 层。
     *
     * 用 Capacitor 的事件通道而不是直接调用 Web 层方法：JS 侧通过
     * FoliaPlayback.onCommand(handler) 订阅，插件内部只管 notifyListeners。
     */
    fun dispatchCommand(command: String) {
        dispatchCommand(command, 0L)
    }

    fun dispatchCommand(command: String, positionMs: Long) {
        dispatchCommand(command, positionMs, null)
    }

    fun dispatchCommand(command: String, positionMs: Long, songKey: String?) {
        val payload = JSObject()
        payload.put("command", command)
        payload.put("positionMs", positionMs)
        // syncTo 用：原生兜底切歌后叫 JS 把队列跳到原生正在放这首。
        if (songKey != null) {
            payload.put("songKey", songKey)
        }
        notifyListeners(EVENT_COMMAND, payload)
    }

    /**
     * 只在「这条 intent 需要把服务顶到前台」时才用 startForegroundService。
     *
     * startForegroundService 给**每一次**启动都开一个「5 秒内必须 startForeground()」
     * 的倒计时，而播放位置是每秒推一次的 —— 服务已经在前台时仍走这条路，服务端就
     * 得每秒调一次 startForeground() 去兑现。通知里带着 512×512 的封面 Bitmap
     * （约 1 MB），那是每秒在主线程上搬一次 1 MB：播放页单帧本来就要二三十毫秒，
     * 被它定期拖一下就是肉眼可见的卡顿。
     *
     * 而服务已经在前台时，这条 intent 只是「更新一下内容」，不需要新的前台化承诺 ——
     * 普通 startService 不开倒计时，也就不用兑。（进程里有前台服务，系统当它是前台，
     * 后台启动服务的限制在这里不适用。）
     */
    private fun startServiceCompat(activity: Activity, intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !FoliaPlaybackService.isForegrounded()) {
            try {
                activity.startForegroundService(intent)
                return
            } catch (error: Throwable) {
                // 起不来就退回普通那条路：服务要是在跑，内容照样能送到。
                Log.e(TAG, "startForegroundService failed; falling back to startService", error)
            }
        }
        try {
            activity.startService(intent)
        } catch (error: Throwable) {
            Log.e(TAG, "startService failed", error)
        }
    }
}
