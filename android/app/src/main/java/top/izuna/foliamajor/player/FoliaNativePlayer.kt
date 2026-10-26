package top.izuna.foliamajor.player

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper

import androidx.media3.common.AudioAttributes
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory

// 当前文件：Folia 在安卓上的原生播放内核（P1：最小闭环）。
//
// 只做「把这一个地址解码并出声」，不碰任何音效：均衡器、音效链、淡入淡出、automix
// 交叉淡化都还在 WebView 的 Web Audio 图里，原生接管的那一刻它们整体失效（
// createMediaElementSource 是单向不可逆的），那些留给后面的阶段。
//
// ⭐⭐ **线程：这是这个文件里最容易出事的一条。**
//
// Capacitor 的插件方法**不在主线程执行** —— Bridge 自己起了一条 `CapacitorPlugins`
// 的 HandlerThread（com/getcapacitor/Bridge.java：`taskHandler.post(currentThreadTask)`），
// 所有 @PluginMethod 都跑在那上面。而 ExoPlayer 绑定的是**创建时那个线程的 Looper**，
// 之后从别的线程碰它就抛 IllegalStateException（未捕获 = 进程直接死，界面上就是闪退）。
//
// 所以这里两件事都是硬性的：
//   1. 播放器建在**自己那条专用线程**上（下面 `playbackThread` 的 Looper）；
//   2. 每一个入口都经 `runOnPlayer` 回到同一条线程 —— 包括建播放器、装地址、播停跳、音量。
// 位置上报那个 250ms 的定时器也挂在同一条上，于是它和播放器是同一个线程。
//
// ⚠️ **为什么不是主线程**（2026-10-22 实测出来的坑）：
// ExoPlayer 的播放循环（`doSomeWork`：取缓冲、喂解码器、推进位置）就跑在 `setLooper`
// 给的那条线程上。钉在主线程时，它每几毫秒到几十毫秒就要占一次主线程，与 UI 抢 ——
// 用户看到的就是「放着放着卡那么一下」。而受它影响最大的不是播放页，是**桌面歌词**：
//   · 精简（原生渲染器）跑自己的渲染线程，看不出来；
//   · **跟随播放页**那一档是叠层 WebView 里在跑完整视觉器，JS 与光栅都在主线程一侧，
//     主线程一被播放器挤，它就掉到四五帧、一顿一顿像在跟着同步。
// 关掉「原生播放」就丝滑，就是这个差别的对照。挪到专用线程后主线程只剩「把事件交给
// WebView」那一下（`Bridge.eval` 自己会 post 回主线程，所以 `notifyListeners` 从这条
// 线程上直接调是安全的）。
//
// 绝不做「Web 侧每秒问一次位置」：Capacitor 的桥只有一条，轮询会跟别的东西抢。
//
// ⚠️ 依赖：androidx.media3:media3-exoplayer（见 app/build.gradle）。
@UnstableApi
class FoliaNativePlayer(context: Context, listener: Listener) {

    interface Listener {
        /** type: ready | playing | paused | ended | position | seeked | buffering | error */
        fun onEvent(type: String, positionMs: Long, durationMs: Long, message: String?)
    }

    companion object {
        private const val POSITION_TICK_MS = 250L

        /**
         * 伪装成浏览器的 UA。
         *
         * ExoPlayer 默认发的是 `AndroidXMedia3/...`，几个音源的 CDN 不认这种 UA，会被当成
         * 爬虫拒掉 —— 而同样的地址在 WebView 的 `<audio>` 里是能播的（那边的 UA 是浏览器）。
         * 这里对齐浏览器，是为了让「换成原生播放」不引入一批新的取流失败。
         */
        private const val BROWSER_USER_AGENT =
            "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
    }

    /**
     * 播放器专用那一条线程。
     *
     * 见文件头「线程」那一节：播放循环不能落在主线程上。起一条而不是复用 Capacitor 的
     * 桥线程，是因为桥上还跑着歌词、封面、批量拉取那些活，播放循环挤过去一样会互相拖。
     */
    private val playbackThread = HandlerThread("folia-native-player")
    private val handler: Handler
    private val playerLooper: Looper
    private val context: Context
    private val listener: Listener

    private var player: ExoPlayer? = null
    /** 换源时要就地改默认请求头（飞牛的会话 Cookie），所以提成字段。 */
    private var httpFactory: DefaultHttpDataSource.Factory? = null
    /** release 过就不再收播放器（线程已经 quit，再 post 会崩）。 */
    @Volatile
    private var released = false
    /**
     * 最后一首的地址：播放器被回收后重建时靠它装回去（系统控件要能直接拉起播放）。
     *
     * 播放器线程写、别的线程读（hasMedia），所以要 volatile。
     */
    @Volatile
    private var lastUrl: String? = null
    private var tickScheduled = false
    private var requestedVolume = 1f
    /** 别的线程要读（写锚点时判断要不要跳过），所以 volatile。 */
    @Volatile
    private var requestedSpeed = 1f
    private var requestedRepeatMode = Player.REPEAT_MODE_OFF

    // 读的位置/时长走缓存：读可能发生在插件线程上，直接问播放器会跨线程。
    @Volatile
    private var cachedPositionMs = 0L
    @Volatile
    private var cachedDurationMs = 0L
    @Volatile
    private var cachedPlaying = false

    private val positionTick = object : Runnable {
        override fun run() {
            val current = player
            if (current == null) {
                tickScheduled = false
                return
            }
            val position = current.currentPosition
            val duration = current.duration
            cachedPositionMs = position
            cachedDurationMs = if (duration > 0) duration else 0L
            emit("position", position, cachedDurationMs, null)
            handler.postDelayed(this, POSITION_TICK_MS)
        }
    }

    init {
        this.context = context.applicationContext
        this.listener = listener
        playbackThread.start()
        playerLooper = playbackThread.looper
        handler = Handler(playerLooper)
    }

    /** 装上地址并缓冲。startPositionMs 小于 0 表示从头播。 */
    fun prepare(url: String, startPositionMs: Long) {
        lastUrl = url
        /*
         * ⭐ 位置与时长在**调用线程上**立刻归零，不等播放器线程。
         *
         * runOnPlayer 是异步 post：原生兜底切歌（skipViaMirror → prepareFromSystem）
         * 之后服务马上就在主线程写 MediaSession 状态，那一问走的是
         * currentPositionMs() —— 这时 prepare 还排在播放器线程的队列里，
         * 读到的是**上一首**的位置。通知栏那条进度条于是从旧歌的位置接着走
         * （「下一首切换播放进度是错误的」），而状态只在边界重写，没人再来纠正它。
         * 两个字段都是 volatile，提前写安全；真正的装源照旧在播放器线程做。
         */
        cachedPositionMs = if (startPositionMs > 0) startPositionMs else 0L
        cachedDurationMs = 0L
        runOnPlayer {
            val current = ensurePlayer()
            // 有些源要附带请求头（飞牛的音频流认 Cookie: music-token）：
            // 每次换源都按地址重问一遍，没有就清空，别把上一首的头带给下一首。
            applySourceHeaders(url)
            current.setMediaItem(MediaItem.fromUri(url))
            current.setRepeatMode(requestedRepeatMode)
            current.setVolume(requestedVolume)
            current.setPlaybackParameters(PlaybackParameters(requestedSpeed))
            current.prepare()
            if (startPositionMs > 0) {
                current.seekTo(startPositionMs)
            }
            cachedPositionMs = if (startPositionMs > 0) startPositionMs else 0L
            cachedDurationMs = 0L
        }
    }

    fun play() {
        runOnPlayer {
            val current = ensurePlayer()
            current.setPlayWhenReady(true)
            cachedPlaying = true
        }
    }

    fun pause() {
        runOnPlayer {
            val current = player ?: return@runOnPlayer
            current.setPlayWhenReady(false)
            cachedPlaying = false
            stopTicking()
            cachedPositionMs = current.currentPosition
            emit("paused", cachedPositionMs, cachedDurationMs, null)
        }
    }

    /** 停下来并丢掉当前媒体（换歌之前的收尾，以及「没有歌了」）。 */
    fun stop() {
        runOnPlayer {
            val current = player ?: return@runOnPlayer
            current.stop()
            current.setPlayWhenReady(false)
            current.clearMediaItems()
            // 真的停了：系统控件就不该再把它拉起来。
            lastUrl = null
            cachedPlaying = false
            cachedPositionMs = 0L
            cachedDurationMs = 0L
            stopTicking()
            emit("idle", 0L, 0L, null)
        }
    }

    fun seek(positionMs: Long) {
        val target = Math.max(0L, positionMs)
        /*
         * ⭐ 位置在**调用线程**立刻写进缓存，不等播放器线程（照 prepare 的纪律）。
         *
         * 拖通知栏/锁屏进度条那一发是：seekFromSystem → 服务马上 applyPlaybackState，
         * 它读 currentPositionMs() —— 这时真正的 seekTo 还排在播放器线程队列里，
         * 读到的是**上一次**的位置。通知栏与锁屏那条进度条于是先弹回旧位置、
         * 等下一次状态边界才跳到新位置（「显示会回弹」「同步的是上一次拖动的位置」）。
         * cachedPositionMs 是 volatile，提前写安全；精确值（夹过 duration 的）
         * 由播放器线程 seekTo 之后再覆盖一遍。
         */
        cachedPositionMs = target
        runOnPlayer {
            val current = player ?: return@runOnPlayer
            var clamped = target
            val duration = current.duration
            // C.TIME_UNSET（负数）表示还不知道多长，这时候别去夹。
            if (duration > 0) {
                clamped = Math.min(clamped, duration)
            }
            current.seekTo(clamped)
            cachedPositionMs = clamped
            emit("position", clamped, if (duration > 0) duration else 0L, null)
        }
    }

    fun setVolume(volume: Float) {
        val clamped = Math.max(0f, Math.min(1f, volume))
        requestedVolume = clamped
        runOnPlayer {
            val current = player
            if (current != null) current.setVolume(requestedVolume)
        }
    }

    fun setSpeed(speed: Float) {
        val clamped = Math.max(0.1f, Math.min(4f, speed))
        requestedSpeed = clamped
        runOnPlayer {
            val current = player
            if (current != null) current.setPlaybackParameters(PlaybackParameters(requestedSpeed))
        }
    }

    fun setRepeatMode(repeatMode: Int) {
        requestedRepeatMode = repeatMode
        runOnPlayer {
            val current = player
            if (current != null) current.setRepeatMode(requestedRepeatMode)
        }
    }

    fun release() {
        // 收过一次就别再收：线程 quit 之后再往它的 Handler 上 post 会直接抛
        // 「sending message to a Handler on a dead thread」，而系统控件（通知栏 / 耳机）
        // 在插件销毁之后仍可能来碰一次。
        if (released) return
        released = true
        handler.post {
            stopTicking()
            val current = player
            player = null
            cachedPlaying = false
            if (current != null) {
                current.removeListener(playerListener)
                current.release()
            }
            // 这条线程只是为播放器起的，播放器没了就一并收掉，不留空转。
            playbackThread.quitSafely()
        }
    }

    /** 手上有没有还在播的那一首（系统控件该不该直接碰它，就问这个）。 */
    fun hasMedia(): Boolean {
        return lastUrl != null
    }

    /** 缓存值：调用方可能在插件线程上，这里绝不去碰播放器。 */
    fun getPositionMs(): Long {
        return Math.max(0L, cachedPositionMs)
    }

    fun getDurationMs(): Long {
        return cachedDurationMs
    }

    fun isPlaying(): Boolean {
        return cachedPlaying
    }

    /**
     * 当前倍速。写锚点那一侧要拿它决定要不要跳过这一拍 —— 见
     * FoliaNativePlayerPlugin 里 `anchorStillTrue` 那段说明。
     */
    fun getSpeed(): Float {
        return requestedSpeed
    }

    /**
     * 所有碰到播放器的动作都回到**播放器那条线程**。
     *
     * 已经就在那条线程上时直接跑：`prepare` 之后紧接着的 `play` 不该被排到下一轮去
     * （那一轮的延迟会变成「点播放到出声」的手感）。
     */
    private fun runOnPlayer(action: Runnable) {
        if (released) return
        if (Looper.myLooper() == handler.looper) {
            try {
                action.run()
            } catch (error: Throwable) {
                // 播放器这块出任何意外都不要带崩进程：报给 Web 层，让它按「播不出来」处理。
                emit("error", cachedPositionMs, cachedDurationMs, error.toString())
            }
            return
        }
        handler.post {
            try {
                action.run()
            } catch (error: Throwable) {
                emit("error", cachedPositionMs, cachedDurationMs, error.toString())
            }
        }
    }

    /**
     * 换源前把取流头换成本地址该带的那一份（目前只有飞牛要带会话 Cookie，
     * 见 MusicGateway.headersForPlaybackUrl）。没有就清空 —— 别把上一首的
     * 头带给下一首。
     */
    private fun applySourceHeaders(url: String) {
        val factory = httpFactory ?: return
        val headers = top.izuna.foliamajor.online.MusicGateway.headersForPlaybackUrl(url)
        // media3 的 setDefaultRequestProperties 收 Map<String, String>（Kotlin 形态即可）。
        factory.setDefaultRequestProperties(headers)
    }

    private fun ensurePlayer(): ExoPlayer {
        val current = player
        if (current != null) return current

        val factory = DefaultHttpDataSource.Factory()
            .setUserAgent(BROWSER_USER_AGENT)
            .setAllowCrossProtocolRedirects(true)
        httpFactory = factory

        val created = ExoPlayer.Builder(context)
            // 显式钉在播放器那条专用线程上。不写这一句，播放器会绑到「第一次碰它的那个
            // 线程」—— 也就是 Capacitor 的桥线程，而位置上报会跑到别的线程上去，
            // 于是每 250ms 跨线程碰一次播放器。
            .setLooper(playerLooper)
            .setMediaSourceFactory(DefaultMediaSourceFactory(factory))
            .build()
        // 焦点交给 ExoPlayer 自己管。WebView 那套「把 Chromium 的焦点监听器换成空实现」
        // 的反向 hack（audio/FoliaAudioManager）是为 `<audio>` 做的，原生产不出那种问题。
        created.setAudioAttributes(AudioAttributes.DEFAULT, true)
        created.setVolume(requestedVolume)
        created.addListener(playerListener)
        player = created
        /*
         * 播放器被回收过（Activity 重建 / 进程里那一层被拆掉）而 JS 那边还当它在播：
         * 这时候从系统控件点「播放」拿到的就是一个空播放器，点下去什么都不会发生。
         * 记住最后一首，重建时顺手装回去 —— 位置用缓存的最后一次上报。
         */
        val restoredUrl = lastUrl
        if (restoredUrl != null && created.mediaItemCount == 0) {
            applySourceHeaders(restoredUrl)
            created.setMediaItem(MediaItem.fromUri(restoredUrl))
            created.setRepeatMode(requestedRepeatMode)
            created.setVolume(requestedVolume)
            created.prepare()
            if (cachedPositionMs > 0) {
                created.seekTo(cachedPositionMs)
            }
        }
        return created
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val current = player ?: return
            when (playbackState) {
                Player.STATE_READY -> {
                    val duration = current.duration
                    cachedDurationMs = if (duration > 0) duration else 0L
                    emit("ready", current.currentPosition, cachedDurationMs, null)
                }
                Player.STATE_ENDED -> {
                    cachedPlaying = false
                    stopTicking()
                    emit("ended", cachedDurationMs, cachedDurationMs, null)
                }
                Player.STATE_BUFFERING -> {
                    emit("buffering", current.currentPosition, cachedDurationMs, null)
                }
                else -> {}
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            val current = player ?: return
            cachedPositionMs = current.currentPosition
            if (isPlaying) {
                startTicking()
                emit("playing", cachedPositionMs, cachedDurationMs, null)
                return
            }
            /*
             * ⚠️ `isPlaying = false` **不等于暂停**。
             *
             * ExoPlayer 的语义是「此刻有没有在出声」：缓冲、音频焦点被短暂抢走、
             * 音轨欠载都会翻成 false，而歌并没有停。那时候要是发 "paused"，Web 侧会把
             * 播放标记清掉 —— 插值那一截凭空没了，进度条与歌词掉回 250ms 前的采样值，
             * 再被下一帧追上来，看起来就是「往回抽一下又恢复」。
             *
             * 所以只有**真的按了暂停**（playWhenReady = false）才发 paused；其余一律
             * 当作 buffering：位置照报、计时照走，只是这一刻没有出声。
             */
            if (!current.playWhenReady) {
                stopTicking()
                emit("paused", cachedPositionMs, cachedDurationMs, null)
                return
            }
            emit("buffering", cachedPositionMs, cachedDurationMs, null)
        }

        /**
         * 位置跳变：用户 seek、单曲循环回到开头、以及播放器自己换媒体项。
         *
         * 原生不再每 250ms 把位置过桥（见 FoliaNativePlayerPlugin 的说明），
         * Web 侧的时钟靠墙钟往前推 —— 所以「单曲循环回到 0」这种**允许往回走**的
         * 跳变必须单独报一次，否则 Web 那边会一直停在 duration 上。
         */
        override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
            val current = player ?: return
            var position = if (newPosition == null) current.currentPosition else newPosition.positionMs
            if (position < 0L) position = 0L
            cachedPositionMs = position
            emit("seeked", position, cachedDurationMs, null)
        }

        override fun onPlayerError(error: PlaybackException) {
            cachedPlaying = false
            stopTicking()
            emit("error", cachedPositionMs, cachedDurationMs, if (error == null) "unknown" else error.message)
        }
    }

    private fun startTicking() {
        if (tickScheduled) return
        tickScheduled = true
        handler.post(positionTick)
    }

    private fun stopTicking() {
        tickScheduled = false
        handler.removeCallbacks(positionTick)
    }

    private fun emit(type: String, positionMs: Long, durationMs: Long, message: String?) {
        if (listener != null) {
            listener.onEvent(type, positionMs, durationMs, message)
        }
    }
}
