package top.izuna.foliamajor.lyricon

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log

// Kotlin 转换注：集合不写 `import java.util.List` —— 那样 List/ArrayList 在 Kotlin 里
// 会变成与 kotlin.collections 互不相通的 Java 名义类型。用 Kotlin 默认导入的版本。
import io.github.proify.lyricon.lyric.model.RichLyricLine
import io.github.proify.lyricon.lyric.model.Song
import io.github.proify.lyricon.provider.LyriconFactory
import io.github.proify.lyricon.provider.LyriconProvider
import io.github.proify.lyricon.provider.RemotePlayer

/**
 * 状态栏歌词（Lyricon）的原生侧。
 *
 * Lyricon 是一个中心服务：各个播放器作为「Provider」把当前歌曲、歌词与播放进度推给它，
 * 由它统一渲染到状态栏。这里做的就是把 Folia 已经在播的东西转译过去。
 *
 * 两条纪律：
 * 1. **SDK 是 Kotlin 写的，Kotlin 的默认参数对 Java 不可见**，所以 `createProvider`
 *    的八个参数必须一个不少地显式传（默认值见 LyriconFactory 的 `createProvider$default`）。
 * 2. **任何一次调用失败都不能带崩应用。** 用户可能压根没装 Lyricon，也可能装的是不兼容的
 *    版本；那时这里只是安静地不可用，UI 上如实显示「未连接」即可。
 */
class FoliaLyricon private constructor() {

    companion object {

        private const val TAG = "FoliaLyricon"
        private const val PREFS = "folia_lyricon"
        private const val KEY_ENABLED = "enabled"
        /** Lyricon 中心服务的包名，SDK 自己的默认值。 */
        private const val CENTRAL_PACKAGE = "com.android.systemui"

        /** 位置推进容差（毫秒）：比这更小的前进不值得单独过桥一次。 */
        private const val POSITION_EPSILON_MS = 200L
        /**
         * 时间倒退的容差（毫秒）。真跳转一次会退很远，采样抖动只退一点点；
         * 小步后退一律丢弃，否则中心服务会在两个字之间来回抽搐。
         */
        private const val BACKWARD_JITTER_MS = 1200L
        /**
         * 判定「这是一次跳转」的跨度（毫秒）。
         *
         * 心跳 500ms 一次，正常播放时相邻两帧的位置差就是 500ms 上下；差出 2 秒以上
         * 就只可能是拖动进度条、切歌恢复进度这类真跳转。
         */
        private const val SEEK_JUMP_MS = 2000L
        /**
         * 中心服务读取播放位置的间隔（毫秒）。
         *
         * `setPosition` 只是往一块 SharedMemory 里写一个 long（没有 IPC、也不会回弹），
         * 中心服务按自己的节奏去读。两边节奏对不上时，它按速度外推出来的位置和我们写进去的
         * 位置会在每个周期互相拉扯 —— 这就是「进度抽搐」。所以这里显式对齐到心跳的 500ms。
         */
        private const val POSITION_UPDATE_INTERVAL_MS = 500

        @Volatile
        private var provider: LyriconProvider? = null
        @Volatile
        private var player: RemotePlayer? = null
        @Volatile
        private var registered: Boolean = false
        /** 建过一次失败就不再反复重试：中心服务不在就是不在，重试只会白耗一次绑定。 */
        @Volatile
        private var unavailable: Boolean = false

        /**
         * 上一次真正推给中心服务的播放状态与位置。
         *
         * 心跳每 500ms 一次，但**播放状态绝大多数心跳里都没变**。早先的做法是每次心跳
         * 都跟着 setPosition 一起把 setPlaybackState 也推一遍，中心服务每次收到都要重算
         * 一遍显示状态 —— 表现是偶发卡顿，以及进度条/高亮位置突然抽搐。这里只在状态真的
         * 翻转、或位置真的往前走了的时候才推。
         */
        @Volatile
        private var lastPlaying: Boolean? = null
        @Volatile
        private var lastPositionMs: Long = -1L

        /**
         * 最近一次推给中心服务的歌。
         *
         * 重新注册之后要能把整首再发一遍：中心服务的进程重启（SystemUI 重建、用户强停）
         * 会把我们这条 Provider 记录丢掉，那时候只补位置是补不回来的 ——
         * 状态栏上没有歌词，补什么位置都没意义。而 JS 那边恰好**不知道**这件事
         * （没有回读通道），所以这份缓存必须由原生自己留着。
         */
        @Volatile
        private var lastSong: Song? = null
        /** 上面那首歌对应的签名：重发之后要把它**补回去**，否则心跳会每 5 秒重发一次整首。 */
        @Volatile
        private var lastSongSignature: String? = null

        /**
         * 位置推进的锚点：`SystemClock.elapsedRealtime()` 走到 `anchorElapsedMs` 时，
         * 播放位置是 `anchorPositionMs`，速度恒为 1x（暂停时不再前进）。
         *
         * **这就是为什么保活必须放在原生：** Web 侧的心跳是 JS 定时器，应用一退到后台
         * 就被系统挂起 —— 而状态栏歌词**恰恰**是应用不在前台时才有人看的东西。
         * 于是症状就变成「有时候不动了，转屏也没用，只有暂停再播放能救回来」：
         * 那条路径本来就是 JS 唯一的活路，而它在后台早就不跑了。
         *
         * 锚点模型让原生成了唯一的时间源：应用每次告诉我们位置，就顺手更新一次锚点，
         * 之后由**原生按自己的墙钟往前推**，每隔 HEARTBEAT_INTERVAL_MS 写一次。
         * JS 冻住也没关系，歌词照样往下走。
         */
        @Volatile
        private var anchorPositionMs: Long = 0L
        @Volatile
        private var anchorElapsedMs: Long = 0L
        @Volatile
        private var anchorPlaying: Boolean = false
        @Volatile
        private var anchorDurationMs: Long = 0L

        private const val HEARTBEAT_INTERVAL_MS = 5000L
        /*
         * ⭐ 心跳**绝不能挂在主线程**。
         *
         * 每一轮都是好几次跨进程调用 —— `player.isActive()`、`provider.register()`、
         * `setPlaybackState` / `setPosition` —— 通向 SystemUI 那侧的 Lyricon 中心服务。
         * 对方一忙（锁屏正在渲染、Binder 拥塞）就把这边的主线程**同步**堵住，5 秒一次，
         * 界面上正是「每隔五六秒顿一下，像在等什么东西」。App 内跑着可视化，掉几帧最
         * 明显；壁纸渲染器在它自己的渲染线程上，所以看起来「只有 App 内卡」。
         *
         * 这些 SDK 调用不碰任何 UI，不需要主线程 —— 起一条专用线程即可。
         * 与播放器那条同理（见 FoliaNativePlayer 文件头）：线程归属是硬性的。
         */
        @Volatile
        private var heartbeatHandler: Handler? = null
        @Volatile
        private var heartbeatContext: Context? = null
        @Volatile
        private var heartbeatScheduled: Boolean = false

        private fun handler(): Handler {
            val existing = heartbeatHandler
            if (existing != null) {
                return existing
            }
            return synchronized(FoliaLyricon::class.java) {
                val locked = heartbeatHandler
                if (locked == null) {
                    // 线程本身不必单独留字段：Handler 抓着它的 Looper，Looper 抓着线程。
                    val thread = HandlerThread("folia-lyricon-heartbeat")
                    thread.start()
                    val created = Handler(thread.getLooper())
                    heartbeatHandler = created
                    created
                } else {
                    locked
                }
            }
        }

        @JvmStatic
        fun isEnabled(context: Context?): Boolean {
            if (context == null) return false
            return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getBoolean(KEY_ENABLED, false)
        }

        /** 中心服务在不在。只有真正注册成功之后才敢说「在」。 */
        @JvmStatic
        fun isConnected(): Boolean {
            val current = player
            return registered && current != null && current.isActive
        }

        /**
         * 开关。关掉时主动 unregister 并 destroy，把远端连接放掉 ——
         * 只是不推数据的话，中心服务那边仍会一直显示上一首的歌词。
         */
        @JvmStatic
        fun setEnabled(context: Context?, enabled: Boolean): Boolean =
            synchronized(FoliaLyricon::class.java) {
                if (context == null) return@synchronized false
                val appContext = context.getApplicationContext()
                appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit()
                        .putBoolean(KEY_ENABLED, enabled)
                        .apply()
                if (!enabled) {
                    teardown()
                    return@synchronized true
                }
                ensureRegistered(appContext)
            }

        /** 上一次推过去的歌的签名。用来挡掉重复的 setSong（见 publish）。 */
        @Volatile
        private var publishedSignature: String? = null

        /**
         * 保活心跳（原生侧）。
         *
         * 见 `anchorPositionMs` 的说明：段内的推进不能指望 JS 的定时器。
         * 这里每 5 秒按锚点算一次当前位置写进去 —— 走得准的话，写进去的值和中心服务
         * 自己外推出来的几乎一致，完全看不出来；万一它哪天不自己走了，最多 5 秒就接上。
         */
        private val heartbeatTask: Runnable = object : Runnable {
            override fun run() {
                heartbeatScheduled = false
                val context = heartbeatContext
                if (context == null || !isEnabled(context)) {
                    return
                }
                synchronized(FoliaLyricon::class.java) {
                    try {
                        tickLocked(context)
                    } catch (error: Throwable) {
                        Log.w(TAG, "Lyricon heartbeat failed", error)
                    }
                }
                scheduleHeartbeat()
            }
        }

        private fun scheduleHeartbeat() {
            if (heartbeatScheduled) {
                return
            }
            heartbeatScheduled = true
            handler().postDelayed(heartbeatTask, HEARTBEAT_INTERVAL_MS)
        }

        private fun stopHeartbeat() {
            heartbeatScheduled = false
            val existing = heartbeatHandler
            if (existing != null) {
                existing.removeCallbacks(heartbeatTask)
            }
        }

        /** 心跳这一轮真正做的事。调用方已持锁。 */
        private fun tickLocked(context: Context) {
            /*
             * 先确认连接还活着。
             *
             * 「不动了」的另一种可能：中心服务进程被重建（SystemUI 重启、内存回收），
             * 我们这条注册记录随之失效，而 `registered` 这个布尔量还停在 true ——
             * 之后无论写什么位置都进不去。`player.isActive()` 是唯一的现问手段。
             * 发现失效就整套重来：重新注册成功后把缓存的那首歌再发一遍，然后照常补位置。
             */
            val current = player
            if (current != null && registered && !current.isActive) {
                Log.w(TAG, "Lyricon session went inactive; re-registering")
                registered = false
                player = null
                provider = null
                publishedSignature = null
                lastPlaying = null
                lastPositionMs = -1L
            }
            if (!ensureRegistered(context)) {
                return
            }
            val cached = lastSong
            if (cached != null && publishedSignature == null) {
                /*
                 * 重连之后整首再发一次（含随之而来的位置补全），顺序纪律见 publish。
                 *
                 * 发完必须把签名补回去：不补的话 publishedSignature 一直是 null，
                 * 心跳会每隔 5 秒重发一次整首 —— 而 setSong 会重置中心服务的显示状态，
                 * 那正好是「状态栏每隔几秒闪一下」的形状，比不动还难看。
                 */
                if (publishSongLocked(cached)) {
                    publishedSignature = lastSongSignature
                }
            }
            if (!anchorPlaying) {
                return
            }
            val elapsed = SystemClock.elapsedRealtime() - anchorElapsedMs
            var positionMs = anchorPositionMs + Math.max(0L, elapsed)
            if (anchorDurationMs > 0L) {
                positionMs = Math.min(positionMs, anchorDurationMs)
            }
            /*
             * allowSeek = false：心跳是正常播放的**延续**，不是跳转。
             *
             * 走 seekTo 那条路的话，中心服务每 5 秒被告知一次「这是一次跳转」，
             * 它会丢掉现有的显示状态去追一个新位置 —— 那正好就是我们花了几轮才清掉的
             * 「抽搐」，只不过从每段一次变成每 5 秒一次。
             */
            applyLocked(positionMs, true, false, false)
        }

        /**
         * 应用最近一次告诉我们的位置 / 播放状态。
         *
         * 和下面去重用那两个字段**不是一回事**：那两个是"上次真正过桥了什么"，
         * 会被 `publish` 清零；这两个是"应用现在在哪"，用来在 setSong 之后把位置补回去
         * （见 publish 里的说明）。
         */
        @Volatile
        private var knownPositionMs: Long = 0L
        @Volatile
        private var knownPlaying: Boolean = false

        /**
         * 播放状态带上**速度**和"这个位置是哪一时刻的"。
         *
         * 只调 `setPlaybackState(boolean)` 的话，中心服务只知道"在播 / 没在播"，
         * 位置只能靠我们一遍遍写进共享内存 —— 写得频繁，它读出来的和我们写进去的
         * 反复拉扯（抽搐）；写得稀疏，它就停在最后一次写的值上不动。
         *
         * `PlaybackState` 里带 `playbackSpeed` 与 `lastPositionUpdateTime`，
         * 中心服务可以自己按 `position + (now - updateTime) * speed` 往前推 ——
         * 于是段内我们一句话都不用说，也不用按节拍灌位置。
         */
        private fun buildPlaybackState(positionMs: Long, playing: Boolean): PlaybackState {
            val builder = PlaybackState.Builder()
            builder.setState(
                    if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    positionMs,
                    // 暂停时速度必须是 0：留着 1.0 的话中心服务会一路推算到歌曲外面去。
                    if (playing) 1.0f else 0.0f,
                    SystemClock.elapsedRealtime())
            return builder.build()
        }

        /**
         * 判断「这首歌跟上次推的是不是同一首」。
         *
         * 只看能改变画面内容的字段：曲目标识、时长、行数、首尾行文本与有没有翻译。
         * 不看播放位置 —— 那是 setPosition 的事。
         */
        private fun signatureOf(id: String?, title: String?, artist: String?, durationMs: Long,
                                lines: List<RichLyricLine>?): String {
            val builder = StringBuilder()
            builder.append(id).append('␟').append(title).append('␟').append(artist)
                    .append('␟').append(durationMs).append('␟')
            if (lines != null) {
                builder.append(lines.size)
                for (line in lines) {
                    builder.append('␞').append(line.text)
                            .append('␞').append(line.begin)
                            .append('␞').append(line.translation ?: "")
                }
            }
            return builder.toString()
        }

        /**
         * 换歌：整首歌连同歌词一起推过去。
         *
         * **重复推同一首会被挡掉。** 歌词是异步到的（翻译尤其晚），数组每次都是新对象，
         * 若不加这道签名，同一个 effect 会反复触发 setSong —— 中心服务每次收到 setSong
         * 都会重置显示状态，用户看到的就是「双行用着用着变回单行」。
         */
        @JvmStatic
        fun publish(context: Context?, id: String?, title: String?, artist: String?,
                    durationMs: Long, lines: List<RichLyricLine>?): Boolean =
            synchronized(FoliaLyricon::class.java) {
                if (context == null) return@synchronized false
                val appContext = context.getApplicationContext()
                if (!isEnabled(appContext)) return@synchronized false
                val signature = signatureOf(id, title, artist, durationMs, lines)
                /*
                 * **同一首被去重时也必须把位置补回去。**
                 *
                 * publish 在 Web 侧还兼着「重同步」的角色：回前台、转屏走的都是
                 * 「整首推一次 + 紧接着补位置」这一串。内容没变 → 签名相同 → 直接返回，
                 * 于是中心服务那边既没有 setSong 也没有位置写入 —— 「切换屏幕方向也没有用」
                 * 就是从这儿来的：去重把它当成无事发生，而调用方恰恰是在求一次全量重同步。
                 *
                 * 补一次位置是最便宜的动作（共享内存里一个 long，没有 IPC），
                 * 对外又正好是一次「全量重同步」该有的样子。
                 */
                if (signature == publishedSignature) {
                    applyLocked(positionNowLocked(), anchorPlaying, true, false)
                    return@synchronized true
                }
                if (!ensureRegistered(appContext)) return@synchronized false
                try {
                    val song = Song(
                            if (id == null) "" else id,
                            if (title == null) "" else title,
                            if (artist == null) "" else artist,
                            if (durationMs > 0L) durationMs else 0L,
                            null,
                            if (lines == null) ArrayList<RichLyricLine>() else lines)
                    lastSong = song
                    lastSongSignature = signature
                    anchorDurationMs = if (durationMs > 0L) durationMs else 0L
                    if (!publishSongLocked(song)) return@synchronized false
                    publishedSignature = signature
                    return@synchronized true
                } catch (error: Throwable) {
                    Log.w(TAG, "Failed to publish the current song to Lyricon", error)
                    return@synchronized false
                }
            }

        /**
         * 真正过桥发一首歌，并**紧接着把位置补回去**。
         *
         * 调用方必须已经 `ensureRegistered` 且持锁。
         */
        private fun publishSongLocked(song: Song): Boolean {
            try {
                val current = player
                if (current == null) return false
                if (!current.setSong(song)) return false
                // 顺序按 SDK 文档：先 setSong，再位置与播放状态，显示开关放最后。
                current.setDisplayTranslation(true)
                /*
                 * **setSong 之后必须立刻把位置补回去，而且是原生自己补。**
                 *
                 * setSong 会重置中心服务的显示状态（位置也一起清掉）。
                 * 以前靠 JS 在 publish 之后紧接着调一次 setPosition 来补 —— 但那是两个
                 * 独立的桥调用，谁先到原生**没有保证**：位置先到的话，紧接着的 setSong
                 * 就把它冲掉了，之后再没有任何人推位置。表现正是
                 * 「切了下一首状态栏完全不动」。而且回前台 / 转屏走的是同一条路，
                 * 所以它们也一起失效。
                 *
                 * 放在原生这一侧补，顺序就是确定的：setSong 成功 → 立刻 setPosition。
                 */
                lastPlaying = null
                lastPositionMs = -1L
                applyLocked(positionNowLocked(), anchorPlaying, true, false)
                return true
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to publish the current song to Lyricon", error)
                return false
            }
        }

        /** 按锚点算出现在的播放位置（暂停时停在锚点上不前进）。 */
        private fun positionNowLocked(): Long {
            if (!anchorPlaying) {
                return knownPositionMs
            }
            val elapsed = SystemClock.elapsedRealtime() - anchorElapsedMs
            var positionMs = anchorPositionMs + Math.max(0L, elapsed)
            if (anchorDurationMs > 0L) {
                positionMs = Math.min(positionMs, anchorDurationMs)
            }
            return positionMs
        }

        /**
         * 播放进度与播放/暂停。心跳每次都走这里，所以失败也只记一条日志。
         *
         * **播放状态只在翻转时推。** 每 500ms 重推一次同一个 playing 值，中心服务就要重算
         * 一次显示状态，用户看到的是偶发卡顿与进度抽搐。
         *
         * **位置只在真的动了时推。** 暂停时位置根本不变，那样的心跳一次都不必过桥。
         */
        @JvmStatic
        fun setPosition(context: Context?, positionMs: Long, playing: Boolean,
                        continuous: Boolean): Boolean =
            synchronized(FoliaLyricon::class.java) {
                if (context == null) return@synchronized false
                val appContext = context.getApplicationContext()
                if (!isEnabled(appContext)) return@synchronized false
                if (!ensureRegistered(appContext)) return@synchronized false
                // 记下"应用现在在哪"，换歌时要用它把位置补回去（见 publish）。
                knownPositionMs = positionMs
                knownPlaying = playing
                /*
                 * 每次 application 告诉我们位置，就顺手把锚点刷新一次：
                 * 原生的保活心跳靠它往前推（见 heartbeatTask）。
                 */
                anchorPositionMs = positionMs
                anchorElapsedMs = SystemClock.elapsedRealtime()
                anchorPlaying = playing
                heartbeatContext = appContext
                scheduleHeartbeat()
                applyLocked(positionMs, playing, true, !continuous)
            }

        /**
         * 真正过桥的那一段。调用方必须已经 `ensureRegistered` 且持有锁。
         *
         * @param force     无条件写。那两个 epsilon 去重会让一次「重同步」变成空操作
         *                  （见 publish 的去重分支）—— 明确要求同步时必须绕过它们。
         * @param allowSeek 位置跨度够大时是否明说「这是一次跳转」。心跳必须给 false，
         *                  否则每 5 秒就被当成一次 seek。
         */
        private fun applyLocked(positionMs: Long, playing: Boolean, force: Boolean,
                                allowSeek: Boolean): Boolean {
            val current = player
            if (current == null) return false

            val stateChanged = lastPlaying != playing
            val moved: Boolean
            if (force) {
                moved = true
            } else if (lastPositionMs < 0L) {
                moved = true
            } else if (positionMs < lastPositionMs) {
                // 时间倒退只有两种可能：真跳转，或采样抖动。小步后退按抖动处理，直接丢弃。
                moved = lastPositionMs - positionMs >= BACKWARD_JITTER_MS
            } else {
                moved = positionMs - lastPositionMs >= POSITION_EPSILON_MS
            }

            if (!stateChanged && !moved) {
                return true
            }

            try {
                /*
                 * 顺序不能乱：**状态在前，位置在后。**
                 *
                 * 试过把位置写在前面、播放状态放后面，结果整条链路完全失效 ——
                 * 中心服务收到 setPlaybackState 时会重置自己的显示状态（连带位置），
                 * 刚写进去的那一下就被冲掉了。所以位置必须是这一串里**最后**一个动作。
                 */
                if (stateChanged) {
                    current.setPlaybackState(playing)
                    lastPlaying = playing
                }
                /*
                 * 带速度的 PlaybackState：让中心服务自己往前走的那一份。
                 *
                 * 单独包一层 try —— 并不是每个版本的中心服务都认这个重载，
                 * 万一不支持/直接抛异常，不能把下面正常的 setPosition 一起拖下水。
                 *
                 * 位置必须在它**之后**再写（见下面）：setPlaybackState 会重置显示状态。
                 */
                try {
                    current.setPlaybackState(buildPlaybackState(positionMs, playing))
                } catch (ignored: Throwable) {
                    // 不认就退回"只认喂进去的位置"的模式，其余照旧。
                }
                if (moved) {
                    val jump = if (lastPositionMs < 0L) 0L else Math.abs(positionMs - lastPositionMs)
                    if (allowSeek && jump >= SEEK_JUMP_MS) {
                        // 明说「这是一次跳转」。只改共享内存里的位置的话，中心服务会以为
                        // 播放位置自己跳了一截，于是按速度去追 —— 追的那一段就是抽搐。
                        current.seekTo(positionMs)
                    }
                    current.setPosition(positionMs)
                    lastPositionMs = positionMs
                }
                return true
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to sync the playback position to Lyricon", error)
                return false
            }
        }

        /** 停止播放 / 清空：让状态栏把歌词收起来，而不是停在没有歌词的那一行上。 */
        @JvmStatic
        fun clear(context: Context?) {
            synchronized(FoliaLyricon::class.java) {
                if (context == null) return@synchronized
                val appContext = context.getApplicationContext()
                // 都清空了，没什么可保活的：心跳下一次 setPosition 会自己再起来。
                stopHeartbeat()
                anchorPlaying = false
                lastSong = null
                lastSongSignature = null
                if (!isEnabled(appContext)) return@synchronized
                if (!ensureRegistered(appContext)) return@synchronized
                try {
                    val current = player
                    if (current == null) return@synchronized
                    current.setPlaybackState(false)
                    current.setSong(null)
                    // 清空之后同一首歌要能重新推上去：签名不清掉的话，publish 会拿它跟
                    // 上一次比对后直接返回，歌词就再也不回来了。
                    publishedSignature = null
                    lastPlaying = null
                    lastPositionMs = -1L
                } catch (error: Throwable) {
                    Log.w(TAG, "Failed to clear the Lyricon state", error)
                }
            }
        }

        private fun ensureRegistered(context: Context): Boolean {
            if (registered && player != null) return true
            if (unavailable) return false
            try {
                if (provider == null) {
                    val packageName = context.getPackageName()
                    provider = LyriconFactory.createProvider(
                            context,
                            packageName,
                            packageName,
                            null,
                            null,
                            processName(context),
                            null,
                            CENTRAL_PACKAGE)
                }
                val created = provider
                if (created == null) {
                    // API 27 以下 SDK 返回空实现；那不是故障，只是不可用。
                    unavailable = true
                    Log.w(TAG, "Lyricon provider is unavailable on this device")
                    return false
                }
                val currentPlayer = created.player
                player = currentPlayer
                registered = created.register()
                if (!registered) {
                    Log.w(TAG, "Lyricon refused the registration; is the central service installed?")
                    return false
                }
                try {
                    // 把中心服务的读取节奏对齐到我们的推送节奏，见 POSITION_UPDATE_INTERVAL_MS。
                    currentPlayer.setPositionUpdateInterval(POSITION_UPDATE_INTERVAL_MS)
                } catch (error: Throwable) {
                    Log.w(TAG, "Failed to align the position update interval", error)
                }
                return true
            } catch (error: Throwable) {
                unavailable = true
                Log.w(TAG, "Failed to register as a Lyricon provider", error)
                return false
            }
        }

        private fun teardown() {
            stopHeartbeat()
            anchorPlaying = false
            lastSong = null
            lastSongSignature = null
            try {
                val currentProvider = provider
                if (registered && currentProvider != null) {
                    currentProvider.unregister()
                }
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to unregister from Lyricon", error)
            }
            try {
                val currentProvider = provider
                if (currentProvider != null) {
                    currentProvider.destroy()
                }
            } catch (error: Throwable) {
                Log.w(TAG, "Failed to destroy the Lyricon provider", error)
            }
            registered = false
            player = null
            provider = null
            publishedSignature = null
            lastPlaying = null
            lastPositionMs = -1L
            // SDK 一旦失败就一直失败，换个进程重新建才有意义。
            unavailable = false
        }

        private fun processName(context: Context): String {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val name = Application.getProcessName()
                return name ?: context.getPackageName()
            }
            return context.getPackageName()
        }
    }
}
