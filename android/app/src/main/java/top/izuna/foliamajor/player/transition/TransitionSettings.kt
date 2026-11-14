package top.izuna.foliamajor.player.transition

import org.json.JSONObject
import top.izuna.foliamajor.settings.FoliaSettingsStore

// android/app/src/main/java/top/izuna/foliamajor/player/transition/TransitionSettings.kt
// 设置项：默认值只在这里登记一份（沿用 FoliaSettingsStore 的纪律 —— 两边各写一份默认值
// 正是「改了没生效」的常见来源）。
//
// 键名与 Web 侧 useSettingsUiStore / useAudioSettingsStore 保持兼容：
// 已发布的 crossfadeEnabled / crossfadeMs / crossfadeCurve / playbackFade 不改名，
// 新增的过渡设置用 transition.* 前缀。

enum class TransitionMode(val wire: String) {
    /** 固定长度交叉淡化：用户设上限，其余不看。 */
    CROSSFADE("crossfade"),
    /** 由测量证据决定「要不要、何时、怎么接、接多久」。 */
    AUTOMIX("automix"),
    ;

    companion object {
        fun fromWire(value: String?): TransitionMode =
            values().firstOrNull { it.wire == value } ?: AUTOMIX
    }
}

data class TransitionSettings(
    val enabled: Boolean = true,
    val mode: TransitionMode = TransitionMode.AUTOMIX,
    /** 用户手动指定的效果；null = 由 StyleChooser 自动挑。 */
    val effectOverride: EffectId? = null,
    val crossfadeMaxMs: Int = 8_000,
    /** 表现模式：在 automix 的交接点前加一段 build-up 手势。 */
    val performance: Boolean = false,
    /** 效果强度 0.25 / 0.5 / 0.75 / 1。 */
    val intensity: Float = 0.75f,
    /** 是否允许使用按需下载的增强包（未下载时自动降级）。 */
    val enhancerEnabled: Boolean = true,
    /** 过渡曲线偏好；自动模式下由效果自身的 defaultCurve 覆盖。 */
    val curveOverride: CurveId? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("enabled", enabled)
        put("mode", mode.wire)
        put("effectOverride", effectOverride?.wire ?: JSONObject.NULL)
        put("crossfadeMaxMs", crossfadeMaxMs)
        put("performance", performance)
        put("intensity", intensity.toDouble())
        put("enhancerEnabled", enhancerEnabled)
        put("curveOverride", curveOverride?.wire ?: JSONObject.NULL)
    }

    companion object {

        // 与 FoliaSettingsStore.DEFAULTS 里已有的键保持同名同值。
        const val KEY_ENABLED = "crossfadeEnabled"
        const val KEY_CROSSFADE_MS = "crossfadeMs"
        const val KEY_CROSSFADE_CURVE = "crossfadeCurve"
        const val KEY_PLAYBACK_FADE = "playbackFade"

        const val KEY_MODE = "transition.mode"
        const val KEY_EFFECT = "transition.effect"
        const val KEY_MAX_MS = "transition.maxMs"
        const val KEY_PERFORMANCE = "transition.performance"
        const val KEY_INTENSITY = "transition.intensity"
        const val KEY_ENHANCER = "transition.enhancer"
        const val KEY_CURVE = "transition.curve"

        /**
         * 从原生存储读一份设置。老用户只有 crossfadeEnabled / crossfadeMs 这几个键，
         * 读不到新键时全部落默认值 —— 不会把「曾经开着混合」的人突然切成别的行为。
         */
        fun read(store: FoliaSettingsStore): TransitionSettings {
            val enabled = store.getBoolean(KEY_ENABLED, false)
            val legacyMs = store.getInt(KEY_CROSSFADE_MS, 0)
            val mode = TransitionMode.fromWire(store.getString(KEY_MODE))
            val effect = EffectId.fromWire(store.getString(KEY_EFFECT))
            val curve = store.getString(KEY_CURVE)?.let { CurveId.fromWire(it) }
            val maxMs = store.getInt(KEY_MAX_MS, if (legacyMs > 0) legacyMs else 8_000)
            return TransitionSettings(
                enabled = enabled,
                mode = if (store.getString(KEY_MODE).isNullOrEmpty()) {
                    // 没有新键 = 老用户：开着交叉淡化就按 crossfade 走，避免升级后行为突变。
                    if (enabled && legacyMs > 0) TransitionMode.CROSSFADE else TransitionMode.AUTOMIX
                } else mode,
                effectOverride = effect,
                crossfadeMaxMs = maxMs.coerceIn(500, 24_000),
                performance = store.getBoolean(KEY_PERFORMANCE, false),
                intensity = store.getDouble(KEY_INTENSITY, 0.75).toFloat().coerceIn(0.25f, 1f),
                enhancerEnabled = store.getBoolean(KEY_ENHANCER, true),
                curveOverride = curve,
            )
        }
    }
}
