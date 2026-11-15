package top.izuna.foliamajor.player.transition.bridge

import android.content.Context
import org.json.JSONObject
import top.izuna.foliamajor.player.transition.TrackProfile
import top.izuna.foliamajor.player.transition.TransitionPlan
import top.izuna.foliamajor.player.transition.TransitionSettings
import top.izuna.foliamajor.player.transition.analysis.EnhancerPack
import top.izuna.foliamajor.player.transition.analysis.OptionalModelEnhancer
import top.izuna.foliamajor.player.transition.analysis.PcmWindowExtractor
import top.izuna.foliamajor.player.transition.analysis.ProfileCache
import top.izuna.foliamajor.player.transition.analysis.TrackAnalyser
import top.izuna.foliamajor.player.transition.engine.TransitionCue
import top.izuna.foliamajor.player.transition.engine.TransitionEngine
import top.izuna.foliamajor.player.transition.planning.Capabilities
import top.izuna.foliamajor.player.transition.planning.ChoiceContext
import top.izuna.foliamajor.player.transition.planning.TransitionStrategy
import top.izuna.foliamajor.settings.FoliaSettingsStore
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

// android/app/src/main/java/top/izuna/foliamajor/player/transition/bridge/TransitionRuntime.kt
// 进程内单例：把「分析 / 规划 / 执行 / 桥接」四层粘起来。
//
// 为什么需要它：Capacitor 插件实例可能销毁重建，FoliaNativePlayer 也可能被系统控件
// 先拉起来，两边都不适合持有对方。用单例 + attach/detach 让任一侧先起来都能跑，
// 与 FoliaNativePlayerPlugin.mediaSnapshot() 那个静态引用的思路一致。

object TransitionRuntime {

    @Volatile private var deck: DeckControl? = null
    @Volatile private var engineRef: TransitionEngine? = null
    @Volatile private var cacheRef: ProfileCache? = null
    @Volatile private var analyserRef: TrackAnalyser? = null

    @Volatile var settings: TransitionSettings = TransitionSettings()
        private set
    @Volatile var fromProfile: TrackProfile? = null
    @Volatile var toProfile: TrackProfile? = null
    @Volatile var lastPlan: TransitionPlan? = null
        private set

    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "folia-transition-analysis").apply { isDaemon = true }
    }
    private val cueListeners = CopyOnWriteArrayList<(TransitionCue) -> Unit>()

    @Synchronized
    fun init(context: Context) {
        if (cacheRef == null) {
            cacheRef = ProfileCache(context.applicationContext)
            analyserRef = TrackAnalyser(PcmWindowExtractor(context.applicationContext))
        }
        settings = TransitionSettings.read(FoliaSettingsStore.get(context.applicationContext))
    }

    @Synchronized
    fun attach(deckControl: DeckControl) {
        deck = deckControl
        engineRef = TransitionEngine(deckControl)
    }

    /**
     * 插件加载顺序不保证：FoliaTransitionPlugin 可能先于 FoliaNativePlayerPlugin 起来。
     * 播放器就绪后调一次，若引擎还没挂上就在这里补挂（已挂上则什么都不做）。
     */
    @Synchronized
    fun attachIfNeeded(hostProvider: () -> TransitionDeckHost?) {
        if (engineRef != null) return
        attach(NativeDeckControl(hostProvider))
    }

    @Synchronized
    fun detach() {
        engineRef?.cancel("播放器已销毁")
        engineRef = null
        deck = null
    }

    fun engine(): TransitionEngine? = engineRef
    fun cache(): ProfileCache? = cacheRef
    fun analyser(): TrackAnalyser? = analyserRef

    /** 给「换歌那一瞬间」用的同步判据：能不能交接、有没有引擎。 */
    fun deckControl(): DeckControl? = deck
    fun onCue(listener: (TransitionCue) -> Unit) {
        cueListeners.add(listener)
    }

    fun offCue(listener: (TransitionCue) -> Unit) {
        cueListeners.remove(listener)
    }

    fun publishCue(cue: TransitionCue) {
        cueListeners.forEach { listener ->
            runCatching { listener(cue) }
        }
    }

    /** 供诊断面板与规划层使用：能力分级对齐 Web 侧 README §7。 */
    fun capabilities(context: Context): Capabilities {
        val raw = OptionalModelEnhancer.capabilities(context)
        return Capabilities(
            beatGrid = true,
            dspChain = true,
            enhancer = settings.enhancerEnabled && (raw["stems"] as? Boolean ?: false),
        )
    }

    fun capabilitiesJson(context: Context): JSONObject {
        val raw = OptionalModelEnhancer.capabilities(context)
        return JSONObject().apply {
            raw.forEach { (k, v) -> put(k, v) }
            put("dspChain", true)
            put("beatGrid", true)
            put("effects", org.json.JSONArray(EffectIds.all()))
            put("mode", settings.mode.wire)
            put("enabled", settings.enabled)
        }
    }

    /** 注入可选的增强包（按需下载完成后）。 */
    fun bindEnhancer(pack: EnhancerPack?) {
        OptionalModelEnhancer.bind(pack)
    }

    /**
     * 预取阶段调用：在后台线程解码首尾 PCM、算档案、落盘缓存。
     * 绝不占播放器线程，也不占 WebView 主线程。
     */
    fun analyse(
        key: String,
        url: String,
        durationMs: Long,
        headers: Map<String, String>? = null,
        onDone: ((TrackProfile?) -> Unit)? = null,
    ) {
        worker.execute {
            val cache = cacheRef
            val cached = cache?.get(key)
            if (cached != null) {
                onDone?.invoke(cached)
                return@execute
            }
            val profile = analyserRef?.analyse(
                key = key,
                url = url,
                durationMs = durationMs,
                headers = headers,
                enhancer = OptionalModelEnhancer.current(),
            )
            if (profile != null) cache?.put(profile)
            onDone?.invoke(profile)
        }
    }

    /**
     * 换歌前算一份计划并 arm 引擎。Web 侧只需要调这一个方法，
     * 不再自己跑任何规划器 —— 这就是「保留 UI 只换内核」的接缝。
     */
    fun plan(
        context: Context,
        fromKey: String?,
        toKey: String?,
        bpmLive: Float? = null,
        fromLyricLines: Int = 0,
    ): TransitionPlan {
        val cache = cacheRef
        val from = fromKey?.let { cache?.get(it) }
        val to = toKey?.let { cache?.get(it) }
        fromProfile = from
        toProfile = to
        val ctx = ChoiceContext(
            from = from,
            to = to,
            bpmLive = bpmLive,
            fromLyricLines = fromLyricLines,
            settings = settings,
            capabilities = capabilities(context),
        )
        val result = TransitionStrategy.plan(ctx)
        lastPlan = result
        engineRef?.arm(result, from, to)
        return result
    }

    /** 设置写入：Web 侧 setSettings 走这里，同时刷新单例里的缓存。 */
    fun updateSettings(context: Context, values: Map<String, Any?>) {
        val store = FoliaSettingsStore.get(context.applicationContext)
        store.putAll(values)
        settings = TransitionSettings.read(store)
    }

    /** 播放链被外部打断（seek / pause / 手动切歌 / 换源）。 */
    fun interrupt(reason: String) {
        engineRef?.onPlaybackInterrupted(reason)
    }

    private object EffectIds {
        fun all(): List<String> = top.izuna.foliamajor.player.transition.EffectCatalog.wireIds()
    }
}
