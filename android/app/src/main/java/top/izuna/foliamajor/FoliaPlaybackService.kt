package top.izuna.foliamajor
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Base64
import android.util.Log

import androidx.core.app.NotificationCompat

import top.izuna.foliamajor.coloros.ColorOsLyricBridge

/**
 * 后台播放的前台服务。
 *
 * 为什么必须有它：Folia 的播放器是 WebView 里的 &lt;audio&gt;，应用切到后台后，
 * Android 会节流 WebView 的 JS 定时器与网络栈。表现就是「当前这首还在放，
 * 但自动切下一首时 fetch 拿不到歌曲地址」。系统并没有断网——是请求被挂起了。
 *
 * 两个手段一起用才对：
 * 1. startForeground 让进程拿到前台优先级，Doze/后台限制下网络与 CPU 不被节流，
 *    WebView 里的 fetch 才能正常完成；
 * 2. MediaSessionCompat 挂出系统媒体通知（锁屏与通知栏可见），
 *    这是用户说的「注册一个音乐播放的通知」。它同时让系统媒体按键、
 *    蓝牙耳机与车机按键能控制播放——这些是 navigator.mediaSession 在 WebView 里做不到的。
 *
 * 音频本身仍由 WebView 播放，这里只负责「进程别被掐 + 通知可见可控制」。
 */
class FoliaPlaybackService : android.app.Service() {

    private var mediaSession: MediaSessionCompat? = null
    private var notificationManager: NotificationManager? = null

    // 通知内容缓存：metadata 与 playbackState 是两次独立更新，
    // 每次都基于这些字段重建整条通知，而不是互相覆盖。
    private var cachedTitle = ""
    private var cachedArtist = ""
    private var cachedAlbum = ""
    private var cachedArtwork: Bitmap? = null
    /** 上一首歌的身份（Web 层给的 songKey），用来判断这次 update 是不是换歌了。 */
    private var cachedSongKey: String? = null
    private var cachedState = PlaybackStateCompat.STATE_NONE
    private var cachedDurationMs = 0L
    private var cachedPositionMs = 0L
    private var cachedSpeed = 1.0f
    private var cachedPlaying = false
    /**
     * 当前这首歌是不是「已喜欢」。
     *
     * Web 层每次推 metadata 都会带上它。通知栏那颗心的**形状**（实心 / 空心）与
     * MediaSession 的「喜欢」按钮标题都读这里 —— 原生不自己记状态，点了只发命令，
     * 真正改状态的是 Web 层，改完再推回来。
     */
    private var cachedLiked = false
    /**
     * 「喜欢」这个动作当前能不能用（平台不支持收藏、正由外部 Stage 播放时为 false）。
     *
     * false 时通知栏不画那颗心：通知按钮没有「置灰」这一说，画出来点了没反应比不画更糟。
     */
    private var cachedCanLike = false
    /** 封面角标（通知 small icon）的资源 id；0 = 还没收到过，用缺省。 */
    private var cachedBadgeRes = 0
    // ===== 红心的原生兜底 =====
    // 当前歌的服务器侧身份：哪个平台、平台认的歌曲 id。Web 层随 metadata / 队列镜像推来，
    // WebView 冻结时通知栏那颗心按它直接对各平台补写收藏（见 scheduleLikeFallback）。
    private var cachedProviderId = ""
    private var cachedServerSongId = ""
    /**
     * 原生兜底切歌的「真源」：镜像换源之后 JS 醒来第一份 metadata 推的还是它自己的
     * 旧歌 —— 收下它通知栏就会弹回旧歌（「一打开 app 全部恢复原样」）。守卫期间
     * 别的歌不收，同时发 syncTo 叫 JS 把队列跳到原生正在放这首；它推来同一首时解除。
     */
    @Volatile
    private var nativeSkipSongKey: String? = null
    /** 原生红心兜底在途标记：同一时刻只允许一发，连点两下不会发出两个相反的写入。 */
    @Volatile
    private var likeFallbackInFlight = false

    /** 最近一次收到元数据的时刻：skip 的确认计时器据此判断 JS 有没有回话。 */
    @Volatile
    private var lastMetadataAtMs = 0L

    /**
     * 原生平台网关解析出来的地址，按 songKey 记着。
     *
     * 预取的意义：下一首的地址在当前这首开始放时就悄悄要好了，用户按下「下一首」
     * 那一刻是现成的 —— 不然每次兜底切歌都要等一趟网络（用户报的「上下一首非常慢」）。
     */
    val resolvedUrlCache: java.util.concurrent.ConcurrentHashMap<String, String> =
            java.util.concurrent.ConcurrentHashMap()
    /** 最近一次交给系统的通知：promoteToForeground() 重复贴的就是它，省掉重建的开销。 */
    private var cachedNotification: Notification? = null

    private val mainHandler = Handler(Looper.getMainLooper())
    /** 有一次「乐观播放」在等确认。 */
    private var playConfirmPending = false
    /** 那次乐观播放切的那一刻的位置：冻回去要落在这儿，不能落在已经被推出去的地方。 */
    private var playConfirmAnchorMs = 0L
    private var playNudges = 0
    private val playConfirmCheck: Runnable = object : Runnable {
        override fun run() {
            if (!playConfirmPending) return
            playConfirmPending = false
            // Web 层已经回过话（无论是 playing 还是 paused）：以它为准，这里什么都不做。
            if (cachedPlaying) return
            top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setAnchor(playConfirmAnchorMs, false)
            top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                    .shared(this@FoliaPlaybackService).invalidateOverlay()
            /*
             * 补发一次播放命令。
             *
             * 这段时间里 Web 层一个字都没回，多半是**卡在某个 await 上**而不是「播不了」：
             * 最典型的是长时间暂停之后那条「在线地址过期、重新取一次」的网络往返 ——
             * 后台里它可以一直不落地，于是整条 resume 停在那儿，用户看到的就是
             * 「按了播放没反应，打开应用才瞬间恢复」。
             *
             * 补发为什么有用：第二次 resume 会撞上 `recoverOnlinePlaybackSource` 自己的去重
             * （同一个 failedSrc 已经登记过就直接返回），于是它跳过这一步、直接
             * `audio.play()` 现有地址 —— 多数情况下声音这就出来了。
             *
             * 为什么必须是原生计时器而不是 JS 的 setTimeout：这个应用退到后台后 JS 定时器
             * 会被系统挂起（壁纸歌词正是因此才改成「锚点 + 墙钟」），JS 那边根本没有
             * 可靠的钟可用；而桥本身是通的 —— 命令就是这么送过去的。
             */
            if (playNudges < MAX_PLAY_NUDGES) {
                playNudges++
                Log.w(TAG, "Play command never took effect; nudging the web layer (" +
                        playNudges + "/" + MAX_PLAY_NUDGES + ")")
                sendCommand("play")
            }
        }
    }

    /** 最近一次敲下心跳的时刻（elapsedRealtime）；0 = 服务起来后还没活过 —— 那不收。 */
    private var lastHeartbeatAtMs = 0L

    private val heartbeatTick: Runnable = object : Runnable {
        override fun run() {
            if (!running) {
                return
            }
            val alive = FoliaPlaybackPlugin.isBridgeAlive()
                    || top.izuna.foliamajor.player.FoliaNativePlayerPlugin.isNativePlaying()
            if (alive) {
                top.izuna.foliamajor.wallpaper.WallpaperLyricsState.heartbeat()
                lastHeartbeatAtMs = android.os.SystemClock.elapsedRealtime()
            } else if (lastHeartbeatAtMs > 0L && !playConfirmPending
                    && !top.izuna.foliamajor.player.FoliaNativePlayerPlugin.hasActiveMedia()
                    && android.os.SystemClock.elapsedRealtime() - lastHeartbeatAtMs > HEARTBEAT_WITHDRAW_MS) {
                // 只在「曾经活过」之后才收：服务刚起、桥还没连上时心跳本来就还没敲过。
                // playConfirmPending 挡着的是「用户刚按下播放、正在等回话」那一拍。
                //
                // ⭐ 但**原生手上还有歌时（暂停了 / 放完了）不收** —— 心跳只把
                // 「真的没声音了」当作断，可那颗播放键还把歌拉得起来。上一版就栽在这：
                // 用户暂停之后 10 秒通知整个没了，想再播只能重新打开 App
                // （用户原话「暂停后无法播放」）。真正该收的是「桥死了、原生手上
                // 什么都没有」—— 那时每个键都是死键。
                withdrawMediaNotification()
            }
            mainHandler.postDelayed(this, WALLPAPER_HEARTBEAT_TICK_MS)
        }
    }

    /**
     * 心跳断了：注销播放控制通知并退出前台。
     *
     * 与 onStop 的收法一致（stopForegroundCompat + 撤 session），另加一次
     * notificationManager.cancel —— publishNotification 那条路是 notify 贴的，
     * stopForeground(REMOVE) 只收 startForeground 关联的那张。
     *
     * 复活路径是通的：哪天播放又活了（原生兜底切歌 / JS 醒来推状态），
     * promoteToForeground() 会重新前台化并把 session 拉回来，通知跟着回来。
     */
    private fun withdrawMediaNotification() {
        Log.i(TAG, "playback heartbeat is gone; withdrawing the media notification")
        if (mediaSession != null) {
            try {
                mediaSession?.setActive(false)
            } catch (ignored: Throwable) {
            }
        }
        foregrounded = false
        cachedNotification = null
        try {
            stopForegroundCompat()
        } catch (ignored: Throwable) {
        }
        try {
            notificationManager?.cancel(NOTIFICATION_ID)
        } catch (ignored: Throwable) {
        }
    }

    override fun onCreate() {
        super.onCreate()
        running = true
        snapshotSource = this
        notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // 新实例起来了：前台状态必须从零算。它是静态的，进程活着时插件读它
        // （isForegrounded）决定走 startService 还是 startForegroundService；留着上一个
        // 实例的 true，新实例就会以为自己已经前台化、跳过 startForeground() ——
        // 5 秒后系统抛 ForegroundServiceDidNotStartInTimeException 杀进程。
        foregrounded = false
        cachedNotification = null
        createNotificationChannel()
        // 就地前台化，**在任何可能卡住的工作之前**。
        //
        // Android 要求 startForegroundService() 之后 5 秒内调用 startForeground()，
        // 超时就抛 ForegroundServiceDidNotStartInTimeException 直接杀进程。
        // 放在 onCreate 里而不是等 onStartCommand 走完分支是最稳的做法（无论后续 switch
        // 走进哪个分支、甚至 intent 为 null，前台化都已经完成了）；而它必须在
        // ensureMediaSession() 之前 —— 建 MediaSession 要跟系统的媒体服务打交道，
        // 主线程一忙起来（切登录平台时 WebView 正在重载）就把这 5 秒耗掉了。
        // MediaSession 建好之后再重贴一次通知，好让它带上 MediaStyle 的 token。
        promoteToForeground()
        ensureMediaSession()
        publishNotification()
        // 壁纸心跳巡检开表（onDestroy 里撤）。服务在，巡检就在；它自己判断该不该敲。
        mainHandler.postDelayed(heartbeatTick, WALLPAPER_HEARTBEAT_TICK_MS)
    }

    /**
     * 建立/重建 MediaSession。
     *
     * 抽成方法是因为进程被杀后 START_STICKY 只会重跑 onStartCommand，
     * 不会经过 onCreate，MediaSession 会是 null（通知上的控制项也就没了）。
     */
    private fun ensureMediaSession() {
        if (mediaSession != null) {
            return
        }
        val session = MediaSessionCompat(this, "FoliaPlayback")
        mediaSession = session
        session.setCallback(object : MediaSessionCompat.Callback() {
            override fun onPlay() {
                /*
                 * 原生播放（P1）：命令同时**直接**给原生播放器一份。
                 *
                 * 老路是「广播 → 插件 → JS → resumePlayback」，而挂了很久之后 WebView 那侧的
                 * JS 会被节流甚至整个挂起 —— 用户原话：「长时间暂停后，通知中心点播放还是
                 * 拉不起来」。原生这一路不吃那条限制。JS 那条命令照样发：界面、歌词、
                 * 以及 Web 那条链路还得靠它。两边各管一半，重复一次 play 不会有副作用。
                 */
                try {
                    top.izuna.foliamajor.player.FoliaNativePlayerPlugin.resumeFromSystem()
                } catch (ignored: Throwable) {
                    // 原生播放器不在（没开原生播放 / 插件没编进来）：交给 Web 那条路。
                }
                sendCommand("play")
                /*
                 * 锚点**这里就切回播放**，不等 Web 层回话 —— 原因见 onSeekTo 那条注释。
                 *
                 * 具体到这里：通知栏的播放/暂停是**在后台**按下的，而后台 WebView 的 JS
                 * 定时器会被系统挂起，`useLyricsWallpaperFeed` 里负责推 playing 的那几个
                 * effect 一个都跑不起来。壁纸那一侧是「锚点 + 墙钟」自己往前推的，
                 * 缺这一次同步，它就一直冻在暂停那个锚点上 —— 表现就是
                 * 「暂停后重新播放，歌词进度不动」（用户原话）。
                 *
                 * 但「按下播放」不等于「真的播起来了」：所以同时记下这一刻的位置，并挂一个
                 * 宽限检查（见 PLAY_CONFIRM_GRACE_MS）。Web 层真起来了会推 playing 回来，
                 * 那一次就把检查作废；没起来就把锚点冻回去 —— 否则就是用户看到的
                 * 「状态栏、叠层的进度一直在走，实际一点声音都没有」。
                 */
                playConfirmAnchorMs = clampedAnchorPosition()
                playConfirmPending = true
                // 这是用户新按下的一次播放：允许再补发一次。
                playNudges = 0
                mainHandler.removeCallbacks(playConfirmCheck)
                mainHandler.postDelayed(playConfirmCheck, PLAY_CONFIRM_GRACE_MS)
                syncWallpaperAnchor(true)
            }

            override fun onPause() {
                // 同上（见 onPlay 那条注释）：直接停原生播放器，别只指望后台里那侧 JS。
                try {
                    top.izuna.foliamajor.player.FoliaNativePlayerPlugin.pauseFromSystem()
                } catch (ignored: Throwable) {
                    // 同上。
                }
                sendCommand("pause")
                // 暂停按下就撤回那次乐观播放的确认：方向相反，不需要再等，也不会再补发。
                playConfirmPending = false
                playNudges = 0
                mainHandler.removeCallbacks(playConfirmCheck)
                // 同上，方向相反：不在这里冻结，壁纸会按 playing=true 一路外推到时间轴
                // 尽头，那一句歌词就永远停在那儿 —— 这时候再点播放也回不来了，
                // 因为锚点早就飞出去了。
                syncWallpaperAnchor(false)
            }

            override fun onSkipToNext() {
                handleTransportSkip(+1)
            }

            override fun onSkipToPrevious() {
                handleTransportSkip(-1)
            }

            /**
             * 通知栏进度条被拖动。
             *
             * 光有 ACTION_SEEK_TO 还不够：系统只在 actions 里看到它时才把那条
             * 进度条画成可拖的样子，真正拖完之后调的就是这里。
             */
            override fun onSeekTo(pos: Long) {
                handleTransportSeek(pos)
            }

            override fun onStop() {
                sendCommand("stop")
                mediaSession?.setActive(false)
                stopForegroundCompat()
                stopSelf()
            }

            /**
             * 「喜欢 / 取消喜欢」。
             *
             * 系统媒体控制器（锁屏、Android Auto、蓝牙与车机）按下我们自己声明的那颗心时
             * 走这里。原生**不自己改 cachedLiked** —— 真正知道这首歌在各平台「我喜欢」里
             * 是什么状态的只有 Web 层（本地歌、Navidrome、各家在线平台各一套），点了只发
             * 命令，等那边把新状态推回来（见 updateMetadata）。
             *
             * 提前把 cachedLiked 翻过来的话，请求失败时通知栏会一直停在错的状态上，
             * 而且没有任何东西会再来纠正它。
             */
            override fun onCustomAction(action: String, extras: android.os.Bundle) {
                if (ACTION_TOGGLE_LIKE == action) {
                    handleTransportLike()
                }
            }
        })
        session.setActive(true)
        // 通知栏的播放/暂停等动作直接复用 MediaSession 的控制，不再各自维护一套。
        session.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS)
        session.setPlaybackState(PlaybackStateCompat.Builder()
                .setActions(supportedActions())
                .setState(PlaybackStateCompat.STATE_NONE, 0, 1.0f)
                .build())
    }

    /**
     * 把「播 / 停」立刻同步给壁纸与悬浮小窗那一侧，不等 Web 层回话。
     *
     * 通知栏的播放 / 暂停是**在后台**按下的，而后台 WebView 的 JS 定时器会被系统挂起，
     * `useLyricsWallpaperFeed` 里负责推 playing 的那几个 effect 一个都跑不起来，
     * 命令发出去之后没人替壁纸更新状态。原生这一侧是「锚点 + 墙钟」自己往前推的，
     * 所以漏一次同步就再也回不来：
     *   暂停漏了 → 按 playing=true 一路外推到时间轴尽头，那一句歌词停在那儿；
     *   播放漏了 → 冻在旧锚点上，进度纹丝不动。
     *
     * 位置取壁纸侧**此刻自己算出来的那个**（屏幕上正在显示的就是它，接着它走才不会跳），
     * 再夹进 [0, 时长]：万一已经跑飞了，至少先落回一个合法位置。
     */
    private fun syncWallpaperAnchor(playing: Boolean) {
        /*
         * 只同步「播 / 停」这个事实，**不重设位置**。
         *
         * 以前这里连位置一起写（取壁纸侧自己算出来的那个）。问题是这个函数在播放 / 暂停
         * 每一拍都会被调，而壁纸侧的位置是「锚点 + 墙钟」外推出来的 —— 把它当成新锚点写
         * 回去，等于把外推量抹平后重新起算，一次两次看不出来，**但用户拖完进度条之后
         * 紧接着按暂停 / 播放时，这一写就把刚拖到的位置连同外推误差一起钉住**：
         * 悬浮叠层先跳到拖动目标、又弹回旧位置、再跟上，也就是那个「回弹」
         * （用户原话：「拖动进度条回弹是叠加悬浮窗歌词回弹（跟随播放页）」）。
         *
         * 位置该由真正知道它的那一方写：拖动走 setSeekAnchor（见 handleTransportSeek），
         * Web 层的推送走 publish / setAnchor。这里只需要把 playing 翻过去。
         */
        top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setPlaying(playing)
        top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                .shared(this).invalidateOverlay()
    }

    /**
     * 壁纸那一侧**此刻自己算出来**的位置，夹进 [0, 时长]。
     *
     * 屏幕上正在显示的就是它，接着它走才不会跳；万一已经跑飞了（暂停没同步、被外推到
     * 时间轴尽头），至少先落回一个合法位置。
     */
    private fun clampedAnchorPosition(): Long {
        val snapshot: top.izuna.foliamajor.wallpaper.WallpaperLyricsState.Snapshot =
                top.izuna.foliamajor.wallpaper.WallpaperLyricsState.get()
        var position = snapshot.positionMs()
        if (snapshot.durationMs > 0L && position > snapshot.durationMs) {
            position = snapshot.durationMs
        }
        if (position < 0L) {
            position = 0L
        }
        return position
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 无条件先兑现一次前台化：startForegroundService 开的那道 5 秒倒计时**不看 intent**，
        // 而服务已经存在时 onCreate 不会再跑（promoteToForeground 里那句「已前台就返回」
        // 让它几乎没有开销）。放在 action 判断里面的话，一条没带 action 的
        // startForegroundService 就永远等不到 startForeground()。
        promoteToForeground()
        if (intent != null) {
            val action: String? = intent.getAction()
            if (action != null) {
                when (action) {
                    ACTION_UPDATE_METADATA -> updateMetadata(intent)
                    ACTION_UPDATE_STATE -> updatePlaybackState(intent)
                    ACTION_UPDATE_QUEUE_MIRROR -> {
                        mirroredQueueJson = intent.getStringExtra(EXTRA_QUEUE_MIRROR_JSON)
                        mirroredIndex = intent.getIntExtra(EXTRA_QUEUE_MIRROR_INDEX, -1)
                    }
                    ACTION_UPDATE_QUEUE_INDEX -> {
                        // 队列本体不变、只是换了一首正播的：轻量更新游标。全量队列一推
                        // 几百 KB，不能跟着切歌一起反复过桥。
                        mirroredIndex = intent.getIntExtra(EXTRA_QUEUE_MIRROR_INDEX, -1)
                    }
                    ACTION_SCHEDULE_LIKE_FALLBACK -> {
                        // 通知栏 / 锁屏那颗心走 FoliaCommandReceiver，不经 MediaSession 回调，
                        // 由接收器转成这条 action 把兜底计时器挂上。
                        scheduleLikeFallback()
                    }
                    ACTION_MEDIA_COMMAND -> {
                        // 通知栏 / 锁屏按钮的 next / previous / like：先进服务挂兜底，
                        // JS 那份命令由服务统一发（接收器不再直派，免得两份）。
                        handleMediaCommand(intent)
                    }
                    ACTION_REFRESH_METADATA -> {
                        // ColorOS 原生歌词到的比播放晚（Web 层先拿到词）时用这条：
                        // 只按缓存重建 metadata 与 PlaybackState，不动前台化状态。
                        applyMetadata()
                        applyPlaybackState()
                    }
                    ACTION_STOP_FOREGROUND -> {
                        stopForegroundCompat()
                        stopSelf()
                        return START_NOT_STICKY
                    }
                    else -> {
                    }
                }

                // 重建 MediaSession：进程被杀后 START_STICKY 只会重跑 onStartCommand，
                // 不会走 onCreate 的初始化路径。
                ensureMediaSession()
                // 内容变了，通知要跟着重建（前台化本身在 onCreate 就已经完成）。
                promoteToForeground()
            }
        }
        // START_STICKY：进程被系统回收后（仍处于播放状态）尽量重建服务。
        return START_STICKY
    }

    override fun onBind(intent: Intent?): android.os.IBinder? {
        return null
    }

    override fun onDestroy() {
        running = false
        if (snapshotSource == this) {
            snapshotSource = null
        }
        // 实例要没了：那次等确认的检查也跟着撤掉（它持着 this）。
        playConfirmPending = false
        mainHandler.removeCallbacks(playConfirmCheck)
        // 心跳巡检也跟着撤：服务都死了，没人有资格替播放管线敲心跳。
        mainHandler.removeCallbacks(heartbeatTick)
        // 实例没了，前台状态必须跟着清：它是静态的，进程还在时插件靠它选
        // startService / startForegroundService。留着 true 会让下一次创建的实例跳过
        // startForeground()，而那条路是 startForegroundService 开的 —— 5 秒后就是
        // ForegroundServiceDidNotStartInTimeException。（onCreate 里也重置一次，双保险。）
        foregrounded = false
        cachedNotification = null
        if (mediaSession != null) {
            mediaSession?.setActive(false)
            mediaSession?.release()
            mediaSession = null
        }
        super.onDestroy()
    }

    /**
     * 把 JS 侧的播放/切歌意图转回 WebView。
     *
     * 用广播而不是直接调 Bridge：Service 与 Activity 是不同组件，
     * BridgeActivity 的实例可能已随后台被回收，广播由注册在 WebView 侧的
     * Capacitor Bridge 插件接收，无论 Activity 是否还在都能收到。
     */
    private fun sendCommand(command: String) {
        // 必须写死组件名：Android 8+ 的隐式广播不会投递给清单注册的接收器。
        val intent = Intent(this, FoliaCommandReceiver::class.java)
        intent.setAction(ACTION_WEB_COMMAND)
        intent.putExtra(EXTRA_COMMAND, command)
        sendBroadcast(intent)
    }

    /** 带位置的命令（目前只有拖动进度条的 seek 用得到）。 */
    private fun sendCommand(command: String, positionMs: Long) {
        val intent = Intent(this, FoliaCommandReceiver::class.java)
        intent.setAction(ACTION_WEB_COMMAND)
        intent.putExtra(EXTRA_COMMAND, command)
        intent.putExtra(EXTRA_COMMAND_POSITION, positionMs)
        sendBroadcast(intent)
    }

    /** 带歌名的命令（syncTo：原生兜底切歌后叫 JS 把队列跳到原生正在放这首）。 */
    private fun sendCommand(command: String, positionMs: Long, songKey: String?) {
        val intent = Intent(this, FoliaCommandReceiver::class.java)
        intent.setAction(ACTION_WEB_COMMAND)
        intent.putExtra(EXTRA_COMMAND, command)
        intent.putExtra(EXTRA_COMMAND_POSITION, positionMs)
        intent.putExtra(EXTRA_SONG_KEY, songKey)
        sendBroadcast(intent)
    }

    /**
     * 原生播放激活：原生播放器手上真有这首歌（在放或暂停着）。
     *
     * 这个状态下通知栏 / 锁屏 / 耳机的操作**直接在原生做完**，不再走
     * 「广播给 JS、等它回话、超时才原生兜底」那条链 —— 那条链的兜底要
     * 2.5~5 秒才轮到原生，用户看到的就是「秒切不秒、红心过一会才亮、
     * 进度条拖了没反应」。原生激活意味着地址、队列镜像、红心身份原生全有，
     * 没有任何一件事必须等 WebView。
     */
    private fun nativePlaybackActive(): Boolean {
        return top.izuna.foliamajor.player.FoliaNativePlayerPlugin.hasActiveMedia()
    }

    /** App 内下一首/上一首走原生的公开入口（插件直调，同步回执能不能受理）。 */
    fun transportSkip(direction: Int): Boolean {
        return handleTransportSkip(direction)
    }

    /**
     * 下一首 / 上一首（通知栏、锁屏、耳机线控、App 内按钮共用）。
     *
     * 回 true = 已受理（原生切了，或已交给 JS 那条路）；false = 镜像里定位不到
     * 相邻首（App 内按钮据此回退到 Web 全流程，通知栏路径不回退、等 JS）。
     */
    private fun handleTransportSkip(direction: Int): Boolean {
        if (nativePlaybackActive()) {
            // 镜像直接切：预取命中是瞬时的，没命中也就一趟平台请求（后台线程）。
            // App 内的队列对齐靠原生守卫（JS 推旧 metadata 时发 syncTo）与
            // 打开 App 时的快照认领，不在这里广播 "next" —— JS 那条 playSong
            // 慢链会跟原生抢同一首歌。
            return skipViaMirror(direction)
        }
        sendCommand(if (direction > 0) "next" else "previous")
        scheduleSkipFallback(direction)
        return true
    }

    /** App 内点歌 / 切歌走原生（两轨合一）的入口：见 FoliaPlaybackPlugin.playFromQueue。 */
    fun playFromQueue(songKey: String?, queueJson: String?, index: Int): Boolean {
        if (songKey == null || songKey.isEmpty()) {
            return false
        }
        // 调用方手里的队列是最新的（JS 刚排好、镜像 effect 可能还没跑），先落下来。
        if (queueJson != null && !queueJson.isEmpty()) {
            mirroredQueueJson = queueJson
            mirroredIndex = index
        }
        val json = mirroredQueueJson
        if (json == null) {
            return false
        }
        try {
            val array = org.json.JSONArray(json)
            var target = index
            if (target < 0) {
                // 没带 index 就在镜像里找。
                for (i in 0 until array.length()) {
                    val item = array.optJSONObject(i)
                    if (item != null && songKey == item.optString("songKey", "")) {
                        target = i
                        break
                    }
                }
            }
            if (target < 0 || target >= array.length()) {
                return false
            }
            val entry = array.optJSONObject(target)
            if (entry == null) {
                return false
            }
            mirroredIndex = target
            var url = resolvedUrlCache.get(songKey)
            if (url == null || url.isEmpty()) {
                url = entry.optString("url", "")
            }
            if (url != null && !url.isEmpty()) {
                nativePlayMirrorEntry(entry, url)
                preloadMirrorNeighbors(array, target, +1)
                return true
            }
            resolveMirrorEntryAsync(array, entry, target, target, +1)
            return true
        } catch (ignored: org.json.JSONException) {
            return false
        }
    }

    /** 拖进度条（通知栏、锁屏共用）。 */
    private fun handleTransportSeek(positionMs: Long) {
        if (nativePlaybackActive()) {
            val pos = Math.max(0L, positionMs)
            top.izuna.foliamajor.player.FoliaNativePlayerPlugin.seekFromSystem(pos)
            cachedPositionMs = pos
            publishSnapshot()
            applyPlaybackState()
            publishNotification()
        } else {
            sendCommand("seek", positionMs)
        }
        /*
         * 壁纸 / 悬浮窗那边的锚点**这里就对齐**，不等 Web 层回话。
         *
         * 不能指望 Web 层那条 seek 检测（`useLyricsWallpaperFeed` 里的轮询）：
         * App 退到后台之后 WebView 的 JS 定时器会被系统挂起，而拖通知栏进度条
         * 恰恰就是在后台发生的 —— 那条路一挂，锚点永远不更新，歌词就停在原地。
         */
        val playing = cachedState == PlaybackStateCompat.STATE_PLAYING
        // setSeekAnchor：写锚点的同时打开回弹守卫窗 —— JS 那边音频还没 seek 完时
        // 推来的旧位置（守卫窗内的位置回退）会被状态层丢掉，见 WallpaperLyricsState。
        top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setSeekAnchor(
                Math.max(0L, positionMs), playing)
        top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                .shared(this@FoliaPlaybackService).invalidateOverlay()
    }

    /** 「喜欢 / 取消喜欢」（通知栏、锁屏、系统媒体控制器共用）。 */
    private fun handleTransportLike() {
        if (nativePlaybackActive()) {
            // 0 延迟亮心：toggleLikeNatively 先翻状态再后台写平台，失败自己翻回。
            // 不发 "like"：JS handleLike 也会写一遍平台，两次写状态翻两遍等于没点。
            // App 里那颗心的对齐在写成功之后（toggleLikeNatively 里发 likeDone）——
            // 发早了 JS 还 consume 不到记录（记录是写成功才落盘的）。
            toggleLikeNatively()
            return
        }
        sendCommand("like")
        scheduleLikeFallback()
    }

    /**
     * 通知栏 / 锁屏按钮的 next / previous / like。
     *
     * 与 MediaSession 回调同一段逻辑：命令照旧广播给 JS，同时挂原生兜底计时器 ——
     * JS 回话（推出新 metadata）就收手；WebView 冻结时由镜像换源 / 原生补写红心接管。
     * 以前这一段只挂在 MediaSession 回调上，通知栏按钮根本到不了这里，
     * 「上一首 / 下一首用不了」就是这条断链。
     */
    private fun handleMediaCommand(intent: Intent) {
        val command = intent.getStringExtra(EXTRA_COMMAND)
        if (command == null) {
            return
        }
        when (command) {
            "next" -> handleTransportSkip(+1)
            "previous" -> handleTransportSkip(-1)
            "like" -> handleTransportLike()
            "seek" -> {
                val positionMs = intent.getLongExtra(EXTRA_COMMAND_POSITION, 0L)
                // 原生激活时直接在原生跳（handleTransportSeek），不等桥死；
                // 桥活着但原生手上没歌（<audio> 在播）时照旧交 JS。
                handleTransportSeek(positionMs)
            }
            "play" -> {
                /*
                 * 与 MediaSession 的 onPlay 同一条纪律：命令同时直接给原生播放器一份。
                 *
                 * 之前这里和 pause 一起落在下面的 else 里，只转给 JS —— 而通知栏 / 锁屏按
                 * 播放的时候 WebView 在后台，JS 定时器被系统挂起，`resumePlayback` 压根
                 * 跑不起来。表现就是「后台按了播放，一点反应都没有」。上一首 / 下一首
                 * 早就有原生兜底了，播放 / 暂停反而没有，这条链路一直是断的。
                 */
                try {
                    top.izuna.foliamajor.player.FoliaNativePlayerPlugin.resumeFromSystem()
                } catch (ignored: Throwable) {
                    // 原生播放器不在（没开原生播放 / 插件没编进来）：交给 Web 那条路。
                }
                FoliaPlaybackPlugin.dispatchCommandFromReceiver(command,
                        intent.getLongExtra(EXTRA_COMMAND_POSITION, 0L), null)
            }
            "pause" -> {
                // 同上，方向相反（见 MediaSession 的 onPause）。
                try {
                    top.izuna.foliamajor.player.FoliaNativePlayerPlugin.pauseFromSystem()
                } catch (ignored: Throwable) {
                    // 同上。
                }
                FoliaPlaybackPlugin.dispatchCommandFromReceiver(command,
                        intent.getLongExtra(EXTRA_COMMAND_POSITION, 0L), null)
            }
            else -> {
                // stop 没有原生兜底可做，原路转给 JS。
                FoliaPlaybackPlugin.dispatchCommandFromReceiver(command,
                        intent.getLongExtra(EXTRA_COMMAND_POSITION, 0L), null)
            }
        }
    }

    /**
     * 「下一首/上一首」的确认计时器：命令照旧广播给 JS，同时等它回话。
     *
     * WebView 冻结时 JS 一条命令都不会执行 —— {@link #lastMetadataAtMs} 不动，
     * 超时就用镜像队列在原生直接换源（{@link #skipViaMirror}）。JS 活着时它会在
     * 窗口内推来新歌的元数据，计时器看到时间戳变了就收手，两路不打架。
     */
    private fun scheduleSkipFallback(direction: Int) {
        val before = lastMetadataAtMs
        mainHandler.postDelayed({
            if (lastMetadataAtMs != before) return@postDelayed
            // 播放器壳子不在（WebView 从没起来过 / Bridge 已销毁）：镜像也没处换源，只能等 JS。
            // 注意判的是 hasPlayer 而不是 hasActiveMedia —— 当前这首走 <audio> 时原生手上
            // 没东西，但照样能 prepare 一条镜像地址接管播放。
            if (!top.izuna.foliamajor.player.FoliaNativePlayerPlugin.hasPlayer()) return@postDelayed
            skipViaMirror(direction)
        }, SKIP_FALLBACK_MS)
    }

    /**
     * 红心的原生兜底计时器：命令照旧广播给 JS，同时等它回话。
     *
     * JS 的「回话」在这里的定义与切歌兜底一致：**它有没有推出新的 metadata**。
     * 收藏成功（或失败）都会让 Web 层推一次元数据（liked 字段变了），于是
     * {@link #lastMetadataAtMs} 前进，计时器看到就收手。WebView 冻结时它永远不前进，
     * 超时后按当前歌的平台身份直接对各平台服务器补写（{@link #toggleLikeNatively}）。
     */
    private fun scheduleLikeFallback() {
        val before = lastMetadataAtMs
        mainHandler.postDelayed({
            if (lastMetadataAtMs != before) return@postDelayed
            toggleLikeNatively()
        }, LIKE_FALLBACK_MS)
    }

    /**
     * 原生补写红心：**先亮心、再写服务器**，失败才翻回去。
     *
     * 写入是一趟网络（几秒级），通知栏不先变样子用户只能当是卡了 ——
     * 用户原话：「红心点击需要马上点亮，不是过一会自己亮」。写成功把结果
     * 记进 {@link LikeOverrideStore}（切歌之后红心以它为准：镜像里的 liked
     * 是 JS 账号缓存的旧快照，服务器的「我喜欢」歌单也不保证马上刷新）。
     */
    private fun toggleLikeNatively() {
        if (likeFallbackInFlight) return
        if (!cachedCanLike) return
        val providerId = cachedProviderId
        val songId = cachedServerSongId
        val songKey = cachedSongKey
        val wanted = !cachedLiked
        if (providerId.isEmpty() || songId.isEmpty()) return
        likeFallbackInFlight = true
        // 先就地亮心（主线程上这些字段本来就是它自己写的）。请求失败翻回去；
        // 期间用户切了歌就以新歌的状态为准，不再翻。
        cachedLiked = wanted
        publishSnapshot()
        applyPlaybackState()
        publishNotification()
        // 网络与 CookieManager 都不能上主线程：桥的线程规则（memory 15）在这里同样适用。
        Thread({
            var ok = false
            try {
                ok = top.izuna.foliamajor.online.LikeFallback.setLiked(providerId, songId, wanted)
            } finally {
                likeFallbackInFlight = false
            }
            if (!ok) {
                mainHandler.post {
                    if (providerId != cachedProviderId || songId != cachedServerSongId) {
                        return@post
                    }
                    cachedLiked = !wanted
                    publishSnapshot()
                    applyPlaybackState()
                    publishNotification()
                }
                return@Thread
            }
            // 记账：JS 醒来推旧状态时，updateMetadata 按这张表以原生写入为准；
            // 原生兜底切歌也读它（nativePlayMirrorEntry），切歌不打回原形。
            top.izuna.foliamajor.online.LikeOverrideStore.record(
                    this, songKey, providerId, songId, wanted)
            // 落了盘再知会 JS：App 里那颗心按这张表对齐（consume → applyNativeLikeOverrides）。
            // 发早了记录还没落，JS 那边什么都领不到。
            mainHandler.post { sendCommand("likeDone") }
        }, "folia-like-fallback").start()
    }

    /**
     * 从镜像队列取相邻一首，原生直接换源并自更新通知元数据。
     * 回 false = 镜像缺位（调用方据此决定要不要回退到 JS 全流程）。
     */
    private fun skipViaMirror(direction: Int): Boolean {
        val json = mirroredQueueJson
        val index = mirroredIndex
        if (json == null || index < 0) return false
        try {
            val array = org.json.JSONArray(json)
            val count = array.length()
            if (count == 0) return false
            /*
             * 走到头**回绕**，而不是停下。
             *
             * 以前这里越界就 return false，交给 JS 全流程 —— 而这一步多半发生在 WebView
             * 被挂起的时候（正是这条兜底存在的场合），于是最后一首放完就彻底没声音了
             * （用户报的「原生的放完了不会自动下一首」）。回绕与 Web 层的队列语义一致：
             * 列表循环绕回第一首，单曲循环/顺序播放由 JS 那条路优先处理（它先认领就没
             * 走到这里）。随机播放更该回绕 —— 见下面那段「随机」处理。
             */
            val target = index + direction
            val wrapped = when {
                target < 0 -> count - 1
                target >= count -> 0
                else -> target
            }
            val entry = array.getJSONObject(wrapped)
            val songKey = entry.optString("songKey", "")
            var url = if (songKey.isEmpty()) null else resolvedUrlCache.get(songKey)
            if (url == null || url.isEmpty()) {
                url = entry.optString("url", "")
            }
            if (url != null && !url.isEmpty()) {
                mirroredIndex = wrapped
                nativePlayMirrorEntry(entry, url)
                /*
                 * 回绕那一格是队首：预取方向也要跟着换（否则会去预取队首的「下一首」，
                 * 而那首刚刚才放完，真正该备的是队首之后那一首 —— 上面已经这么做，
                 * 这里只是把回绕也纳入同一套）。
                 */
                preloadMirrorNeighbors(array, wrapped, direction)
                return true
            }
            // 地址没解析出来（预取没命中）：原生平台网关直接向平台要一个。镜像窗口里
            // 每首歌的身份（providerId / serverSongId / songmid）都在，缺的只是地址 ——
            // 这就是「连按几首下一首就切不动」的解药。解析在后台线程（桥的线程规则），
            // 成了回主线程换源；期间用户又按了的，以 mirroredIndex 为准作废重算。
            resolveMirrorEntryAsync(array, entry, wrapped, index, direction)
            return true
        } catch (ignored: org.json.JSONException) {
            return false
        }
    }

    /**
     * 后台向平台要地址。只认「出发时那一格」还没被动过的请求：解析一趟网络的时间里
     * 用户可能又按了下一首，回来的这一份已经不对题，丢弃（用户按的那一次有自己的请求）。
     */
    private fun resolveMirrorEntryAsync(array: org.json.JSONArray, entry: org.json.JSONObject,
                                        target: Int, originIndex: Int, direction: Int) {
        val providerId = entry.optString("providerId", "")
        val songId = entry.optString("serverSongId", "")
        val mid = entry.optString("providerMid", "")
        val hash = entry.optString("providerHash", "")
        val albumAudioId = entry.optString("providerAlbumAudioId", "")
        if (providerId.isEmpty() || (songId.isEmpty() && mid.isEmpty() && hash.isEmpty())) {
            return
        }
        val songKey = entry.optString("songKey", "")
        Thread({
            val url = top.izuna.foliamajor.online.MusicGateway.resolvePlayUrl(
                    providerId, songId, mid, hash, albumAudioId)
            if (url == null || url.isEmpty()) {
                // App 内点歌走原生（两轨合一）时的失败回执：JS 收到后把这首歌
                // 标进本会话的黑名单并回退到 Web 全流程，别让界面停在转圈。
                // 通知栏兜底切歌的失败本来就没有 JS 可回退，多发的这条它自己不认。
                if (!songKey.isEmpty()) {
                    mainHandler.post { sendCommand("nativePlayFailed", 0L, songKey) }
                }
                return@Thread
            }
            if (!songKey.isEmpty()) {
                resolvedUrlCache.put(songKey, url)
            }
            mainHandler.post {
                if (mirroredIndex != originIndex) return@post
                mirroredIndex = target
                nativePlayMirrorEntry(entry, url)
                preloadMirrorNeighbors(array, target, direction)
            }
        }, "folia-resolve-url").start()
    }

    /**
     * 悄悄把相邻几首的地址要回来 —— **两个方向都要**：上一首同样要秒切，
     * 不能只备着往前走的那头（用户原话「上一首下一首提前加载」）。
     * 当前这首起播时邻居多半还没人要过 —— 等用户按下再要就是一趟看得见的等待；
     * 预取就是「秒切」和「转圈」的区别。
     */
    private fun preloadMirrorNeighbors(array: org.json.JSONArray, target: Int, direction: Int) {
        val steps = intArrayOf(direction, -direction, direction * 2, -(direction * 2))
        for (step in steps) {
            val idx = target + step
            if (idx < 0 || idx >= array.length()) continue
            try {
                val entry = array.getJSONObject(idx)
                val key = entry.optString("songKey", "")
                if (key.isEmpty() || resolvedUrlCache.containsKey(key)) continue
                val existing = entry.optString("url", "")
                if (!existing.isEmpty()) {
                    resolvedUrlCache.put(key, existing)
                    continue
                }
                val providerId = entry.optString("providerId", "")
                val songId = entry.optString("serverSongId", "")
                val mid = entry.optString("providerMid", "")
                val hash = entry.optString("providerHash", "")
                val albumAudioId = entry.optString("providerAlbumAudioId", "")
                if (providerId.isEmpty() || (songId.isEmpty() && mid.isEmpty() && hash.isEmpty())) continue
                Thread({
                    val url = top.izuna.foliamajor.online.MusicGateway.resolvePlayUrl(
                            providerId, songId, mid, hash, albumAudioId)
                    if (url != null && !url.isEmpty()) {
                        resolvedUrlCache.put(key, url)
                    }
                }, "folia-preload-url").start()
            } catch (ignored: org.json.JSONException) {
            }
        }
    }

    /** 用镜像条目直接接管播放：换源、起播、通知与壁纸锚点全部就地更新。 */
    private fun nativePlayMirrorEntry(entry: org.json.JSONObject, url: String) {
        top.izuna.foliamajor.player.FoliaNativePlayerPlugin.prepareFromSystem(url)
        top.izuna.foliamajor.player.FoliaNativePlayerPlugin.resumeFromSystem()
        val songKey = entry.optString("songKey", "")
        val songChanged = !songKey.isEmpty() && songKey != cachedSongKey
        if (songChanged) {
            cachedSongKey = songKey
            cachedArtwork = null
            cachedDurationMs = 0L
            pendingArtworkUrl = null
            cachedLiked = false
            cachedCanLike = false
            cachedProviderId = ""
            cachedServerSongId = ""
            // 真源守卫：JS 醒来推的还是旧歌时不许覆盖这里的结果（见 updateMetadata）。
            nativeSkipSongKey = songKey
            /*
             * 界面认领也**主动**发一份，不等 JS 自己推 metadata 时被守卫拦下再补。
             * 通知栏切歌常常就发生在用户盯着 App 的时候 —— 守卫那条路要等 JS 恰好
             * 推一次 metadata 才触发，界面的歌词封面可能一直停在旧歌上。JS 侧
             * （onSyncToSong）在原生播放激活时只对齐显示，不会重装源，两边不打架。
             */
            sendCommand("syncTo", 0L, songKey)
        }
        val title = entry.optString("title", "")
        if (!title.isEmpty()) cachedTitle = title
        val artist = entry.optString("artist", "")
        if (!artist.isEmpty()) cachedArtist = artist
        val album = entry.optString("album", "")
        if (!album.isEmpty()) cachedAlbum = album
        // 镜像条目带上服务器侧身份与红心状态（Web 层为每一条都带，见桥接 hook 的
        // 说明）：原生兜底切歌之后，那颗心与红心兜底才不会一齐消失。
        val entryProvider = entry.optString("providerId", "")
        if (!entryProvider.isEmpty()) cachedProviderId = entryProvider
        val entrySongId = entry.optString("serverSongId", "")
        if (!entrySongId.isEmpty()) cachedServerSongId = entrySongId
        if (entry.has("liked")) cachedLiked = entry.optBoolean("liked", false)
        if (entry.has("canLike")) cachedCanLike = entry.optBoolean("canLike", false)
        // 原生补写过的红心以记录为准：镜像里的 liked 是 JS 推全量那一刻的快照，
        // 冻结期间点过的心它不知道（用户原话「点了需要缓存，因为歌单不一定马上刷新」）。
        val overridden = top.izuna.foliamajor.online.LikeOverrideStore.likedOf(this, songKey)
        if (overridden != null) cachedLiked = overridden
        // 「我喜欢」名单里的真状态（五家平台都有原生通道，见 MusicGateway.likedListContains）：
        // 镜像快照可能旧了 —— 比如用户在平台自己的 App 里点过心。后台对一遍，不同就
        // 就地换心；补写记录比名单新鲜（服务端不保证马上刷新），有记录时以记录为准。
        if (songChanged && !cachedProviderId.isEmpty()
                && (!cachedServerSongId.isEmpty()
                || !entry.optString("providerMid", "").isEmpty()
                || !entry.optString("providerHash", "").isEmpty())) {
            val likedProviderId = cachedProviderId
            val likedSongId = cachedServerSongId
            val likedMid = entry.optString("providerMid", "")
            val likedHash = entry.optString("providerHash", "")
            Thread({
                val truth = top.izuna.foliamajor.online.MusicGateway.likedListContains(
                        likedProviderId, likedSongId, likedMid, likedHash)
                if (truth == null) return@Thread
                mainHandler.post {
                    if (likedProviderId != cachedProviderId
                            || likedSongId != cachedServerSongId) return@post
                    val record = top.izuna.foliamajor.online.LikeOverrideStore.likedOf(this, songKey)
                    if (record != null) return@post
                    if (truth != cachedLiked) {
                        cachedLiked = truth
                        publishSnapshot()
                        applyPlaybackState()
                        publishNotification()
                    }
                }
            }, "folia-liked-refresh").start()
        }
        val entryDuration = entry.optLong("durationMs", 0L)
        if (entryDuration > 0L) cachedDurationMs = entryDuration
        cachedState = PlaybackStateCompat.STATE_PLAYING
        cachedPlaying = true
        cachedPositionMs = 0L
        cachedSpeed = 1.0f
        // 自己就是「回话」：否则下一个计时器会再跳一首。
        lastMetadataAtMs = android.os.SystemClock.elapsedRealtime()
        applyMetadata()
        applyPlaybackState()
        promoteToForeground()
        syncWallpaperAnchor(true)
        val artworkUrl = entry.optString("artworkUrl", "")
        if (!artworkUrl.isEmpty()) {
            // 叠层那份 WebView 的封面读的是地址（GLES 那层读 base64，下载完在
            // fetchArtwork 里补），通知栏那张也走这里。
            top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setCoverUrl(artworkUrl)
            if (artworkUrl != pendingArtworkUrl) {
                pendingArtworkUrl = artworkUrl
                fetchArtwork(artworkUrl)
            }
        }
        if (songChanged) {
            fetchLyricForNativePlayback(songKey,
                    if (entryProvider.isEmpty()) cachedProviderId else entryProvider,
                    if (entrySongId.isEmpty()) cachedServerSongId else entrySongId,
                    entry.optString("providerMid", ""),
                    entry.optString("providerHash", ""),
                    entryDuration)
        }
    }

    /**
     * 原生兜底切歌之后把这首歌的歌词拉回来直接喂给壁纸。
     *
     * WebView 冻结时 Web 那条「换歌推整条时间轴」不会来，壁纸与叠层就停在上一首的
     * 歌词与封面上（用户报的「下一首歌词不会拉、壁纸封面歌词都不改」）。这里用原生
     * 平台网关（MusicGateway）向平台要 LRC，解成时间轴就地发布 —— 覆盖范围与取流
     * 地址一致：网易与 QQ。纯音乐 / 拉不到就保持原状（壁纸继续放上一首的歌词，
     * 总比清空成黑屏好）。
     */
    private fun fetchLyricForNativePlayback(songKey: String, providerId: String, songId: String,
                                            mid: String, hash: String, durationMs: Long) {
        if (providerId.isEmpty() || (songId.isEmpty() && mid.isEmpty() && hash.isEmpty())) {
            return
        }
        val title = cachedTitle
        val artist = cachedArtist
        val artworkUrl = pendingArtworkUrl
        Thread({
            val lyric =
                    top.izuna.foliamajor.online.MusicGateway.fetchLyric(providerId, songId, mid, hash)
            if (lyric == null || lyric.mainLrc.isEmpty()) {
                return@Thread
            }
            val lines = top.izuna.foliamajor.online.MusicGateway.parseLrc(lyric.mainLrc, lyric.transLrc)
            if (lines.isEmpty()) {
                return@Thread
            }
            // 解析这一趟网络的时间里可能又切了一首：只认还在放的那首。
            if (songKey != cachedSongKey) {
                return@Thread
            }
            mainHandler.post {
                if (songKey != cachedSongKey) return@post
                top.izuna.foliamajor.wallpaper.WallpaperLyricsState.publishNativeTrack(
                        title, artist, artworkUrl, durationMs,
                        lines.toTypedArray())
            }
        }, "folia-native-lyric").start()
    }

    /**
     * 把服务顶到前台。
     *
     * 通知构造失败不该把整个应用带走：startForeground 抛异常意味着
     * 系统判定「前台服务没起来」，紧接着就是进程被杀，用户看到的就是闪退。
     * 这里兜住异常，宁可没有通知也要保住播放。
     */
    private fun promoteToForeground() {
        /*
         * 已经在前台就直接返回 —— 这里有守卫是**省掉一整笔开销**，不是偷懒：
         *
         * startForeground() 会把通知整个跨进程交给系统，通知里带着 512×512 的封面
         * Bitmap（约 1 MB）。而播放位置是每秒推一次的，没有这道守卫就等于每秒
         * 在主线程上搬一次 1 MB —— 播放页单帧本来就要二三十毫秒，被它定期拖一下
         * 就成了肉眼可见的卡顿。
         *
         * 那「每一条 startForegroundService 都要在 5 秒内 startForeground() 兑现」
         * 这条怎么办？由**发送方**负责：FoliaPlaybackPlugin 只在服务还没前台时才用
         * startForegroundService（见 startServiceCompat），服务已经在前台时改走普通
         * startService —— 那条路不会开倒计时，也就不需要在这里兑现。
         */
        if (foregrounded) {
            return
        }
        /*
         * 先用**占位**通知把前台化兑现掉，再贴完整的那条。
         *
         * 分开是为了一个真崩过的堆栈：ForegroundServiceDidNotStartInTimeException ——
         * startForegroundService() 之后系统只给 5 秒，超时直接杀进程。而完整通知不是白来的：
         * 它要 getLaunchIntentForPackage()（PackageManager 的跨进程调用）和四个
         * PendingIntent.getBroadcast/getActivity（每次都要跟 system_server 打交道），
         * 冷启动时主线程正被 WebView 首帧与那一大包 JS 占满，系统侧一忙这些调用能排到秒级。
         * 「兑现」与「好看」就此分开：前者用一条什么都不带的通知，几乎零成本；
         * 后者再慢也无所谓 —— 倒计时已经不可能超时了。
         */
        try {
            startForeground(NOTIFICATION_ID, buildPlaceholderNotification())
            foregrounded = true
        } catch (error: Throwable) {
            Log.e(TAG, "startForeground failed; keeping the service alive without it", error)
            return
        }
        // 心跳中断时 session 被撤过（withdrawMediaNotification）：重新拉起来，
        // 否则 MediaStyle 通知挂在一只失活的 session 上，按钮全是死键。
        if (mediaSession?.isActive() == false) {
            try {
                mediaSession?.setActive(true)
            } catch (ignored: Throwable) {
            }
        }
        // 前台化已经兑现，这里再抛异常也不会被系统杀掉，只是通知暂时不完整。
        try {
            cachedNotification = buildForegroundNotification()
            notificationManager?.notify(NOTIFICATION_ID, cachedNotification)
        } catch (error: Throwable) {
            Log.e(TAG, "Failed to build the playback notification", error)
        }
    }

    /**
     * 只够兑现前台化的最小通知：一个图标、一个标题，没有按钮、没有封面、不读 PackageManager。
     *
     * 存在的唯一理由就是上面那道 5 秒倒计时。内容随后必被 buildForegroundNotification()
     * 的完整通知覆盖（promoteToForeground 里前台化成功后立刻 notify 一次），
     * 所以它长什么样用户几乎看不到 —— 只在极端拥塞的冷启动里闪一下。
     */
    private fun buildPlaceholderNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Folia")
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .build()
    }

    /**
     * 内容变了：重建通知并贴出去。
     *
     * 已经前台化时用 notify（不重复走 startForeground 那条路），没前台化时只把通知
     * 记下来，等 promoteToForeground() 再贴。
     */
    private fun publishNotification() {
        try {
            cachedNotification = buildForegroundNotification()
            if (foregrounded) {
                notificationManager?.notify(NOTIFICATION_ID, cachedNotification)
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Failed to build the playback notification", error)
        }
    }

    private fun updateMetadata(intent: Intent) {
        /*
         * 原生兜底切歌的真源守卫。
         *
         * WebView 冻结期间原生用镜像换过源之后，JS 醒来第一份 metadata 推的还是它
         * 自己那份旧歌 —— 收下它，通知栏就弹回旧歌，原生正在放的歌反而没了名分
         * （用户说的「一打开 app 立马恢复全部」）。JS 认领（推来同一首）之前别的歌
         * 一概不收，同时发 syncTo 叫它把队列跳过来。代价：守卫期内用户在 App 里点的
         * 别的歌也会被拽回来一次（窗口只有 JS 醒来到第一份推送之间那几秒），
         * 但「通知栏与实际播放对不上」比这个难受得多。
         */
        if (!nativeSkipSongKey.isNullOrEmpty()) {
            val incomingKey = intent.getStringExtra(EXTRA_SONG_KEY)
            if (incomingKey != null && !incomingKey.isEmpty()) {
                if (incomingKey == nativeSkipSongKey) {
                    nativeSkipSongKey = null // JS 认领了，恢复正常通道。
                } else {
                    sendCommand("syncTo", 0L, nativeSkipSongKey)
                    return // 旧歌不收：缓存不动，lastMetadataAtMs 也不前进。
                }
            }
        }
        // JS 回话了：skip 的确认计时器看到这个时间戳变化就会收手，不再用镜像兜底。
        lastMetadataAtMs = android.os.SystemClock.elapsedRealtime()
        val title = intent.getStringExtra(EXTRA_TITLE)
        val artist = intent.getStringExtra(EXTRA_ARTIST)
        val album = intent.getStringExtra(EXTRA_ALBAND)
        val artworkBase64 = intent.getStringExtra(EXTRA_ARTWORK)
        val artworkUrl = intent.getStringExtra(EXTRA_ARTWORK_URL)
        val durationMs = intent.getLongExtra(EXTRA_DURATION, 0L)
        val providerBadge = intent.getStringExtra(EXTRA_PROVIDER_BADGE)
        val songKey = intent.getStringExtra(EXTRA_SONG_KEY)
        if (providerBadge != null) {
            cachedBadgeRes = providerIconRes(providerBadge)
        }

        // 换歌了：先把上一首的封面丢掉。
        //
        // 原来只在 decodeArtwork 拿到新图时才覆盖 cachedArtwork，于是「新封面还没到」和
        // 「这首歌没有封面」这两种情况都会让上一首的 Bitmap 一直挂着 —— 换歌那一刻 Web 层
        // 给的 base64 通常还是 null（封面要抓取 + 编码，慢一拍），通知栏就先画出上一首的
        // 封面，等下面按 URL 的下载跑完才换成当前歌。宁可中间没有大图，也不要错的图。
        if (songKey != null && songKey != cachedSongKey) {
            cachedSongKey = songKey
            cachedArtwork = null
            // 时长也一起清掉：metadata 现在是从缓存整体重建的（见 applyMetadata），
            // 不清的话「新歌还没带时长」会被填成上一首的时长。
            cachedDurationMs = 0L
            // 让这次的 artworkUrl 能重新触发下载（同一个地址在同一首歌里只下一次）。
            pendingArtworkUrl = null
            // 「喜欢」是**这首歌**的属性，换歌时不能沿用上一首的：Web 层这一次 update
            // 里带的就是新歌的值，所以先清、紧接着下面再按 extras 覆盖。
            cachedLiked = false
            cachedCanLike = false
            // 红心兜底用的服务器侧身份同理：宁可空着等这一次 update 带来，
            // 也不能拿着上一首的 id 去给新歌写收藏。
            cachedProviderId = ""
            cachedServerSongId = ""
        }

        // 「喜欢」与否跟着 metadata 一起到：它是当前歌曲的属性，不是播放状态。
        // 用 hasExtra 而不是 getBooleanExtra 的缺省值 —— 缺省 false 会让「没带这个字段」
        // 和「带了 false」分不开，于是任何一次没带的 update 都会把已喜欢抹成未喜欢。
        if (intent.hasExtra(EXTRA_LIKED)) {
            cachedLiked = intent.getBooleanExtra(EXTRA_LIKED, false)
        }
        if (intent.hasExtra(EXTRA_CAN_LIKE)) {
            cachedCanLike = intent.getBooleanExtra(EXTRA_CAN_LIKE, false)
        }
        /*
         * 红心真源守卫：原生补写成功的那一票记在盘上（LikeOverrideStore）。
         * JS 推来的值与记录一致 = 它已经从服务器读回了真状态，记录解除；
         * 不一致 = 它手上还是旧缓存，通知栏以原生写入为准，不让它把心翻回去。
         */
        if (!cachedSongKey.isNullOrEmpty() && intent.hasExtra(EXTRA_LIKED)) {
            val likeOverrides =
                    top.izuna.foliamajor.online.LikeOverrideStore.read(this)
            val own = likeOverrides.optJSONObject(cachedSongKey)
            if (own != null) {
                val overrideLiked = own.optBoolean("liked", false)
                val incomingLiked = intent.getBooleanExtra(EXTRA_LIKED, false)
                if (incomingLiked == overrideLiked) {
                    likeOverrides.remove(cachedSongKey)
                    top.izuna.foliamajor.online.LikeOverrideStore.save(this, likeOverrides)
                } else {
                    cachedLiked = overrideLiked
                }
            }
        }
        // 红心兜底用的服务器侧身份：与 songKey 一起到。没带就保留旧值
        //（老版本 Web 层不推这两个字段，那时原生兜底按「没身份」跳过）。
        val providerId = intent.getStringExtra(EXTRA_PROVIDER_ID)
        if (providerId != null) cachedProviderId = providerId
        val serverSongId = intent.getStringExtra(EXTRA_SERVER_SONG_ID)
        if (serverSongId != null) cachedServerSongId = serverSongId

        // 先更新缓存，再重建通知：metadata 与 state 是两次独立调用，
        // 任何一次都要能拿到完整的通知内容。
        if (title != null) cachedTitle = title
        if (artist != null) cachedArtist = artist
        if (album != null) cachedAlbum = album
        if (durationMs > 0) cachedDurationMs = durationMs
        val artwork = decodeArtwork(artworkBase64)
        if (artwork != null) {
            cachedArtwork = artwork
        }
        publishSnapshot()
        applyMetadata()

        // 封面优先走原生下载：Web 层用 fetch 抓远端封面常常被 CORS 挡掉，
        // 通知栏就只剩一个默认图标。原生侧没有同源限制，拿到再补一次通知。
        if (artworkUrl != null && !artworkUrl.isEmpty()
                && artworkUrl != pendingArtworkUrl) {
            pendingArtworkUrl = artworkUrl
            fetchArtwork(artworkUrl)
        }

        // 已经贴出去的通知要再 post 一次才会带上新内容。
        // （promoteToForeground 只重复贴缓存里那条，不会顺手重建。）
        publishNotification()
    }

    /**
     * 用当前缓存的字段重建 metadata 并写回 MediaSession。
     *
     * 抽成方法是为了让「歌词到了」也能走同一条路（ACTION_REFRESH_METADATA）：
     * 歌词是 metadata 的**附加字段**，不是另一条通道，必须从同一份缓存整体重建，
     * 否则后到的那次会把先到的字段抹成空（封面的老问题就是这个）。
     */
    private fun applyMetadata() {
        val builder = MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, cachedTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, cachedArtist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, cachedAlbum)
        if (cachedDurationMs > 0) {
            builder.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, cachedDurationMs)
        }
        if (cachedArtwork != null) {
            builder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cachedArtwork)
        }
        // ColorOS 原生锁屏歌词：非 ColorOS 16+ 设备上 ColorOsLyricBridge 手里没有 payload，
        // 这里就是个空操作，不会往 metadata 里塞无用字段。
        ColorOsLyricBridge.attach(builder, cachedSongKey)

        if (mediaSession != null) {
            mediaSession?.setMetadata(builder.build())
        }
    }

    /**
     * 上一次已经发起下载的封面地址，避免同一首歌反复下载。
     *
     * volatile：下载线程回来时要读它判断自己是不是已经过期了，而写发生在主线程。
     */
    @Volatile
    private var pendingArtworkUrl: String? = null

    private fun fetchArtwork(url: String) {
        Thread({
            val bitmap = downloadBitmap(url)
            // 下载期间可能已经切歌了：pendingArtworkUrl 已经换成新歌的地址，这张晚到的图要丢掉，
            // 否则会把上一首的封面贴到当前歌上。
            if (bitmap == null || url != pendingArtworkUrl) {
                return@Thread
            }
            cachedArtwork = bitmap
            publishSnapshot()
            // 封面顺手喂给壁纸 GLES 层：它读的是 base64，WebView 冻结时 Web 抓
            // base64 那条路不会跑，原生兜底切歌后的封面只能从这里来。
            try {
                val coverBuffer = java.io.ByteArrayOutputStream()
                bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, coverBuffer)
                top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setCoverData(
                        android.util.Base64.encodeToString(coverBuffer.toByteArray(),
                                android.util.Base64.NO_WRAP))
            } catch (coverError: Throwable) {
                Log.w(TAG, "Failed to feed the wallpaper cover", coverError)
            }
            // 封面补到了也顺手刷新一次 MediaSession：锁屏歌词页上的封面读的是 metadata，
            // 只刷通知的话系统那边拿到的还是「没有封面」的那一份。
            applyMetadata()
            // 通知已经发出去了，要再 post 一次才会带上新封面。
            publishNotification()
        }, "folia-artwork").start()
    }

    private fun updatePlaybackState(intent: Intent) {
        val state = intent.getStringExtra(EXTRA_STATE)
        val playing = "playing" == state
        val positionMs = intent.getLongExtra(EXTRA_POSITION, 0L)
        val speed = intent.getFloatExtra(EXTRA_SPEED, 1.0f)

        val compatState = if ("playing" == state) {
            PlaybackStateCompat.STATE_PLAYING
        } else if ("paused" == state) {
            PlaybackStateCompat.STATE_PAUSED
        } else {
            PlaybackStateCompat.STATE_STOPPED
        }

        cachedState = compatState
        cachedPositionMs = positionMs
        cachedSpeed = speed
        cachedPlaying = playing
        /*
         * Web 层回过话了：那次「乐观播放」的宽限检查到此为止，不用再猜。
         *
         * 但它说「没在播」的时候不能只是撤掉检查 —— onPlay 那一刻已经把锚点切成在播了，
         * 撤掉就没人把锚点收回来，壁纸、叠层、状态栏歌词继续往外推，实际一点声音都没有
         * （用户原话）。壁纸那边的心跳指望不上：它是 JS 的 setInterval，后台里不一定跑。
         * 所以这里就地冻回去，位置用 Web 层报上来的那份（它才知道真实进度），
         * 没带位置才退回按下播放那一刻记下的。
         */
        val wasOptimisticPlay = playConfirmPending
        playConfirmPending = false
        // Web 层回过话，补发额度也就还回去了：下一次用户真的按下播放才再用。
        playNudges = 0
        mainHandler.removeCallbacks(playConfirmCheck)
        if (wasOptimisticPlay && !playing) {
            var freezeAt = if (intent.hasExtra(EXTRA_POSITION)) positionMs else playConfirmAnchorMs
            if (freezeAt < 0L) {
                freezeAt = playConfirmAnchorMs
            }
            top.izuna.foliamajor.wallpaper.WallpaperLyricsState.setAnchor(freezeAt, false)
            top.izuna.foliamajor.wallpaper.FloatingLyricsOverlay
                    .shared(this).invalidateOverlay()
        }
        publishSnapshot()
        applyPlaybackState()
    }

    /**
     * 用当前缓存的字段重建 PlaybackState 并写回 MediaSession。
     *
     * 调用点不止「Web 推状态」一个：歌词到了也要重挂一次翻译按钮（见
     * ACTION_REFRESH_METADATA），而 PlaybackState 是不可变对象，
     * 每次重建都得把该保留的东西重新加一遍。
     */
    private fun applyPlaybackState() {
        val builder = PlaybackStateCompat.Builder()
                .setActions(supportedActions())
                .setState(cachedState, resolvePlaybackPositionMs(), cachedSpeed)
        // ColorOS 锁屏歌词：有翻译 lane 时把 Bridge 的公共「翻译」按钮挂上。
        //
        // CustomAction.Builder 强制要求一个**非零**图标资源 id，传 0 会直接构造失败；
        // 图标长什么样无所谓 —— SystemUI 建好 Action 之后 Bridge 会把它换成自带的
        // ic_translation。所以拿应用图标当占位即可。
        if (ColorOsLyricBridge.hasTranslationFor(cachedSongKey)) {
            builder.addCustomAction(PlaybackStateCompat.CustomAction.Builder(
                    ColorOsLyricBridge.ACTION_TOGGLE_TRANSLATION,
                    "翻译",
                    translationActionIcon()).build())
        }
        // 「喜欢」：给系统媒体控制器用的那一颗（锁屏、Android Auto、Wear OS 等）。
        // 通知栏那颗心是 NotificationCompat.Action，两条路都发同一条 "like" 命令。
        // 只在真的能用时挂上：挂了却点不出结果，比不给这个按钮更让人困惑。
        if (cachedCanLike) {
            builder.addCustomAction(PlaybackStateCompat.CustomAction.Builder(
                    ACTION_TOGGLE_LIKE,
                    if (cachedLiked) "取消喜欢" else "喜欢",
                    if (cachedLiked) R.drawable.folia_heart_filled else R.drawable.folia_heart).build())
        }
        if (mediaSession != null) {
            mediaSession?.setPlaybackState(builder.build())
        }
    }

    private fun translationActionIcon(): Int {
        val icon = getApplicationInfo().icon
        return if (icon != 0) icon else android.R.drawable.ic_menu_manage
    }

    /**
     * 当前媒体信息的一份**快照**，供音乐锁屏底部的面板读取。
     *
     * 为什么不做成回调 / 广播：锁屏页活在另一个组件里，而且随时可能被系统回收重建
     * （转屏、内存紧张）。推的模式要维护订阅表，还得处理"推送时锁屏页还没起来"；
     * 拉的模式只要一份 volatile 快照，页面起来时读一次、之后每秒再读一次即可 ——
     * 反正这些字段本来就是给通知用的，服务里已经有一份现成的缓存。
     */
    class MediaSnapshot(
            @JvmField val title: String,
            @JvmField val artist: String,
            @JvmField val album: String,
            /** 已经解码好的封面（通知栏用的就是这一张）。null = 还没拿到。 */
            @JvmField val artwork: Bitmap?,
            @JvmField val durationMs: Long,
            @JvmField val positionMs: Long,
            @JvmField val playing: Boolean,
            /** 当前这首歌是不是「已喜欢」。 */
            @JvmField val liked: Boolean,
            /** 「喜欢」这个动作现在能不能用（平台不支持时为 false）。 */
            @JvmField val canLike: Boolean
    ) {
        /** 只换位置、其余字段原样带过去（snapshot() 读侧现算位置时用）。 */
        fun copy(positionMs: Long): MediaSnapshot = MediaSnapshot(
                title, artist, album, artwork, durationMs, positionMs, playing, liked, canLike)
    }

    private fun publishSnapshot() {
        lastSnapshot = MediaSnapshot(cachedTitle, cachedArtist, cachedAlbum,
                cachedArtwork, cachedDurationMs, resolvePlaybackPositionMs(), cachedPlaying,
                cachedLiked, cachedCanLike)
    }

    /**
     * 通知栏 / 锁屏那条进度条该显示的位置。
     *
     * 原生在放的时候直接问播放器：它的位置就是真值。Web 报上来的那一份要过 Chromium 的
     * 定时器节流 —— 挂着不动久了，那一推可能几十秒才来一次，通知栏就停着、或者一直是 00。
     * 其余情况照旧用 Web 报的位置：`<audio>` 播到哪只有它知道。
     */
    private fun resolvePlaybackPositionMs(): Long {
        if (top.izuna.foliamajor.player.FoliaNativePlayerPlugin.hasActiveMedia()) {
            val nativePosition = top.izuna.foliamajor.player.FoliaNativePlayerPlugin.currentPositionMs()
            if (nativePosition >= 0L) {
                return nativePosition
            }
        }
        return cachedPositionMs
    }

    private fun decodeArtwork(base64: String?): Bitmap? {
        if (base64 == null || base64.isEmpty()) {
            return null
        }
        try {
            // data URL 前缀（data:image/jpeg;base64,）要去掉，否则解码会失败。
            val comma = base64.indexOf(',')
            val payload = if (comma >= 0) base64.substring(comma + 1) else base64
            val bytes = Base64.decode(payload, Base64.DEFAULT)
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (error: Throwable) {
            // 封面解析失败不该影响播放与通知，退回默认图标即可。
            Log.w(TAG, "Failed to decode artwork", error)
            return null
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val channel = NotificationChannel(
                CHANNEL_ID,
                "播放控制",
                NotificationManager.IMPORTANCE_LOW)
        channel.setDescription("在通知栏显示当前播放的歌曲与播放控制")
        // 播放控制不该发出提示音或震动。
        channel.setSound(null, null)
        channel.enableVibration(false)
        notificationManager?.createNotificationChannel(channel)
    }

    /**
     * 用当前缓存的字段重建整条通知。
     *
     * metadata 与 playbackState 是两次独立的调用，所以通知内容必须从缓存整体重建，
     * 否则后到的那次会把先到的字段抹成空。
     */
    private fun buildForegroundNotification(): Notification {
        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
                // 封面角标：媒体通知会把 small icon 画在封面右下角，原本是 ic_media_play 那个 ▶，
                // 现在换成「这首歌来自哪个平台」的应用图标（本地等自家人用 Folia 本尊）。
                // 没收到过角标信息时（0）回落 Folia 图标，不再显示播放三角。
                .setSmallIcon(if (cachedBadgeRes != 0) cachedBadgeRes else R.mipmap.ic_launcher)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOnlyAlertOnce(true)
                // 通知属于前台服务，用户无法手动划掉它（划掉就等于杀掉播放）。
                .setOngoing(true)

        // 通知栏的按钮：上一首 / 播放暂停 / 下一首 /（可用时）喜欢。
        // 必须真的 addAction —— MediaStyle 的紧凑视图只是「从第 0/1/2 个 action 里挑出来显示」，
        // 不 addAction 就写 setShowActionsInCompactView(0,1,2) 是越界引用，等于白写。
        val playing = cachedState == PlaybackStateCompat.STATE_PLAYING
        builder.addAction(buildAction(android.R.drawable.ic_media_previous, "上一首", "previous"))
        builder.addAction(if (playing)
            buildAction(android.R.drawable.ic_media_pause, "暂停", "pause")
        else
            buildAction(android.R.drawable.ic_media_play, "播放", "play"))
        builder.addAction(buildAction(android.R.drawable.ic_media_next, "下一首", "next"))
        // 「喜欢」放第四位：紧凑视图（收起那条通知）只显示前三个，上一首 / 播停 / 下一首
        // 是任何时候都得在的，喜欢只能退到展开态。它同时在 MediaSession 上挂了
        // CustomAction（见 applyPlaybackState），锁屏与车机那类控制器照样看得到。
        if (cachedCanLike) {
            builder.addAction(buildAction(
                    if (cachedLiked) R.drawable.folia_heart_filled else R.drawable.folia_heart,
                    if (cachedLiked) "取消喜欢" else "喜欢",
                    "like"))
        }

        val token = mediaSession?.getSessionToken()
        if (token != null) {
            builder.setStyle(androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(token)
                    .setShowActionsInCompactView(0, 1, 2))
        }

        if (!cachedTitle.isEmpty()) {
            builder.setContentTitle(cachedTitle)
        } else {
            builder.setContentTitle("Folia")
        }
        if (!cachedArtist.isEmpty()) {
            builder.setContentText(cachedArtist)
        }
        if (cachedArtwork != null) {
            builder.setLargeIcon(cachedArtwork)
        }

        // 点击通知栏本体回到应用。getLaunchIntentForPackage 返回的是 Intent，
        // 通知的 setContentIntent 要的是 PendingIntent；该 Intent 自带
        // FLAG_ACTIVITY_NEW_TASK | RESET_TASK_IF_NEEDED，点通知不会在任务栈里叠一份新的 Activity。
        val launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName())
        if (launchIntent != null) {
            val contentIntent = PendingIntent.getActivity(
                    this, 0, launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            builder.setContentIntent(contentIntent)
        }

        return builder.build()
    }

    /**
     * 通知栏按钮。
     *
     * 点下去广播给 FoliaCommandReceiver；带 EXTRA_FROM_BUTTONS，接收器按它把
     * next / previous / like 转进服务挂原生兜底（JS 那份命令由服务统一发），
     * 其余命令照旧直派 JS。用 command 的 hashCode 作 requestCode，
     * 三个按钮才不会互相复用同一个 PendingIntent。
     */
    private fun buildAction(icon: Int, title: CharSequence, command: String): NotificationCompat.Action {
        val intent = Intent(this, FoliaCommandReceiver::class.java)
        intent.setAction(ACTION_WEB_COMMAND)
        intent.putExtra(EXTRA_COMMAND, command)
        intent.putExtra(EXTRA_FROM_BUTTONS, true)
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = flags or PendingIntent.FLAG_IMMUTABLE
        }
        val pendingIntent =
                PendingIntent.getBroadcast(this, command.hashCode(), intent, flags)
        return NotificationCompat.Action(icon, title, pendingIntent)
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
        foregrounded = false
        // 通知已经被撤下来了：再前台化时按当前缓存重建，别把撤掉的那条贴回去。
        cachedNotification = null
    }

    companion object {
        private const val TAG = "FoliaPlaybackService"
        private const val CHANNEL_ID = "folia_playback"
        private const val NOTIFICATION_ID = 0x1F01

        /**
         * 服务是否还活着。
         *
         * 插件侧要靠它判断「有没有必要把服务拉起来」：原先无歌/暂停也会
         * startForegroundService，于是打开应用就起一个前台服务。
         */
        @Volatile
        private var running = false

        /** 活着的服务实例：getPlaybackSnapshot（JS 问原生要状态）从这里读。 */
        @Volatile
        private var snapshotSource: FoliaPlaybackService? = null

        /** 插件直调原生切歌 / 点歌时的实例入口（onCreate 赋值，onDestroy 清）。 */
        @JvmStatic
        fun activeService(): FoliaPlaybackService? {
            return snapshotSource
        }

        /** 服务是否还活着。public：coloros 包要判断「有没有必要发刷新 intent」。 */
        @JvmStatic
        fun isRunning(): Boolean {
            return running
        }

        /**
         * 服务是否**已经在前台**（通知已经贴出去了）。public：插件要靠它选 startService
         * 还是 startForegroundService —— 已在前台时再走 startForegroundService，服务端
         * 就得每秒再调一次 startForeground() 去兑现那道倒计时（见 promoteToForeground）。
         */
        @JvmStatic
        fun isForegrounded(): Boolean {
            return foregrounded
        }

        /**
         * 当前播放状态的快照（给 {@code getPlaybackSnapshot}，JS「问原生要状态」）。
         *
         * 原生是播放的真源：WebView 冻结期间镜像换过源、原生一直在放，JS 醒来后第一件事
         * 就是拉这份快照对齐自己的队列与位置，而不是推它自己那份旧状态。服务没在跑
         * （进程刚起、还没放过歌）时 hasSong=false，JS 按自己恢复的状态走。
         */
        @JvmStatic
        fun snapshotJson(): org.json.JSONObject {
            val service = snapshotSource
            val out = org.json.JSONObject()
            if (service == null) {
                try {
                    out.put("hasSong", false)
                } catch (ignored: org.json.JSONException) {
                }
                return out
            }
            synchronized(service) {
                try {
                    val songKey = service.cachedSongKey
                    out.put("hasSong", songKey != null && !songKey.isEmpty())
                    out.put("songKey", songKey ?: "")
                    out.put("title", service.cachedTitle)
                    out.put("artist", service.cachedArtist)
                    out.put("album", service.cachedAlbum)
                    out.put("durationMs", service.cachedDurationMs)
                    out.put("positionMs", service.resolvePlaybackPositionMs())
                    out.put("playing", service.cachedState == PlaybackStateCompat.STATE_PLAYING)
                    out.put("liked", service.cachedLiked)
                    out.put("canLike", service.cachedCanLike)
                    out.put("providerId", service.cachedProviderId)
                    out.put("serverSongId", service.cachedServerSongId)
                    out.put("artworkUrl", service.pendingArtworkUrl ?: "")
                } catch (ignored: org.json.JSONException) {
                }
            }
            return out
        }

        /** JS 没回话等多久就原生补写红心。要长于 JS 正常处理一次收藏的耗时（写 + 复查），免得慢一点就双写。 */
        private const val LIKE_FALLBACK_MS = 5_000L

        /**
         * 镜像队列里**当前**这一首的地址（预取缓存优先，其次条目自带）。
         *
         * 暂停后恢复播放的原生兜底用（见 FoliaNativePlayerPlugin.resumeFromSystem）：
         * 当前这首走 <audio> 时原生手上没歌，光 play() 是空操作 —— 得有地址才能
         * 在原生重新装源接管。预取没命中就返回 null（那一趟网络等不起，恢复播放
         * 的判据必须瞬时），调用方照旧走 JS 那条路。
         */
        @JvmStatic
        fun mirrorCurrentUrl(): String? {
            val service = snapshotSource ?: return null
            synchronized(service) {
                val json = mirroredQueueJson ?: return null
                val index = mirroredIndex
                if (index < 0) return null
                return try {
                    val array = org.json.JSONArray(json)
                    if (index >= array.length()) return null
                    val entry = array.getJSONObject(index)
                    val songKey = entry.optString("songKey", "")
                    var url = if (songKey.isEmpty()) null else service.resolvedUrlCache[songKey]
                    if (url == null || url.isEmpty()) {
                        url = entry.optString("url", "")
                    }
                    if (url == null || url.isEmpty()) null else url
                } catch (ignored: org.json.JSONException) {
                    null
                }
            }
        }

        // ===== 通知栏镜像队列 =====
        // JS 活着时把「当前 ±10 首、带已解析地址」的队列窗口推过来；WebView 冻结后
        // 通知栏的下一首/上一首就靠这份快照在原生直接换源（见 scheduleSkipFallback）。
        @Volatile
        private var mirroredQueueJson: String? = null
        @Volatile
        private var mirroredIndex = -1
        /** JS 没回话等多久就自己动手。预取命中的下一首 2.5s 内足够换好源。 */
        private const val SKIP_FALLBACK_MS = 2_500L

        /**
         * 已经调用过 startForeground 了；见 promoteToForeground()。
         *
         * 静态 + volatile 是给插件那边读的（isForegrounded）：它要在发 intent 之前知道
         * 服务在不在前台，决定用 startService 还是 startForegroundService。
         */
        @Volatile
        private var foregrounded = false

        /**
         * 「按下播放」之后，等 Web 层确认真的播起来了的宽限期（毫秒）。
         *
         * Web 层那条路不一定一步就到：长时间暂停之后，音频上下文要 resume、在线歌的播放地址
         * 可能已经过期要重新取一次，这两件事在后台都可能挂住（用户原话：暂停很久之后点播放，
         * 拉不起来，打开应用才瞬间恢复）。而我们在 {@link #onPlay()} 里为了「后台也能让
         * 壁纸/叠层跟着走」已经把锚点切成在播了 —— 等不到确认的话，壁纸、叠层、状态栏歌词
         * 会一路往外推，实际一点声音都没有。所以给一个宽限期，到时还没确认就冻回去。
         */
        private const val PLAY_CONFIRM_GRACE_MS = 4000L
        /** 一次「按下播放」最多补发几次。补发不是死循环：试过一次还起不来就不再打扰 Web 层。 */
        private const val MAX_PLAY_NUDGES = 1

        /**
         * 壁纸心跳的巡检节拍（2 秒一敲），只在「真有东西在出声」时敲下去。
         *
         * 为什么要有它：壁纸歌词是「锚点 + 墙钟」自己往前走的，写锚点的一方死了它也不知道。
         * 应用被划掉后台之后 WebView 连同桥一起销毁，但前台服务（连带整个进程、连同壁纸）
         * 还活着 —— 没人踩刹车，歌词就照着最后一首歌的时间轴一路唱到头。
         *
         * 谁在真正出声，谁就能把心跳敲下去：
         *  · WebView 管线活着（桥实例在）—— 哪怕退了后台、JS 定时器被挂起，音频照样在放；
         *    暂停时也算活着：歌词冻在原地（和用户能看到的 App 状态一致），不算「没人管还在走」。
         *  · WebView 已经没了但原生播放器在真的出声（镜像接管那条路）。
         * 两个都不是 —— 播放已经死了，心跳就此断掉：壁纸与两层叠层在超时后只画背景，
         * 不再画歌词和进度条（各绘制入口自己读 WallpaperLyricsState.heartbeatAlive）。
         */
        private const val WALLPAPER_HEARTBEAT_TICK_MS = 2000L

        /**
         * 心跳断了多久之后把播放控制通知收掉。
         *
         * 壁纸那边的超时是 8 秒（last tap 之后）—— 播放管线死了，歌词与进度条先收，
         * 通知栏那条带着播放/暂停/切歌按钮的控制通知**再等 2 秒也一起注销**
         * （用户指令：心跳中断后应该注销播放控制通知）。那些按钮点了全是没人接的死键，
         * 挂着只会让人以为还在放。
         */
        private const val HEARTBEAT_WITHDRAW_MS = 10_000L

        /**
         * 通知栏支持哪些动作。
         *
         * ACTION_SEEK_TO 是那条进度条的关键：系统只在 actions 里看到它时，才把进度条
         * 画成可拖的；没有它，进度条要么不出现，要么就是一条点不动的灰条。
         */
        private fun supportedActions(): Long {
            return PlaybackStateCompat.ACTION_PLAY or
                    PlaybackStateCompat.ACTION_PAUSE or
                    PlaybackStateCompat.ACTION_PLAY_PAUSE or
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                    PlaybackStateCompat.ACTION_STOP or
                    PlaybackStateCompat.ACTION_SEEK_TO
        }

        @Volatile
        private var lastSnapshot: MediaSnapshot? = null

        /** 最近一次的媒体信息。服务没起来过就是 null（那时锁屏页也不会显示）。 */
        @JvmStatic
        fun snapshot(): MediaSnapshot? {
            val fixed = lastSnapshot ?: return null
            /*
             * 位置**现算**，不交快照里定格的那份。
             *
             * 快照只在 publishSnapshot() 那一刻写：Web 播放（<audio>）时 JS 每秒推一次
             * 状态，每秒都刷新，锁屏每秒拉一次正好是动的；原生播放时 Web 刻意不再推
             * 位置（省每秒一次的 IPC，见 useCapacitorPlaybackBridge），快照里的 positionMs
             * 就定格在最后一次状态边界上 —— 锁屏那条进度条每秒读到的都是同一个旧值
             * （用户报的「锁屏的进度条不动了」）。播放器才是真源：原生在放时直接问它。
             * 纯拉模式的读侧顺手补一笔，不动快照本身（它仍由状态边界刷新）。
             */
            return fixed.copy(positionMs = resolvePlaybackPositionMs(fixed.positionMs))
        }

        /**
         * 锁屏 / 通知栏该显示的位置：原生在放就问播放器，否则用定格值。
         * 与 {@link #resolvePlaybackPositionMs()} 同一个判据，只是多收一个回退值 ——
         * 那个版本读实例字段，这个从快照来（读侧没有实例上下文）。
         */
        private fun resolvePlaybackPositionMs(fallbackMs: Long): Long {
            if (top.izuna.foliamajor.player.FoliaNativePlayerPlugin.hasActiveMedia()) {
                val nativePosition = top.izuna.foliamajor.player.FoliaNativePlayerPlugin.currentPositionMs()
                if (nativePosition >= 0L) {
                    return nativePosition
                }
            }
            return fallbackMs
        }

        private fun downloadBitmap(url: String): Bitmap? {
            var stream: java.io.InputStream? = null
            try {
                val connection =
                        java.net.URL(url).openConnection() as java.net.HttpURLConnection
                connection.setConnectTimeout(6000)
                connection.setReadTimeout(10000)
                connection.setInstanceFollowRedirects(true)
                connection.setRequestProperty("User-Agent", "Mozilla/5.0")
                val code = connection.getResponseCode()
                if (code < 200 || code >= 300) {
                    connection.disconnect()
                    return null
                }
                stream = connection.getInputStream()
                val decoded = android.graphics.BitmapFactory.decodeStream(stream)
                connection.disconnect()
                if (decoded == null) {
                    return null
                }
                // 通知栏只需要一张小图，顺手压到 512，避免大图白占内存。
                val edge = Math.max(decoded.getWidth(), decoded.getHeight())
                if (edge > 512) {
                    val ratio = 512f / edge
                    val scaled = android.graphics.Bitmap.createScaledBitmap(decoded,
                            Math.round(decoded.getWidth() * ratio),
                            Math.round(decoded.getHeight() * ratio), true)
                    decoded.recycle()
                    return scaled
                }
                return decoded
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to download the cover", error)
                return null
            } finally {
                if (stream != null) {
                    try {
                        stream.close()
                    } catch (ignored: java.io.IOException) {
                        // 关闭失败不影响结果。
                    }
                }
            }
        }

        /**
         * 平台 key → 角标 drawable。
         *
         * 图标文件在 res/drawable-nodpi/ 下（ic_provider_*.png，与 src/assets/providers/ 的同一套）。
         * 没登记的平台（含空值）一律回落 Folia 本尊 —— 通知栏角标永远画得出东西，只是不一定认得。
         */
        private fun providerIconRes(badge: String?): Int {
            if (badge == null) return R.mipmap.ic_launcher
            when (badge) {
                "netease" -> return R.drawable.ic_provider_netease
                "qq" -> return R.drawable.ic_provider_qq
                "kugou" -> return R.drawable.ic_provider_kugou
                "bodian" -> return R.drawable.ic_provider_bodian
                // 飞牛（自建服务）：图标是**白色剪影 + 透明底**，不是那张彩色图 ——
                // 通知栏的 smallIcon 从 Android 5.0 起只认 alpha，彩色图会被整体染成一个
                // 没有细节的色块。剪影由那张官方图标去掉红底得来（alpha 取三通道最小值）。
                "feiniu" -> return R.drawable.ic_provider_feiniu
                // 汽水音乐：Electron-only，但通知栏角标资源仍保留一份白色剪影，保持全量接入。
                "qishui" -> return R.drawable.ic_provider_qishui
                else -> return R.mipmap.ic_launcher
            }
        }

        /**
         * 往 Web 层发一条播放控制指令（上一首 / 下一首）。
         *
         * 锁屏面板走的是**通知栏同一条路**：指令交给 FoliaCommandReceiver。带
         * EXTRA_FROM_BUTTONS（这是用户按的按钮，不是服务转给 JS 的回话），接收器会把
         * next / previous / like 转进服务挂原生兜底。
         */
        @JvmStatic
        fun sendPlaybackCommand(context: Context, command: String) {
            // 必须写死组件名：Android 8+ 的隐式广播不会投递给清单注册的接收器。
            val intent = Intent(context, FoliaCommandReceiver::class.java)
            intent.setAction(ACTION_WEB_COMMAND)
            intent.putExtra(EXTRA_COMMAND, command)
            intent.putExtra(EXTRA_FROM_BUTTONS, true)
            context.sendBroadcast(intent)
        }

        /** 带位置的指令（锁屏面板拖进度条用）。 */
        @JvmStatic
        fun sendPlaybackCommand(context: Context, command: String, positionMs: Long) {
            val intent = Intent(context, FoliaCommandReceiver::class.java)
            intent.setAction(ACTION_WEB_COMMAND)
            intent.putExtra(EXTRA_COMMAND, command)
            intent.putExtra(EXTRA_COMMAND_POSITION, positionMs)
            intent.putExtra(EXTRA_FROM_BUTTONS, true)
            context.sendBroadcast(intent)
        }

        /**
         * 播放器播完了、桥已经没了（WebView 冻结 / 已销毁）时叫下一首：
         * 转成一条 next 指令进服务，走镜像换源那套兜底（预取命中就是秒切）。
         *
         * **JS 活着时也发**：发出去的是「命令 + 兜底计时器」这一套（见 handleMediaCommand
         * 的 next 分支），JS 在窗口内推出了新 metadata 计时器就收手，不会双倍跳歌；
         * 它被挂起时才轮到镜像换源。以前这里直接调 skipViaMirror，等于绕过了那道
         * 幂等判据 —— 而现在「播完」两条路都要接住（见 FoliaNativePlayerPlugin 里
         * ended 那段注释）。
         */
        @JvmStatic
        fun requestNativeAutoNext(context: Context?) {
            if (context == null || !isRunning()) {
                return
            }
            val intent = Intent(context, FoliaPlaybackService::class.java)
            intent.setAction(ACTION_MEDIA_COMMAND)
            intent.putExtra(EXTRA_COMMAND, "next")
            try {
                context.startService(intent)
            } catch (ignored: Throwable) {
                // 服务起不来就没有兜底；这条本来也只在兜底场景里发生。
            }
        }

        // ---- Web 层（useCapacitorPlaybackBridge）通过这些常量与服务交互 ----

        const val ACTION_UPDATE_METADATA = "top.izuna.foliamajor.action.UPDATE_METADATA"
        /** JS 活着时把队列快照推过来（WebView 冻结时原生切歌的唯一依据），见镜像区。 */
        const val ACTION_UPDATE_QUEUE_MIRROR = "top.izuna.foliamajor.action.UPDATE_QUEUE_MIRROR"
        const val EXTRA_QUEUE_MIRROR_JSON = "queueMirrorJson"
        const val EXTRA_QUEUE_MIRROR_INDEX = "queueMirrorIndex"
        /** 队列没变、只换正播那首：轻量推游标，见 ACTION_UPDATE_QUEUE_MIRROR。 */
        const val ACTION_UPDATE_QUEUE_INDEX = "top.izuna.foliamajor.action.UPDATE_QUEUE_INDEX"
        const val ACTION_UPDATE_STATE = "top.izuna.foliamajor.action.UPDATE_STATE"
        /**
         * 按缓存重建一次 metadata + PlaybackState，不改动任何缓存字段。
         *
         * 给 ColorOS 原生歌词用：歌词到的时刻与 metadata 到的时刻是两个独立事件，
         * 谁先谁后都可能，这条动作让「后到的那个」能把两者合起来重新发出去。
         * 别的包要用，所以是 public。
         */
        const val ACTION_REFRESH_METADATA = "top.izuna.foliamajor.action.REFRESH_METADATA"
        const val ACTION_STOP_FOREGROUND = "top.izuna.foliamajor.action.STOP_FOREGROUND"
        const val ACTION_WEB_COMMAND = "top.izuna.foliamajor.action.WEB_COMMAND"
        const val EXTRA_COMMAND = "command"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_ALBAND = "album"
        const val EXTRA_ARTWORK = "artwork"
        const val EXTRA_ARTWORK_URL = "artworkUrl"
        const val EXTRA_DURATION = "duration"
        /** 封面角标（通知 small icon）用哪颗图标：当前播放来源的平台 key。 */
        const val EXTRA_PROVIDER_BADGE = "providerBadge"
        /** 当前这首歌的身份：与上一次不同就是换歌了，换歌时先丢掉上一首的封面。 */
        const val EXTRA_SONG_KEY = "songKey"
        /** 当前这首歌是不是「已喜欢」（通知栏那颗心画实心还是空心）。 */
        const val EXTRA_LIKED = "liked"
        /** 「喜欢」这个动作当前能不能用；false 时通知栏不画那颗心。 */
        const val EXTRA_CAN_LIKE = "canLike"
        /** 红心兜底：当前歌来自哪个平台（netease/qq/…），决定原生补写收藏走哪条路。 */
        const val EXTRA_PROVIDER_ID = "providerId"
        /** 红心兜底：当前歌在平台侧的歌曲 id（网易 = 数字曲库 id，QQ = 数字 songId）。 */
        const val EXTRA_SERVER_SONG_ID = "serverSongId"
        /** 通知栏/锁屏那颗心经 FoliaCommandReceiver 转进来的兜底挂载动作。 */
        const val ACTION_SCHEDULE_LIKE_FALLBACK = "top.izuna.foliamajor.action.SCHEDULE_LIKE_FALLBACK"
        /**
         * 通知栏 / 锁屏按钮的命令进服务的通道。
         *
         * 这些按钮原先只广播给 FoliaCommandReceiver 直派 JS —— 服务的切歌 / 红心兜底挂在
         * MediaSession 回调上，通知栏根本触发不到它，WebView 一冻结整排按钮就是死的。
         * 现在按钮先经服务（它才能挂兜底计时器），JS 那份命令由服务统一发。
         */
        const val ACTION_MEDIA_COMMAND = "top.izuna.foliamajor.action.MEDIA_COMMAND"
        /** 标记「这条命令来自通知栏 / 锁屏按钮」，接收器按它决定要不要转进服务。 */
        const val EXTRA_FROM_BUTTONS = "fromButtons"
        /**
         * MediaSession 的自定义动作名：「喜欢 / 取消喜欢」。
         *
         * 走 CustomAction 而不是 PlaybackState 的标准动作，是因为 MediaSessionCompat
         * 没有「喜欢」这一档 —— 系统媒体控制器（锁屏、Android Auto、蓝牙设备）看见的是
         * 我们自己声明的这个字符串。通知栏那颗心是**另外**加的 NotificationCompat.Action，
         * 两条路都通向同一个 sendCommand("like")。
         */
        const val ACTION_TOGGLE_LIKE = "top.izuna.foliamajor.action.TOGGLE_LIKE"
        const val EXTRA_STATE = "state"
        const val EXTRA_POSITION = "position"
        /** 拖动通知栏进度条时带回的目标位置（毫秒）。 */
        const val EXTRA_COMMAND_POSITION = "commandPosition"
        const val EXTRA_SPEED = "speed"
    }
}
