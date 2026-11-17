package top.izuna.foliamajor.player.dsp

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import top.izuna.foliamajor.settings.FoliaSettingsStore
import java.util.concurrent.Executors

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/NativeEqualizerState.kt
// 原生调音台的**唯一状态**：桥线程写、音频渲染线程读，中间只有一个 volatile 引用。
//
// 为什么不把参数放在播放器里：交叉淡化会同时存在两台 ExoPlayer，播放器还可能被回收重建
// （FoliaNativePlayer.ensurePlayer 的恢复逻辑）。参数跟着播放器走，就会出现「切一首歌 EQ 回到默认」
// 「淡入的那首是新参数、淡出的那首是旧参数」。状态放这里，谁建播放器都读同一份。
//
// 线程纪律：
//   · 写：Capacitor 插件线程（setEqualizer）/ 主线程（load 里 restore）；
//   · 读：playerLooper（EqAudioProcessor 每个块读一次）；
//   · 两边都不加锁 —— 读到一个稍旧的快照最多是「参数晚一拍生效」，不会读到半个数组。
//
// 频谱是反方向的一条线：音频线程发布，桥线程取走。发布时换掉整个数组引用，
// 读的人拿到的一定是完整的一帧（可能旧一帧，但不会是半新半旧的柱子）。

object NativeEqualizerState {

    private const val TAG = "FoliaEQ"

    private const val PREF_VERSION = "eq.version"
    private const val PREF_ENABLED = "eq.enabled"
    private const val PREF_GAINS = "eq.gains"
    private const val PREF_EFFECTS = "eq.effects"

    /** 关闭人声。单独一个键：它不是调音台设置的一部分，但同样要在 WebView 起来之前就能读到。 */
    private const val PREF_VOCAL_CANCEL = "eq.vocalCancel"

    /** 只留人声（清唱）。与上面那个互斥，另存一个键。 */
    private const val PREF_VOCAL_ONLY = "eq.vocalOnly"

    /** 协议 v2 起整份设置存在这里；老键保留，只为「降级回旧版本时还能认」与首次迁移。 */
    private const val PREF_PAYLOAD = "eq.payload"

    @Volatile
    private var current: EqSettings = EqSettings.NEUTRAL

    /** 只在 [apply] 里自增，受 synchronized 保护。 */
    private var seq = 0L

    /** 最近一帧频谱（0..1，对应 -90 dB ~ 0 dB）。 */
    @Volatile
    private var spectrumBands: FloatArray = FloatArray(SPECTRUM_BAND_COUNT)

    /** 界面开着频谱页时才置真：没人看时不在音频线程上跑 FFT。 */
    @Volatile
    var spectrumEnabled: Boolean = false

    /**
     * 关闭人声（中置相消）开着没有。
     *
     * 和 [spectrumEnabled] 一样是桥线程写、音频线程读的单个 volatile：
     * 处理器每帧只看一眼这个值，切换不需要重建音频链，
     * 所以拨开关是即时的，不用重新加载音频。
     */
    @Volatile
    var vocalCancelEnabled: Boolean = false

    /**
     * 只留人声（播分离出来的清唱轨）开着没有。
     *
     * 与 [vocalCancelEnabled] 互斥 —— 同一时刻只能播一轨。互斥在 setter 里做，
     * 不让界面/桥去协调：冷启动时原生自己读回来，也必须保持这个不变量。
     */
    @Volatile
    var vocalOnlyEnabled: Boolean = false

    /**
     * 空间声场正在混音没有。
     *
     * StemMixProcessor 每块更新；VocalCancelProcessor 读它 —— 混音出来的是
     * 「已经按四轨摆好位」的成品，不能再做中置相消，否则会把居中的贝斯/底鼓/人声
     * 一起减掉。
     */
    @Volatile
    var stemMixActive: Boolean = false

    /**
     * 此刻该播哪一轨分离结果；两个开关都关着就是 null。
     *
     * [InstrumentalCoordinator] 只认这个，不再各自判断两个布尔，
     * 免得「两个都开」时一会儿换伴奏一会儿换清唱。
     */
    fun activeMode(): VocalTrackMode? = when {
        vocalCancelEnabled -> VocalTrackMode.INSTRUMENTAL
        vocalOnlyEnabled -> VocalTrackMode.VOCAL
        else -> null
    }

    /**
     * 此刻播的是不是「已经分离好的伴奏」。
     *
     * 是的话中置相消必须让位：伴奏里已经没有人声了，再减一次中置只会把
     * 居中的贝斯、底鼓也一起减掉（那正是用户说的「整首歌变小声」）。
     * 由播放器在换源时置位，音频线程每块读一次。
     */
    @Volatile
    var instrumentalActive: Boolean = false

    /**
     * 改开关并落盘。
     *
     * 落盘是为了「冷启动 / 后台被系统拉起来时也是用户上次的选择」：
     * 这个值以前只存在 Web 的 localStorage，原生侧重启就是默认值，
     * 于是「开关开着、后台那首却带原唱」。用 [FoliaSettingsStore.putAll]
     * （异步落盘）而不是 [FoliaSettingsStore.put]：后者是同步 fsync，
     * 在 Capacitor 桥线程上会把后续调用堵住。
     */
    fun setVocalCancelEnabled(store: FoliaSettingsStore, enabled: Boolean) {
        vocalCancelEnabled = enabled
        if (enabled) vocalOnlyEnabled = false
        try {
            /*
             * 只在「打开」时顺手清掉另一个键。关掉自己时不能写对方为 false ——
             * Web 启动时会对一次表（推一次 vocalCancel=false），那一刻清唱可能正开着，
             * 无条件写 false 会把它从盘上抹掉，下次冷启动就丢了。
             */
            val patch = if (enabled) {
                mapOf(PREF_VOCAL_CANCEL to true, PREF_VOCAL_ONLY to false)
            } else {
                mapOf(PREF_VOCAL_CANCEL to false)
            }
            store.putAll(patch)
        } catch (error: Throwable) {
            // 存不下不影响这次播放：内存里已经是新值了。
            Log.w(TAG, "保存关闭人声开关失败", error)
        }
    }

    /** 只留人声：与 [setVocalCancelEnabled] 互斥，打开它就关掉伴奏模式。 */
    fun setVocalOnlyEnabled(store: FoliaSettingsStore, enabled: Boolean) {
        vocalOnlyEnabled = enabled
        if (enabled) vocalCancelEnabled = false
        try {
            val patch = if (enabled) {
                mapOf(PREF_VOCAL_ONLY to true, PREF_VOCAL_CANCEL to false)
            } else {
                mapOf(PREF_VOCAL_ONLY to false)
            }
            store.putAll(patch)
        } catch (error: Throwable) {
            Log.w(TAG, "保存只留人声开关失败", error)
        }
    }

    /**
     * 三态「全部 / 人声 / 伴奏」的**原子**写入：两个布尔一次落定、一次落盘。
     *
     * 为什么不能用两次 setVocalCancelEnabled / setVocalOnlyEnabled 拼：
     * 每次调用都会触发一次 reconcile，中间那一态（例如「全部」先关伴奏、清唱还开着）
     * 会被当成真的意图去换源，用户听到的是「切全部却先放了人声」；两条命令在
     * Capacitor 桥上还可能乱序，最终停在错轨上。这里一次写完，调用方只 reconcile 一次。
     *
     * 两个键一次 putAll，也不会留下「盘上一个开、一个关」的半新半旧。
     */
    fun setVocalTrackMode(store: FoliaSettingsStore, mode: VocalTrackMode?) {
        vocalCancelEnabled = mode == VocalTrackMode.INSTRUMENTAL
        vocalOnlyEnabled = mode == VocalTrackMode.VOCAL
        try {
            store.putAll(
                mapOf(
                    PREF_VOCAL_CANCEL to vocalCancelEnabled,
                    PREF_VOCAL_ONLY to vocalOnlyEnabled,
                )
            )
        } catch (error: Throwable) {
            // 存不下不影响这次播放：内存里已经是新值了。
            Log.w(TAG, "保存播放音轨模式失败", error)
        }
    }

    /** 音频线程用的只读快照。 */
    fun snapshot(): EqSettings = current

    /** 空间声场开着时，四轨混音接管伴奏/清唱，换源路径不再 swapSource。 */
    fun stemMixerEnabled(): Boolean = current.spatial.enabled

    /**
     * 换一份设置，返回带新 seq 的那一份。
     *
     * seq 是给音频线程判断「要不要重算系数」用的；协议版本（version）不参与这个判断，
     * 否则用户连拖两次滑杆而协议版本没变时，第二次不会生效。
     */
    @Synchronized
    fun apply(next: EqSettings): EqSettings {
        seq += 1
        val stamped = next.withSeq(seq)
        current = stamped
        StemMixState.publishSpatial(stamped.spatial)
        return stamped
    }

    /** 音频线程发布一帧频谱。 */
    fun publishSpectrum(bands: FloatArray) {
        spectrumBands = bands
    }

    /** 桥线程取走最新一帧。 */
    fun spectrum(): FloatArray = spectrumBands

    /**
     * 冷启动恢复：WebView 起来之前（通知栏 / 锁屏直接播）也要按上次的听感出声。
     *
     * 必须在建播放器之前调用，见 FoliaNativePlayerPlugin.load()。
     */
    fun restore(store: FoliaSettingsStore) {
        /*
         * 关闭人声先恢复，且**不走下面那个 try 的 return**：那段是给调音台设置用的，
         * 一旦读到 v2 载荷就直接返回了。这个开关原来是 Web 侧拨一下推一下、
         * 落盘只落在 localStorage —— 冷启动由通知栏 / 锁屏先把播放拉起来时
         * （WebView 还没起来），原生这边永远是默认的「关」，用户明明开着开关，
         * 后台放出来的却是有原唱的版本。
         */
        vocalCancelEnabled = try {
            store.getBoolean(PREF_VOCAL_CANCEL, false)
        } catch (error: Throwable) {
            Log.w(TAG, "恢复关闭人声开关失败，按关闭处理", error)
            false
        }
        vocalOnlyEnabled = try {
            // 老版本可能留下「两个都 true」的脏数据：以伴奏为准，清唱让位。
            store.getBoolean(PREF_VOCAL_ONLY, false) && !vocalCancelEnabled
        } catch (error: Throwable) {
            Log.w(TAG, "恢复只留人声开关失败，按关闭处理", error)
            false
        }
        try {
            val payload = store.getString(PREF_PAYLOAD)
            if (payload != null) {
                apply(EqSettings.fromJson(JSONObject(payload)))
                return
            }
            // 没有 v2 载荷：把 v1 的四项拼成一份 v1 JSON 交给同一个解析器。
            val gains = store.getString(PREF_GAINS)
            val effects = store.getString(PREF_EFFECTS)
            val json = JSONObject().apply {
                put("version", store.getInt(PREF_VERSION, EQ_PROTOCOL_VERSION))
                put("enabled", store.getBoolean(PREF_ENABLED, false))
                if (gains != null) put("gains", JSONArray(gains))
                if (effects != null) put("effects", JSONObject(effects))
            }
            apply(EqSettings.fromJson(json))
        } catch (error: Throwable) {
            // 存坏了就按出厂值走 —— 不能因为一条设置把播放拦住。
            Log.w(TAG, "恢复调音台设置失败，按关闭处理", error)
            apply(EqSettings.NEUTRAL)
        }
    }

    /**
     * 落盘：整份设置一个键，一次提交，不留半新半旧。
     *
     * ⚠️ 曾经这里是同步写入，且由 [apply] 的调用方（Capacitor 桥线程）直接调用。
     * 拖动滑杆时 Web 侧每 40 ms 推一条，每条都同步写一次**整份设置**的 blob：
     * 存储慢的机器上单次 fsync 十几毫秒，几条就排成队，桥线程被堵住，
     * 表现正是「滑杆拉过去了，声音要等一两秒才跟上，再动一下又好了」。
     *
     * 现在拆成两步：内存状态立刻生效（音频线程读到的是同一份），写盘丢给后台线程，
     * 并在 [PERSIST_DEBOUNCE_MS] 窗口内只保留最后一份。拖动的中间值根本不需要落盘。
     */
    fun persist(store: FoliaSettingsStore, settings: EqSettings) {
        synchronized(persistLock) {
            pendingStore = store
            pendingSettings = settings
            if (persistQueued) return
            persistQueued = true
        }
        persistExecutor.execute {
            try {
                // 合并窗口：这段时间里后续的 persist 只覆盖 pending，不再新增任务。
                Thread.sleep(PERSIST_DEBOUNCE_MS)
                val (target, snapshot) = synchronized(persistLock) {
                    persistQueued = false
                    val queuedStore = pendingStore
                    val queuedSettings = pendingSettings
                    pendingStore = null
                    pendingSettings = null
                    queuedStore to queuedSettings
                }
                if (target != null && snapshot != null) {
                    target.putAll(mapOf(PREF_PAYLOAD to snapshot.toJson().toString()))
                }
            } catch (error: Throwable) {
                Log.w(TAG, "保存调音台设置失败", error)
            }
        }
    }

    private const val PERSIST_DEBOUNCE_MS = 600L

    private val persistLock = Any()
    private var persistQueued = false
    private var pendingStore: FoliaSettingsStore? = null
    private var pendingSettings: EqSettings? = null

    /** 单线程、守护、最低优先级：写盘只在设备空闲时蹭一点 IO，不和播放抢。 */
    private val persistExecutor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "folia-eq-persist").apply {
            isDaemon = true
            priority = Thread.MIN_PRIORITY
        }
    }
}
