package top.izuna.foliamajor.player.dsp

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import top.izuna.foliamajor.settings.FoliaSettingsStore

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

    /** 音频线程用的只读快照。 */
    fun snapshot(): EqSettings = current

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

    /** 落盘：整份设置一个键，一次提交，不留半新半旧。 */
    fun persist(store: FoliaSettingsStore, settings: EqSettings) {
        try {
            store.putAll(mapOf(PREF_PAYLOAD to settings.toJson().toString()))
        } catch (error: Throwable) {
            Log.w(TAG, "保存调音台设置失败", error)
        }
    }
}
