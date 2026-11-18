package top.izuna.foliamajor.player.dsp

import android.content.Context
import android.util.Log
import top.izuna.foliamajor.player.FoliaNativePlayer
import top.izuna.foliamajor.settings.FoliaSettingsStore
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/InstrumentalCoordinator.kt
// 「关闭人声」的调度：决定这一刻该播原曲还是播伴奏、要不要开始生成。
//
// 三种时机都会走到这里：
//   1. 用户拨开关；
//   2. 换歌（插件 prepare）；
//   3. 后台生成完成（要判断「用户还在听这首吗、开关还开着吗」再换源）。
//
// 它自己不认识 UI：状态靠 [status] 给插件轮询，进度靠 [notify] 往外发事件。
//
// 一条纪律：**换源永远走 FoliaNativePlayer.swapSource()**，不要在这里自己 setMediaItem ——
// 位置、播放状态、songKey、交叉淡化收尾都在那一个方法里处理。

internal object InstrumentalCoordinator {

    private const val TAG = "Instrumental"

    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "folia-instrumental").apply {
            isDaemon = true
            /*
             * 比普通线程低一格：生成伴奏是几十秒的推理，正在放的这首歌不能因为它
             * 卡一下（解码、AudioTrack 都在同几个核上）。
             */
            priority = Thread.NORM_PRIORITY - 1
        }
    }

    /** 每次开始生成 +1。旧的活干完时对不上号就直接丢掉结果。 */
    private val generation = AtomicInteger(0)

    @Volatile private var state: String = STATE_IDLE
    @Volatile private var percent: Int = 0
    @Volatile private var activeKey: String? = null

    /**
     * 这一趟跑完要不要换源。
     *
     * 预生成跑着的时候用户拨了开关，不应该把已经跑了半首的推理作废重来 ——
     * 把标志翻过来，跑完直接切过去就行。这正是「提前分析、拨开关秒切」的意义。
     */
    @Volatile private var switchOnDone: Boolean = false

    var notify: ((String, Int) -> Unit)? = null

    /**
     * 「这条原曲地址已经不该再用了，请 Web 侧重新解析一个」。
     *
     * 为什么原生这边不能自己解决：原曲地址是**平台给的签名直链**（B 站带 `deadline=`，
     * 音乐平台也会过期），重新要一个要走各平台的 adapter 与账号会话，那是 Web 侧
     * （omni）的活，原生不认识任何一个平台。
     *
     * 参数是这一首的身份（songKey）；Web 侧据此确认「要重解析的确实是此刻这一首」，
     * 拿到新地址后按正常装源换过去 —— 与播放页自己恢复音源走的是同一条路。
     */
    var requestFreshSource: ((songKey: String?, reason: String) -> Unit)? = null

    /**
     * 四轨生成完成后，通知插件把这首歌的四轨状态发布给音频线程（StemMixState），
     * 让「清唱 / 伴奏 / 全部」都走四轨混音。参数与生成时的 url / songKey 一致。
     *
     * [userInitiated] 表示「用户拨着开关在等这一趟」（switchOnDone）：
     * 只有它为 true 时插件才允许把四轨发布给音频线程接管当前播放 ——
     * 预拆（整队队列 / 「立即拆分」按钮）完成的歌哪怕恰好是正在放的这首，
     * 也不该无脑把原曲换成分离再混音的版本；缓存留着，等下一次装源或
     * 用户显式操作时自然生效。
     */
    var onStemsReady: ((url: String?, songKey: String?, userInitiated: Boolean) -> Unit)? = null

    /** 事件归属判断用：此刻正在为哪首歌跑（building 时的 key；其余状态为 activeKey 残留）。 */
    fun activeKeyOrNull(): String? = activeKey

    /** 当前是否在后台。由插件生命周期写入；拆分在后台时慢而缓。 */
    var isAppInBackground: () -> Boolean = { false }

    /**
     * 一条地址**多久之后就可能已经过期**。
     *
     * B 站的取流地址一般撑几个小时，音乐平台的 CDN 地址也差不多；从这个量级往下取，
     * 主要防的是「分离跑了几十秒到几分钟之后，手里那条已经不新鲜了」这一种。
     * 判据只用来决定「切回全部时要不要顺手要一条新的」，不是严格的过期时刻 ——
     * 早一点要新的只是多一次请求，晚一点就是放不出来。
     */
    private const val SOURCE_LIKELY_STALE_MS = 45L * 60 * 1000

    /**
     * 装原曲那一刻的时刻（毫秒）。与 [prepareInternal] 同一个纪律：装源时写，
     * 切回原曲时读 —— 用来判断手上这条地址是不是已经放了很久。
     */
    @Volatile
    private var preparedAtMs: Long = 0L

    /** 记下「原曲是在这一刻装的」。插件 prepare 之后调一次。 */
    fun noteSourcePrepared() {
        preparedAtMs = System.currentTimeMillis()
    }

    /**
     * 这条原曲地址是不是**可能已经过期**（装了很久，或者带取流签名）。
     *
     * 纯函数版可单测。`signed` 由调用方按地址判断（见 [looksSigned]）。
     */
    internal fun sourceMayBeStale(
        preparedAt: Long,
        now: Long,
        signed: Boolean,
    ): Boolean {
        if (signed) return true
        if (preparedAt <= 0L) return true
        return now - preparedAt >= SOURCE_LIKELY_STALE_MS
    }

    /**
     * 这条地址看着像带时效的取流签名。
     *
     * 命中就认为它随时可能失效：视频站的 CDN 地址一律带这些参数，音乐平台的直链也常带
     * `expires` / `token`。没有签名的（本地文件、回环地址、平台长链）走计时那条判据。
     */
    internal fun looksSigned(url: String?): Boolean {
        val text = url.orEmpty()
        if (text.isEmpty()) return false
        // 本地文件 / 本机回环（媒体缓存、音频服务、视频中转）永远不会过期，别把要新的请求发出去。
        if (text.startsWith("file:")) return false
        if (text.startsWith("http://127.0.0.1") || text.startsWith("http://localhost")) return false
        return text.contains("deadline=") || text.contains("upsig=") ||
            text.contains("expires=") || text.contains("sign=") || text.contains("token=")
    }

    fun status(): Triple<String, Int, String?> = Triple(state, percent, activeKey)

    /**
     * 拨开关 / 换歌之后的统一入口。
     *
     * 播哪一轨由 [NativeEqualizerState.activeMode] 决定（两个开关互斥），
     * 调用方不要再传布尔 —— 之前那种「两个都开」会一会儿换伴奏一会儿换清唱。
     *
     * @param url     这一首的原地址
     * @param songKey 这一首的身份，缓存键优先用它
     */
    fun reconcile(context: Context, player: FoliaNativePlayer?, url: String?, songKey: String?) {
        if (player == null || url.isNullOrBlank()) {
            cancel()
            return
        }
        val mode = NativeEqualizerState.activeMode()
        if (mode == null) {
            /*
             * 关掉开关只该把音源换回原曲，**不该把正在跑的提前分析作废**。
             *
             * 那趟任务是给「下次拨开关」备缓存的，跟此刻开关开没开无关；
             * cancel() 会 generation+1 让它白跑。判据是 switchOnDone：
             * true 表示这趟是用户拨开关发起的，关掉就该停；false 是预生成，留着。
             */
            val prebuilding = !switchOnDone && state == STATE_BUILDING
            if (!prebuilding) cancel()
            /*
             * 换回原曲的判据也必须是「此刻装的是不是这一轨」，不能是 isOnInstrumental()
             * 那个布尔：伴奏与清唱都为 true，它说不清现在到底在哪一轨。用户从「人声」
             * 切「全部」时若播放器还停在清唱轨上，用目标地址比一次才不会漏切；已经在
             * 原曲上则短路，不重复 prepare。
             *
             * 再加一道身份校验：url 必须与播放器记着的原曲地址一致。切歌竞态里
             * reconcile 可能拿着上一首的地址进来，少了这一条就会把旧歌装到新歌上。
             */
            if (player.baseUrl() == url && shouldSwapVocalTrack(player.currentUrl(), url)) {
                /*
                 * ★ 从**分离轨**切回原曲时，手上那条原曲地址可能已经过期：先让 Web 侧要一条
                 * 新的，别把一条放不出来的地址塞给播放器。
                 *
                 * 用户报的是「分离缓存生成完之后切回全部，播放器不会重新去拉原曲音频，
                 * 本地又没有缓存，于是放不出来」。根因就在这里：分离跑了几十秒到几分钟，
                 * 期间手上那条签名直链可能已经过期；而本地没有原曲的媒体缓存副本，
                 * swapSource 之后就是一个读不出来的源 —— 界面显示「全部」，却没有声音。
                 *
                 * 只在「此刻确实装在分离轨上」才查这件事：已经在放原曲时拨开关（比如开着
                 * 伴奏模式又点了一次全部）地址还是同一条，没必要为了它白要一次流。
                 *
                 * 判据见 [looksSigned] / [sourceMayBeStale]：带签名的一律要新的（重新要一次
                 * 只是一个请求），没签名的按装了多久算。请求交给 Web 侧（omni 认平台），
                 * 拿到新地址后由它正常装源；这里**不**先用旧地址 swapSource，否则会先响一下
                 * 断流再跳回来。
                 */
                if (player.isOnInstrumental()
                    && sourceMayBeStale(preparedAtMs, System.currentTimeMillis(), looksSigned(url))
                ) {
                    requestFreshSource?.invoke(songKey, "switched back to the original")
                    /*
                     * 已经在分离轨上、又准备重新装源：换回原曲这一步交给 Web 侧那次装源做。
                     * 但状态要归位，否则界面还挂着「伴奏 / 人声」的进度。
                     */
                    if (!prebuilding) {
                        state = STATE_IDLE
                        percent = 0
                        activeKey = null
                        notify?.invoke(state, percent)
                    }
                    return
                }
                player.swapSource(url, instrumental = false)
            }
            // 预生成那趟还在跑：状态留着，别让下一句「这首歌没备好」的判断再发起第二趟。
            if (!prebuilding) {
                state = STATE_IDLE
                percent = 0
                activeKey = null
                notify?.invoke(state, percent)
            }
            return
        }
        val key = InstrumentalStore.keyFor(url, songKey)
        // 先比再赋值：写成 activeKey = key 再判断会永远成立，把上一首的任务也当成这首。
        if (state == STATE_BUILDING && activeKey == key) {
            switchOnDone = true
            return
        }
        activeKey = key
        // 四轨齐了就直接读缓存：清唱 / 伴奏 / 全部都由 StemMixProcessor 按模式混音，
        // 这里不再换源，只把状态亮成 ready。
        if (InstrumentalStore.allStemsReady(context, key)) {
            percent = 100
            state = STATE_READY
            notify?.invoke(state, percent)
            return
        }
        startBuild(context, player, url, key, songKey, wantSwitch = true)
    }

    /**
     * 提前分析：把这首歌的两轨伴奏都备好，**不换源**。
     *
     * 这是「下次拨开关秒开」的关键 —— 用户还在听原曲时后台就把活干完了。
     * 与 [reconcile] 共用同一条 worker 与 generation：正在为拨开关跑的任务
     * 本来就会同时产出两轨，没必要再开一遍；反过来，预生成跑到一半用户拨了开关，
     * generation 会让旧任务作废、新任务接手（同一首歌，进度从头开始但只跑一遍模型）。
     */
    fun prebuild(context: Context, url: String?, songKey: String?) {
        if (url.isNullOrBlank()) return
        val key = InstrumentalStore.keyFor(url, songKey)
        if (state == STATE_BUILDING) return
        // 四轨是空间声场的数据源，只检查四轨；老版本只有两轨派生文件的缓存会在这里被补全。
        if (InstrumentalStore.allStemsReady(context, key)) return
        startBuild(context, null, url, key, songKey, wantSwitch = false)
    }

    /** 换歌时调用：旧任务作废。 */
    fun cancel() {
        generation.incrementAndGet()
        switchOnDone = false
        if (state == STATE_BUILDING) {
            state = STATE_IDLE
            percent = 0
        }
    }

    /** 退后台：作废在跑的拆分，让 worker 尽快退出并释放整块 PCM。回前台由 JS 重新排队。 */
    fun pauseForBackground() {
        cancel()
        notify?.invoke(state, percent)
    }

    private fun startBuild(
        context: Context,
        player: FoliaNativePlayer?,
        url: String,
        key: String,
        songKey: String?,
        wantSwitch: Boolean,
    ) {
        /*
         * 先比再赋值：同一首歌正在生成时直接返回，**不要**动 switchOnDone。
         * 原来先写 switchOnDone = wantSwitch，prebuild(false) 撞上「用户拨开关发起的」
         * 那一趟时，会把它的换源意图悄悄改成不换 —— 分离跑完了却不切轨。
         */
        if (state == STATE_BUILDING && activeKey == key) return
        switchOnDone = wantSwitch
        val token = generation.incrementAndGet()
        state = STATE_BUILDING
        percent = 0
        activeKey = key
        notify?.invoke(state, percent)
        val appContext = context.applicationContext
        worker.execute {
            val tracks = try {
                InstrumentalBuilder.build(
                    appContext,
                    url,
                    key,
                    onProgress = { value ->
                        if (token == generation.get()) {
                            percent = value
                            notify?.invoke(state, percent)
                        }
                    },
                    cancelled = { token != generation.get() },
                    /*
                     * 用户拨着开关等结果的那一趟（reconcile）算 eager：播放中的
                     * 让路比例降一档，尽快出活。预生成那趟（prebuild）保持默认，
                     * 时间片尽量还给正在放的歌 —— 不然就是「负载太大，卡到
                     * 歌词对不上曲子」。
                     */
                    eager = wantSwitch,
                    // 后台慢而缓：前后台都跑，但后台每个块之间让出 CPU，避免被强杀。
                    background = { isAppInBackground() },
                )
            } catch (error: Throwable) {
                Log.w(TAG, "生成伴奏异常", error)
                null
            }
            if (token != generation.get()) return@execute
            if (tracks == null) {
                state = STATE_FAILED
                percent = 0
                /*
                 * 失败时把这个键下的成品一并删掉（#408）。
                 *
                 * 「点了分离，放的却是别的」有一半是这么来的：同一个键上留着上一次的成功结果，
                 * 这一次分离失败 → 界面报失败，但缓存里那份旧音频还在，下一次 reconcile
                 * 直接命中它、装进播放器。删掉之后，下一次要么重新分离成功、要么老实报失败。
                 *
                 * 键里已经带了音频身份（见 InstrumentalStore.keyFor），所以正常不会混到别的歌；
                 * 这里清的是「同一身份下上一次留下的残余」。
                 */
                InstrumentalStore.drop(context, key)
                /*
                 * ★ 失败就得把「要分离」的意图退回去，不能停在 vocal / instrumental 上。
                 *
                 * 以前这里只报一条 failed：界面照样写着「人声」，播放器却还装着原曲
                 * （currentTrack 一直是 original）。用户看到的正是「切了分离放的还是
                 * 原曲 / 上一首」，而且下次 reconcile 还会拿着这个空意图再并一次。
                 * 生成不出来是「这条路走不通」，不是「用户还想要它」—— 退回全部，
                 * 界面与音源才是一致的。
                 */
                if (switchOnDone && NativeEqualizerState.activeMode() != null) {
                    NativeEqualizerState.setVocalTrackMode(
                        FoliaSettingsStore.get(context), null,
                    )
                }
                notify?.invoke(state, percent)
                return@execute
            }
            state = STATE_READY
            percent = 100
            activeKey = key
            // 刚写的四轨 mtime 最新，trim 不会动它们；旧的两轨派生文件自然被 LRU 清掉。
            InstrumentalStore.trim(appContext)
            notify?.invoke(state, percent)
            /*
             * 「用户拨着开关在等这一趟」的意图只在本行读取一次：置回 false 之前
             * 先截下来传给回调 —— 上面那行再晚也不能让预拆结果接管正在播的歌。
             */
            val userRequested = switchOnDone
            switchOnDone = false
            /*
             * 四轨就绪：发布给音频线程（StemMixState）。清唱 / 伴奏 / 全部现在都走
             * 四轨混音，不换源 —— 也就不存在「拆完把上一首的派生文件换到下一首」。
             * 身份由 generation 兜底：能走到这里说明生成期间没有换过歌。
             * 是否真的接管由插件按 userInitiated 决定（预拆完成不接管）。
             */
            onStemsReady?.invoke(url, songKey, userRequested)
        }
    }

    fun sweep(context: Context) {
        InstrumentalStore.sweep(context)
        InstrumentalStore.trim(context)
    }

    /**
     * 「删除人声分离缓存」：作废在跑的生成、把状态归零、删掉两轨文件、重算用量。
     *
     * 必须先 cancel()：不清掉 generation，正在跑的那趟几十秒后会把刚删掉的
     * 文件重新写回来，界面上就是「删了又自己长出来」。
     */
    fun clear(context: Context) {
        cancel()
        state = STATE_IDLE
        percent = 0
        activeKey = null
        switchOnDone = false
        InstrumentalStore.clearAll(context)
        notify?.invoke(state, percent)
    }

    const val STATE_IDLE = "idle"
    const val STATE_BUILDING = "building"
    const val STATE_READY = "ready"
    const val STATE_FAILED = "failed"
}
