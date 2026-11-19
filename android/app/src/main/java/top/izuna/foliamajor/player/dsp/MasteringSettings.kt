package top.izuna.foliamajor.player.dsp

// 母带与工作室各级参数、中性值与旁通判定。
/** 损失补偿：链末慢速 AGC，把调音损失的响度补回来（本方案核心）。 */
class CompensationSettings(
    val enabled: Boolean = false,
    val amount: Float = 0.7f,
    val maxGainDb: Float = 6f,
    val responseMs: Float = 300f,
) {
    companion object { val NEUTRAL = CompensationSettings() }
}

/** 噪声门：低于门限的信号按 reductionDb 衰减。 */
class NoiseGateSettings(
    val enabled: Boolean = false,
    val thresholdDb: Float = -50f,
    val attackMs: Float = 5f,
    val releaseMs: Float = 120f,
    val reductionDb: Float = -24f,
) {
    companion object { val NEUTRAL = NoiseGateSettings() }
}

/** 去齿音：对检测频段做动态衰减。 */
class DeEsserSettings(
    val enabled: Boolean = false,
    val frequencyHz: Float = 6500f,
    val thresholdDb: Float = -24f,
    val ratio: Float = 4f,
) {
    companion object { val NEUTRAL = DeEsserSettings() }
}

/** 去喷麦：对低频气流冲击做动态衰减。 */
class DePlosiveSettings(
    val enabled: Boolean = false,
    val reductionDb: Float = -12f,
) {
    companion object { val NEUTRAL = DePlosiveSettings() }
}

/** 低频增强：单段低频搁架提升。 */
class BassBoostSettings(
    val enabled: Boolean = false,
    val gainDb: Float = 4f,
    val frequencyHz: Float = 90f,
) {
    companion object { val NEUTRAL = BassBoostSettings() }
}

/** 谐波激励：对高频做轻微饱和生成泛音。 */
class ExciterSettings(
    val enabled: Boolean = false,
    val amount: Float = 0.4f,
    val mix: Float = 0.35f,
) {
    companion object { val NEUTRAL = ExciterSettings() }
}

/** 瞬态塑形：-1 柔化 ~ 1 增强。 */
class TransientSettings(
    val enabled: Boolean = false,
    val amount: Float = 0.5f,
) {
    companion object { val NEUTRAL = TransientSettings() }
}

/** 音色塑造：空气 / 临场 / 温暖 / 清晰四旋钮（dB）。 */
class ToneSettings(
    val air: Float = 0f,
    val presence: Float = 0f,
    val warmth: Float = 0f,
    val clarity: Float = 0f,
) {
    companion object { val NEUTRAL = ToneSettings() }
}

/** 等响度：小音量时补高低两端。 */
class LoudnessSettings(
    val enabled: Boolean = false,
    val amount: Float = 0.5f,
) {
    companion object { val NEUTRAL = LoudnessSettings() }
}

/** 声道平衡：-1 全左 ~ 1 全右。 */
class BalanceSettings(
    val enabled: Boolean = false,
    val value: Float = 0f,
) {
    companion object { val NEUTRAL = BalanceSettings() }
}

// —————————————————————————————————————————————————————————————————————————————
// 工作室（Studio）：四大方向 12 项新功能，独立成块，位于母带之后、限幅之前。
// 每一项仍是"一个开关 + 一根滑杆"，名字专业但用法直觉。
// —————————————————————————————————————————————————————————————————————————————

/** 响度标准化：缓慢调节 RMS 电平。 */
class NormalizeSettings(
    val enabled: Boolean = false,
    /** 旧协议键：目标 RMS，单位 dBFS。 */
    val targetLufs: Float = -14f,
    /** 旧协议键：目标 RMS 再降 1 dB，并不测量或限制真峰值。 */
    val truePeak: Boolean = true,
) {
    companion object { val NEUTRAL = NormalizeSettings() }
}

/** 音频修复：三类常见瑕疵，各自独立开关。 */
class RestoreSettings(
    /** 去咔嗒：瞬间的爆音/断点。 */
    val declick: Boolean = false,
    /** 去嗡声：50/60Hz 工频及其二次谐波。 */
    val hum: Boolean = false,
    /** 降噪：稳态底噪抑制。 */
    val denoise: Boolean = false,
    /** 修复强度 0 ~ 1。 */
    val amount: Float = 0.5f,
) {
    companion object { val NEUTRAL = RestoreSettings() }
    fun anyEnabled() = declick || hum || denoise
}

/** 进阶效果：动态 EQ / M/S 声场 / 展宽 / 人声增强。 */
class AdvancedSettings(
    /** 动态 EQ：频段能量超阈值时压一把，处理"轰头"的浑浊低频。 */
    val dynamicEq: Boolean = false,
    /** 动态 EQ 中心频率 80 ~ 400 Hz。 */
    val dynamicEqFreq: Float = 180f,
    /** 动态 EQ 衰减量 0 ~ 12 dB。 */
    val dynamicEqAmount: Float = 4f,
    /** 人声增强 0 ~ 1：抬 2~4kHz 的人声存在感。 */
    val vocalBoost: Float = 0f,
) {
    companion object { val NEUTRAL = AdvancedSettings() }
    fun isNeutral() = !dynamicEq && vocalBoost < 0.01f
}

/** 智能场景：曲风一键预设 + A/B 对比 + 耳机校准。 */
class SceneSettings(
    /** 曲风预设：flat/pop/rock/jazz/classical/electronic/vocal 之一，决定一组隐式 EQ 微调。 */
    val genre: String = "flat",
    /** A/B 对比：true 时整条调音链旁通，直接听原声。 */
    val compare: Boolean = false,
    /** 耳机校准：flat / airpods / sony / sennheiser 之一，补偿常见耳机频响。 */
    val headphone: String = "flat",
    /** 场景微调强度 0 ~ 1。 */
    val amount: Float = 0.6f,
) {
    companion object { val NEUTRAL = SceneSettings() }
    fun isNeutral() = genre == "flat" && headphone == "flat"
}

/** 工作室块：四大方向 12 项，可缺省。 */
class StudioSettings(
    val normalize: NormalizeSettings = NormalizeSettings.NEUTRAL,
    val restore: RestoreSettings = RestoreSettings.NEUTRAL,
    val advanced: AdvancedSettings = AdvancedSettings.NEUTRAL,
    val scene: SceneSettings = SceneSettings.NEUTRAL,
) {
    companion object { val NEUTRAL = StudioSettings() }
    fun isNeutral() = !normalize.enabled && !restore.anyEnabled()
        && advanced.isNeutral() && scene.isNeutral()
}

/** 十项母带设置的集合。 */
class MasteringSettings(
    val compensation: CompensationSettings = CompensationSettings.NEUTRAL,
    val noiseGate: NoiseGateSettings = NoiseGateSettings.NEUTRAL,
    val deEsser: DeEsserSettings = DeEsserSettings.NEUTRAL,
    val dePlosive: DePlosiveSettings = DePlosiveSettings.NEUTRAL,
    val bassBoost: BassBoostSettings = BassBoostSettings.NEUTRAL,
    val exciter: ExciterSettings = ExciterSettings.NEUTRAL,
    val transient: TransientSettings = TransientSettings.NEUTRAL,
    val tone: ToneSettings = ToneSettings.NEUTRAL,
    val loudness: LoudnessSettings = LoudnessSettings.NEUTRAL,
    val balance: BalanceSettings = BalanceSettings.NEUTRAL,
    /** 工作室块：四大方向 12 项，可缺省，缺席时中性。 */
    val studio: StudioSettings = StudioSettings.NEUTRAL,
) {
    companion object { val NEUTRAL = MasteringSettings() }

    /** 十项全关 / 全中性：此时 MasteringStage 是恒等变换。 */
    fun stageIsNeutral(): Boolean = !compensation.enabled && !noiseGate.enabled && !deEsser.enabled
        && !dePlosive.enabled && !bassBoost.enabled && !exciter.enabled
        && !transient.enabled && !loudness.enabled && !balance.enabled
        && kotlin.math.abs(tone.air) < 0.01f && kotlin.math.abs(tone.presence) < 0.01f
        && kotlin.math.abs(tone.warmth) < 0.01f && kotlin.math.abs(tone.clarity) < 0.01f

    fun isNeutral(): Boolean = stageIsNeutral() && studio.isNeutral()
}
