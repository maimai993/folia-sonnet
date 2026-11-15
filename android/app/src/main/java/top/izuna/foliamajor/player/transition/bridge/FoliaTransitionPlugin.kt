package top.izuna.foliamajor.player.transition.bridge

import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import top.izuna.foliamajor.player.FoliaNativePlayerPlugin
import top.izuna.foliamajor.player.transition.EffectCatalog
import top.izuna.foliamajor.player.transition.TransitionSettings
import top.izuna.foliamajor.player.transition.engine.CuePhase
import top.izuna.foliamajor.player.transition.engine.TransitionCue

// android/app/src/main/java/top/izuna/foliamajor/player/transition/bridge/FoliaTransitionPlugin.kt
// Web UI 与原生过渡内核之间唯一的桥。事件名与 src/services/nativeTransitionClient.ts 一一对应，
// 改一处两边都要改。
//
// 「保留 UI 只换内核」在这里落地：设置页 / cue 动画 / Remote 快照仍然是原来的组件，
// 它们订阅 foliaTransitionCue；但规划、分析、执行全部在原生侧，WebView 不再渲染
// 两个 <audio>、不再跑 OfflineAudioContext、不再挂 Web Audio 节点链。

@CapacitorPlugin(name = "FoliaTransition")
class FoliaTransitionPlugin : Plugin() {

    companion object {
        private const val EVENT_CUE = "foliaTransitionCue"
        private val MAIN = Handler(Looper.getMainLooper())

        @Volatile
        private var instance: FoliaTransitionPlugin? = null

        /** 供服务 / 锁屏等不经过 WebView 的路径直接触发交接。 */
        @JvmStatic
        fun executeHandover(url: String, mediaId: String?): Boolean =
            instance?.let { plugin ->
                TransitionRuntime.engine()?.start(url, mediaId) ?: false
            } ?: false

        /** 播放链被外部打断时，由 FoliaNativePlayerPlugin 调用。 */
        @JvmStatic
        fun interrupt(reason: String) {
            TransitionRuntime.interrupt(reason)
        }

        /**
         * 换歌那一瞬间的接管判据。返回 true = 已交给过渡引擎，调用方**不要**再调
         * `player.prepare` —— 引擎会在两台播放器之间跑完整效果链（接法、曲线、DSP）。
         *
         * 返回 false 时一切照旧：没开交叉淡化、当前没在出声、引擎没挂上，都走普通装源。
         * 全部判据都是同步的、只读 volatile，所以可以从桥线程直接问。
         */
        @JvmStatic
        fun tryTakeover(
            context: android.content.Context,
            url: String,
            mediaId: String?,
        ): Boolean {
            val engine = TransitionRuntime.engine() ?: return false
            val deck = TransitionRuntime.deckControl() ?: return false
            if (!TransitionRuntime.settings.enabled) return false
            if (!deck.canHandover()) return false
            // 计划先算好再交接：引擎的 arm 与 start 都投递到播放器线程，FIFO 保证顺序。
            runCatching { TransitionRuntime.plan(context, null, mediaId, null, 0) }
            return engine.start(url, mediaId)
        }
    }

    private var cueListener: ((TransitionCue) -> Unit)? = null

    override fun load() {
        instance = this
        TransitionRuntime.init(getContext())
        TransitionRuntime.attach(NativeDeckControl { FoliaNativePlayerPlugin.transitionHost() })
        val listener: (TransitionCue) -> Unit = { cue ->
            // notifyListeners 的监听器表不是为并发写的（Plugin.eventListeners 是普通 HashMap），
            // 与 FoliaNativePlayerPlugin 同一条纪律：回主线程再广播。
            MAIN.post {
                runCatching { notifyListeners(EVENT_CUE, JSObject.fromJSONObject(cue.toJson())) }
            }
        }
        cueListener = listener
        TransitionRuntime.onCue(listener)
    }

    override fun handleOnDestroy() {
        cueListener?.let { TransitionRuntime.offCue(it) }
        cueListener = null
        TransitionRuntime.detach()
        if (instance === this) instance = null
        super.handleOnDestroy()
    }

    /** 能力清单 + 全部可用效果，供设置页渲染选项。 */
    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        call.resolve(JSObject.fromJSONObject(TransitionRuntime.capabilitiesJson(getContext())))
    }

    @PluginMethod
    fun listEffects(call: PluginCall) {
        val result = JSObject()
        val items = JSArray()
        EffectCatalog.ALL.forEach { spec ->
            items.put(JSObject().apply {
                put("id", spec.id.wire)
                put("label", spec.label)
                put("summary", spec.summary)
                put("family", spec.family.name.lowercase())
                put("needsEnhancer", spec.needsEnhancer)
                put("needsBeatGrid", spec.needsBeatGrid)
                put("minOverlapMs", spec.minOverlapMs)
                put("maxOverlapMs", spec.maxOverlapMs)
            })
        }
        result.put("effects", items)
        call.resolve(result)
    }

    /**
     * 设置写入。键名与 Web 侧保持一致；老键（crossfadeEnabled 等）继续复用，
     * 不另起一套默认值（见 TransitionSettings 的文件头说明）。
     */
    @PluginMethod
    fun setSettings(call: PluginCall) {
        val values = HashMap<String, Any?>()
        fun copy(key: String, jsKey: String = key) {
            if (call.data.has(jsKey)) values[key] = call.data.opt(jsKey)
        }
        copy(TransitionSettings.KEY_ENABLED, "crossfadeEnabled")
        copy(TransitionSettings.KEY_CROSSFADE_MS, "crossfadeMs")
        copy(TransitionSettings.KEY_CROSSFADE_CURVE, "crossfadeCurve")
        copy(TransitionSettings.KEY_MODE, "transitionMode")
        copy(TransitionSettings.KEY_EFFECT, "transitionEffect")
        copy(TransitionSettings.KEY_MAX_MS, "transitionMaxMs")
        copy(TransitionSettings.KEY_PERFORMANCE, "transitionPerformance")
        copy(TransitionSettings.KEY_INTENSITY, "transitionIntensity")
        copy(TransitionSettings.KEY_ENHANCER, "transitionEnhancer")
        copy(TransitionSettings.KEY_CURVE, "transitionCurve")
        TransitionRuntime.updateSettings(getContext(), values)
        call.resolve(JSObject.fromJSONObject(TransitionRuntime.settings.toJson()))
    }

    /** 预取阶段：后台解码首尾 PCM 并缓存。不阻塞桥线程。 */
    @PluginMethod
    fun analyse(call: PluginCall) {
        val key = call.getString("key") ?: run { call.reject("缺少 key"); return }
        val url = call.getString("url") ?: run { call.reject("缺少 url"); return }
        val durationMs = call.getLong("durationMs") ?: 0L
        val headers = mutableMapOf<String, String>()
        call.data.optJSONObject("headers")?.let { o ->
            o.keys().forEachRemaining { k -> headers[k] = o.optString(k) }
        }
        TransitionRuntime.analyse(key, url, durationMs, headers) { profile ->
            MAIN.post {
                val result = JSObject()
                result.put("ok", profile != null)
                result.put("profile", if (profile != null) JSObject.fromJSONObject(profile.toJson()) else JSONObject.NULL)
                call.resolve(result)
            }
        }
    }

    /** 换歌前：算计划并 arm。返回 Web 侧原 TransitionPlan 的同名字段，UI 不用改数据结构。 */
    @PluginMethod
    fun plan(call: PluginCall) {
        val fromKey = call.getString("fromKey")
        val toKey = call.getString("toKey")
        val bpmLive = call.getDouble("bpmLive")?.toFloat()
        val lyricLines = call.getInt("fromLyricLines") ?: 0
        val result = TransitionRuntime.plan(getContext(), fromKey, toKey, bpmLive, lyricLines)
        call.resolve(JSObject.fromJSONObject(result.toJson()))
    }

    /** 立即执行交接。url / mediaId 由播放桥给出。 */
    @PluginMethod
    fun execute(call: PluginCall) {
        val url = call.getString("url") ?: run { call.reject("缺少 url"); return }
        val mediaId = call.getString("mediaId")
        val accepted = TransitionRuntime.engine()?.start(url, mediaId) ?: false
        val result = JSObject()
        result.put("accepted", accepted)
        result.put("style", TransitionRuntime.lastPlan?.style?.wire ?: "plainBlend")
        call.resolve(result)
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        TransitionRuntime.engine()?.cancel(call.getString("reason") ?: "Web 侧取消")
        call.resolve()
    }

    @PluginMethod
    fun interrupt(call: PluginCall) {
        TransitionRuntime.interrupt(call.getString("reason") ?: "播放链被打断")
        call.resolve()
    }

    /** 设置页预览：带 preview 标记，动画 / Remote 用 shouldDrawCue 拒掉它。 */
    @PluginMethod
    fun preview(call: PluginCall) {
        val plan = TransitionRuntime.plan(
            getContext(),
            call.getString("fromKey"),
            call.getString("toKey"),
            call.getDouble("bpmLive")?.toFloat(),
            call.getInt("fromLyricLines") ?: 0,
        )
        val previewCue = TransitionCue(
            cueId = "preview-${plan.cueId}",
            phase = CuePhase.PREVIEW,
            style = plan.style.wire,
            planJson = plan.toJson(),
            overlapMs = plan.overlapMs,
            reason = plan.reason,
            preview = true,
        )
        TransitionRuntime.publishCue(previewCue)
        call.resolve(JSObject.fromJSONObject(plan.toJson()))
    }

    @PluginMethod
    fun getSnapshot(call: PluginCall) {
        val engine = TransitionRuntime.engine()
        call.resolve(JSObject().apply {
            put("state", engine?.state?.wire ?: "idle")
            put("progress", (engine?.progressNow() ?: 0f).toDouble())
            put("plan", if (TransitionRuntime.lastPlan != null)
                JSObject.fromJSONObject(TransitionRuntime.lastPlan!!.toJson()) else JSONObject.NULL)
            put("settings", JSObject.fromJSONObject(TransitionRuntime.settings.toJson()))
        })
    }
}
