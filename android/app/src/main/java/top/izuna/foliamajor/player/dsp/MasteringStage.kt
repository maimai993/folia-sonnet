package top.izuna.foliamajor.player.dsp

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tanh

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/MasteringStage.kt
// 母带台：十项「一个滑杆一个效果」的处理，位于混响之后、限幅之前。
//
// 为什么放在这里：母带处理是对「已经混好的整首歌」做最后修饰，必须在混响之后 ——
// 否则噪声门/去齿音会把混响尾巴当成要修的东西；又必须在限幅之前 —— 因为损失补偿
// 要按最终输出电平把响度补回来，补完再由限幅兜住峰值。
//
// 十项处理的顺序（逐样本，各站自己判断要不要开）：
//   ① 噪声门      低于门限的信号按 reductionDb 压下去
//   ② 去喷麦      200 Hz 以下的低频气流冲击，超阈值才压
//   ③ 去齿音      6.5 kHz 附近的「嘶」，超阈值才压
//   ④ 低频增强    低频搁架，给薄声音补量感
//   ⑤ 瞬态塑形    起音沿增强 / 柔化
//   ⑥ 音色塑造    空气 / 临场 / 温暖 / 清晰四个固定滤波器
//   ⑦ 等响度      小音量时补高低两头
//   ⑧ 谐波激励    高频轻微饱和生成泛音
//   ⑨ 声道平衡    左右声道增益
//   ⑩ 损失补偿    慢速 AGC，把调音损失的响度补回来（核心）
//
// 线程：只在音频渲染线程（playerLooper）调用。所有状态在类内、按声道保留，无锁、无分配。
// 包络跟随一律用 one-pole（y += (x - y) * coef），coef 由时间常数换算，和 Web 的
// setTargetAtTime 是同一种平滑。

class MasteringStage {

    // —— 检测 / 分析滤波器（只用来算包络，不改变信号）——
    private val plosiveLow = BiquadFilter()      // 去喷麦：低频带（同时是被压的那一段）
    private val plosiveHigh = BiquadFilter()     // 去喷麦：与低频带互补的高频带
    private val deEsserBand = BiquadFilter()     // 去齿音：高频带
    private val exciterHighpass = BiquadFilter() // 激励：提取高频
    private val exciterLowpass = BiquadFilter()  // 激励：限制激励频带上限

    // —— 处理滤波器（真正改变信号）——
    private val bassShelf = BiquadFilter()
    private val toneAir = BiquadFilter()
    private val tonePresence = BiquadFilter()
    private val toneWarmth = BiquadFilter()
    private val toneClarity = BiquadFilter()
    private val loudLow = BiquadFilter()
    private val loudHigh = BiquadFilter()

    private var sampleRate = 0
    private var channels = 1

    // 包络 / 增益状态（每声道一份，最多 8）
    private val gateEnv = FloatArray(MAX_CHANNELS)
    private val gateGain = FloatArray(MAX_CHANNELS)
    private val plosiveEnv = FloatArray(MAX_CHANNELS)
    private val plosiveDetect = FloatArray(MAX_CHANNELS)   // 低频带慢包络
    private val plosiveGain = FloatArray(MAX_CHANNELS)
    private val deEssEnv = FloatArray(MAX_CHANNELS)
    private val transientEnv = FloatArray(MAX_CHANNELS)
    private val transientPrev = FloatArray(MAX_CHANNELS)
    private val transientGain = FloatArray(MAX_CHANNELS)
    // 损失补偿：输出电平包络（线性 RMS 的平方，慢速）+ 当前补偿增益（线性，做斜坡）
    private var refPower = 0f
    private var compPower = 0f
    private var compGain = 1f

    private var lastMastering: MasteringSettings? = null
    /** 上一块是否整体中性：从中性切到非中性时重置包络，避免第一块被旧状态带偏。 */
    private var wasNeutral = true

    // 缓存的系数（每块开始时由 settings 算一次，循环里不再 pow / exp）
    private var gateAttackCoef = 0f
    private var gateReleaseCoef = 0f
    private var gateThreshold = 0f
    private var gateFloorGain = 1f
    private var plosiveAtkCoef = 0f
    private var plosiveRelCoef = 0f
    private var plosiveFloorGain = 1f
    private var deessAtkCoef = 0f
    private var deessRelCoef = 0f
    private var deessThreshold = 1f
    private var deessSlope = 1f
    private var plosiveFastRelCoef = 0f
    private var plosiveSlowCoef = 0f
    private var transientAtkCoef = 0f
    private var transientSlowAtkCoef = 0f
    private var transientFastRelCoef = 0f
    private var transientGainAtkCoef = 0f
    private var transientRelCoef = 0f
    private var transientAmount = 0f
    private var exciterDrive = 1f
    private var exciterDryGain = 1f
    private var exciterWetGain = 0f
    private var leftGain = 1f
    private var rightGain = 1f
    private var compFollowCoef = 0f
    private var compRampCoef = 0f
    private var compAmount = 0f
    private var compMaxGain = 1f

    fun configure(sampleRate: Int, channels: Int) {
        this.sampleRate = sampleRate
        this.channels = channels.coerceIn(1, MAX_CHANNELS)
        lastMastering = null
        wasNeutral = true
        reset()
    }

    fun reset() {
        deEsserBand.reset()
        exciterHighpass.reset(); exciterLowpass.reset()
        bassShelf.reset(); toneAir.reset(); tonePresence.reset(); toneWarmth.reset()
        toneClarity.reset(); loudLow.reset(); loudHigh.reset()
        gateEnv.fill(0f); gateGain.fill(1f)
        plosiveEnv.fill(0f); plosiveDetect.fill(0f); plosiveGain.fill(1f); plosiveLow.reset(); plosiveHigh.reset()
        deEssEnv.fill(0f)
        transientEnv.fill(0f); transientPrev.fill(0f); transientGain.fill(1f)
        refPower = 0f
        compPower = 0f
        compGain = 1f
    }

    /**
     * 处理一块交错 PCM。settings 引用不变时不重算滤波器系数（拖滑杆每次都会给新对象）。
     */
    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channelsIn: Int,
        settings: MasteringSettings,
    ) {
        if (frames <= 0 || sampleRate <= 0) return
        val ch = channelsIn.coerceIn(1, MAX_CHANNELS)
        channels = ch

        val neutral = settings.stageIsNeutral()
        if (neutral) {
            // 回到中性时把标志翻回来：下一次从「全关」切到「有处理」才能重新清包络。
            wasNeutral = true
            return
        }
        if (wasNeutral) {
            // 从全关切到有处理：清掉包络，第一块从一个干净的状态开始。
            reset()
            wasNeutral = false
        }

        if (settings !== lastMastering) {
            applySettings(settings)
            lastMastering = settings
        }

        val count = frames * ch
        var index = offset

        // 逐样本主循环。各站 disabled 时对应 gain = 1 / 滤波器 active = false，等于直通。
        while (index < offset + count) {
            val channel = index % ch
            var s = buffer[index]

            // ① 噪声门：包络跟随 → 软门增益
            if (settings.noiseGate.enabled) {
                val env = follow(gateEnv[channel], abs(s), if (abs(s) >= gateEnv[channel]) gateAttackCoef else gateReleaseCoef)
                gateEnv[channel] = env
                // 门限以下：增益朝 reductionDb 落；以上：朝 1 抬。用同一组 attack/release 平滑。
                val target = if (env >= gateThreshold) 1f else gateFloorGain
                val g = gateGain[channel] + (target - gateGain[channel]) *
                    (if (target > gateGain[channel]) gateAttackCoef else gateReleaseCoef)
                gateGain[channel] = g
                s *= g
            }

            // ② 去喷麦：按 PLOSIVE_CUTOFF_HZ 用二阶 Linkwitz-Riley（Q = 0.5，随采样率设计）把信号拆成低频带 LP 与
            //    高频带 HP，输出 = g·LP − HP：g = 1 时是全通（幅度精确为 1，只有相位旋转），所以稳定的中频音
            //    既不衰减也不会被增益调制出谐波；g < 1 时只压低频带，频点处的幅度是 (g + r²)/(1 + r²)，
            //    r = f / PLOSIVE_CUTOFF_HZ，与采样率无关。触发条件是「低频带包络突然冲高」：快包络既超过绝对门限，
            //    又比慢包络高出 PLOSIVE_BURST_RATIO 倍；持续的低音（慢包络已跟上）不触发。
            if (settings.dePlosive.enabled) {
                val low = plosiveLow.process(s, channel)
                val high = plosiveHigh.process(s, channel)
                val mag = abs(low)
                val fast = follow(plosiveEnv[channel], mag, if (mag >= plosiveEnv[channel]) plosiveAtkCoef else plosiveFastRelCoef)
                plosiveEnv[channel] = fast
                val slow = follow(plosiveDetect[channel], fast, plosiveSlowCoef)
                plosiveDetect[channel] = slow
                val target = if (fast > PLOSIVE_MIN_LEVEL && fast > slow * PLOSIVE_BURST_RATIO) plosiveFloorGain else 1f
                val g = plosiveGain[channel] + (target - plosiveGain[channel]) *
                    (if (target < plosiveGain[channel]) plosiveAtkCoef else plosiveRelCoef)
                plosiveGain[channel] = g
                s = low * g - high
            }

            // ③ 去齿音：齿音频段的高通包络超阈才压。检测频段跟着 frequencyHz 走。
            if (settings.deEsser.enabled) {
                val hp = deEsserBand.process(s, channel)
                val env = follow(deEssEnv[channel], abs(hp), if (abs(hp) >= deEssEnv[channel]) deessAtkCoef else deessRelCoef)
                deEssEnv[channel] = env
                val g = if (env > deessThreshold) {
                    val overDb = 20f * kotlin.math.log10(env / deessThreshold)
                    dbToLinear(-overDb * (1f - 1f / deessSlope)).coerceIn(0.1f, 1f)
                } else 1f
                s *= g
            }

            // ④ 低频增强
            if (bassShelf.active) s = bassShelf.process(s, channel)

            // ⑤ 瞬态塑形：快/慢两条包络之比（dB）就是「起音有多突出」。快包络 1 ms 起、慢包络 25 ms 起，
            //    两者释放都是 40 ms，所以稳态时比值 ≈ 1；10 ms 的鼓点内两者差 10 dB 以上。
            //    比值超出 TRANSIENT_DEAD_ZONE_DB 的部分（最多 TRANSIENT_RANGE_DB）乘以 amount 就是增益的 dB 数：
            //    amount = +1 时起音最多 +9 dB，-1 时最多 -9 dB。死区吸收整流波形的纹波，稳态音增益恒为 1。
            if (settings.transient.enabled && transientAmount != 0f) {
                val a = abs(s)
                val fast = follow(transientEnv[channel], a, if (a >= transientEnv[channel]) transientAtkCoef else transientFastRelCoef)
                transientEnv[channel] = fast
                val slow = follow(transientPrev[channel], a, if (a >= transientPrev[channel]) transientSlowAtkCoef else transientFastRelCoef)
                transientPrev[channel] = slow
                val diffDb = 20f * kotlin.math.log10((fast + 1e-5f) / (slow + 1e-5f))
                val shaped = (diffDb - TRANSIENT_DEAD_ZONE_DB).coerceIn(0f, TRANSIENT_RANGE_DB)
                val target = dbToLinear(shaped * transientAmount)
                val current = transientGain[channel]
                // 离开 1 倍增益（起音）要快，回到 1 倍增益稍慢，免得增益台阶变成咔嗒。
                val g = current + (target - current) *
                    (if (abs(target - 1f) > abs(current - 1f)) transientGainAtkCoef else transientRelCoef)
                transientGain[channel] = g
                s *= g
            }

            // ⑥ 音色塑造
            if (toneWarmth.active) s = toneWarmth.process(s, channel)
            if (toneClarity.active) s = toneClarity.process(s, channel)
            if (tonePresence.active) s = tonePresence.process(s, channel)
            if (toneAir.active) s = toneAir.process(s, channel)

            // ⑦ 等响度
            if (loudLow.active) s = loudLow.process(s, channel)
            if (loudHigh.active) s = loudHigh.process(s, channel)

            // ⑧ 谐波激励：高频 → tanh 生成泛音 → 限带 → 混回
            if (settings.exciter.enabled) {
                val hf = exciterHighpass.process(s, channel)
                val harmonics = tanh(hf * exciterDrive)
                val limited = exciterLowpass.process(harmonics, channel)
                s = s * exciterDryGain + limited * exciterWetGain
            }

            // ⑨ 声道平衡：只改变前置左右；单声道和其他通道不动
            if (settings.balance.enabled && ch >= 2 && channel < 2) {
                s *= if ((channel and 1) == 0) leftGain else rightGain
            }

            buffer[index] = s
            index += 1
        }
    }

    /** Compare linked-channel mean powers on either side of the chain, before limiting. */
    fun compensate(buffer: FloatArray, offset: Int, frames: Int, channels: Int, reference: Float) {
        val output = meanPower(buffer, offset, frames * channels)
        val follow = 1f - kotlin.math.exp(-frames * compFollowCoef)
        refPower += (reference - refPower) * follow
        compPower += (output - compPower) * follow
        val ratio = if (compPower > 1e-9f) sqrt(refPower / compPower) else 1f
        val target = 1f + (ratio.coerceIn(1f, compMaxGain) - 1f) * compAmount
        for (frame in 0 until frames) {
            compGain += (target - compGain) * compRampCoef
            for (channel in 0 until channels) buffer[offset + frame * channels + channel] *= compGain
        }
    }

    /** one-pole 包络跟随。 */
    private fun follow(current: Float, target: Float, coef: Float): Float =
        current + (target - current) * coef

    /** 时间常数（ms）→ one-pole 系数。 */
    private fun coefFromMs(ms: Float): Float {
        val tau = (ms.coerceAtLeast(0.1f) / 1000f) * sampleRate
        return (1f - kotlin.math.exp(-1f / tau.coerceAtLeast(1f))).coerceIn(0f, 1f)
    }

    /** 每块开始（或参数变化）时把 settings 换算成系数与滤波器。 */
    private fun applySettings(s: MasteringSettings) {
        if (!s.compensation.enabled) { refPower = 0f; compPower = 0f; compGain = 1f }
        // ① 噪声门
        if (s.noiseGate.enabled) {
            gateAttackCoef = coefFromMs(s.noiseGate.attackMs)
            gateReleaseCoef = coefFromMs(s.noiseGate.releaseMs)
            gateFloorGain = dbToLinear(s.noiseGate.reductionDb)
            gateThreshold = dbToLinear(s.noiseGate.thresholdDb)
        } else {
            gateEnv.fill(0f)
            gateGain.fill(1f)
        }

        // ② 去喷麦：检测带、各时间常数都按毫秒/赫兹给出，随采样率换算；衰减量来自 reductionDb
        if (s.dePlosive.enabled) {
            plosiveLow.setLowPass(sampleRate, PLOSIVE_CUTOFF_HZ, 0.5f)
            plosiveHigh.setHighPass(sampleRate, PLOSIVE_CUTOFF_HZ, 0.5f)
            plosiveAtkCoef = coefFromMs(5f)
            plosiveRelCoef = coefFromMs(120f)
            plosiveFastRelCoef = coefFromMs(30f)
            plosiveSlowCoef = coefFromMs(400f)
            plosiveFloorGain = dbToLinear(s.dePlosive.reductionDb)
        } else {
            plosiveLow.bypass(); plosiveHigh.bypass()
            plosiveEnv.fill(0f); plosiveDetect.fill(0f); plosiveGain.fill(1f)
        }

        // ③ 去齿音：检测用高通，中心频率就是用户调的那个 frequencyHz
        if (s.deEsser.enabled) {
            deEsserBand.setHighPass(sampleRate, s.deEsser.frequencyHz, 0.7f)
            deessAtkCoef = coefFromMs(10f)
            deessRelCoef = coefFromMs(120f)
            deessThreshold = dbToLinear(s.deEsser.thresholdDb)
            deessSlope = s.deEsser.ratio.coerceAtLeast(1f)
        } else {
            deEsserBand.bypass()
            deEssEnv.fill(0f)
        }

        // ④ 低频增强
        if (s.bassBoost.enabled) {
            bassShelf.setLowShelf(sampleRate, s.bassBoost.frequencyHz, s.bassBoost.gainDb)
        } else bassShelf.bypass()

        // ⑤ 瞬态塑形：amount > 0 增强、< 0 柔化。快包络 1 ms 起、慢包络 25 ms 起、释放同为 40 ms。
        if (s.transient.enabled) {
            transientAmount = s.transient.amount.coerceIn(-1f, 1f)
            transientAtkCoef = coefFromMs(1f)
            transientSlowAtkCoef = coefFromMs(25f)
            transientFastRelCoef = coefFromMs(40f)
            transientGainAtkCoef = coefFromMs(0.1f)
            transientRelCoef = coefFromMs(60f)
        } else {
            transientAmount = 0f
            transientEnv.fill(0f); transientPrev.fill(0f); transientGain.fill(1f)
        }

        // ⑥ 音色塑造：四个固定中心频率，参数是各自的 dB
        val t = s.tone
        if (t.air > 0.01f) toneAir.setHighShelf(sampleRate, 9000f, t.air) else toneAir.bypass()
        if (t.presence > 0.01f) tonePresence.setPeaking(sampleRate, 3000f, 1.0f, t.presence) else tonePresence.bypass()
        if (t.warmth > 0.01f) toneWarmth.setPeaking(sampleRate, 220f, 0.9f, t.warmth) else toneWarmth.bypass()
        // clarity 是「削浑浊」，内部用负增益
        if (t.clarity > 0.01f) toneClarity.setPeaking(sampleRate, 350f, 1.1f, -t.clarity) else toneClarity.bypass()

        // ⑦ 等响度：低频 + 高频搁架，强度按 amount 缩放
        if (s.loudness.enabled && s.loudness.amount > 0.01f) {
            val a = s.loudness.amount
            loudLow.setLowShelf(sampleRate, 110f, 1f + 7f * a)
            loudHigh.setHighShelf(sampleRate, 8000f, 1f + 5f * a)
        } else {
            loudLow.bypass(); loudHigh.bypass()
        }

        // ⑧ 谐波激励：固定提取 2 kHz 以上的高频，tanh 饱和生成泛音
        if (s.exciter.enabled) {
            exciterHighpass.setHighPass(sampleRate, 2000f, 0.7f)
            exciterLowpass.setLowPass(sampleRate, 12000f, 0.7f)
            exciterDrive = 1f + 9f * s.exciter.amount
            val angle = s.exciter.mix.coerceIn(0f, 1f) * (PI.toFloat() / 2f)
            exciterDryGain = cos(angle)
            exciterWetGain = sin(angle) * (0.4f + 0.6f * s.exciter.amount)
        } else {
            exciterHighpass.bypass(); exciterLowpass.bypass()
        }

        // ⑨ 声道平衡：value -1 全左 → 右声道静音；+1 全右 → 左声道静音
        if (s.balance.enabled) {
            val v = s.balance.value.coerceIn(-1f, 1f)
            leftGain = if (v > 0f) 1f - v else 1f
            rightGain = if (v < 0f) 1f + v else 1f
        } else {
            leftGain = 1f; rightGain = 1f
        }

        // ⑩ 损失补偿：跟随时间来自 responseMs，斜坡略快于跟随以免「补过头」
        if (s.compensation.enabled) {
            compFollowCoef = coefFromMs(s.compensation.responseMs)
            compRampCoef = coefFromMs(s.compensation.responseMs * 0.5f)
            compAmount = s.compensation.amount.coerceIn(0f, 1f)
            compMaxGain = dbToLinear(s.compensation.maxGainDb)
        }
    }

    private companion object {
        const val MAX_CHANNELS = 8
        /** 去喷麦的低频带上沿（Hz）：喷麦的气流冲击集中在这以下。 */
        const val PLOSIVE_CUTOFF_HZ = 150f
        /** 低频带快包络的绝对门限（线性，约 -20 dBFS）。 */
        const val PLOSIVE_MIN_LEVEL = 0.1f
        /** 快包络比慢包络高出多少倍才算「冲击」（2 倍 ≈ 6 dB）。 */
        const val PLOSIVE_BURST_RATIO = 2f
        /** 瞬态塑形：快/慢包络之比小于它（dB）一律不动，吸收整流纹波与稳态偏差。 */
        const val TRANSIENT_DEAD_ZONE_DB = 3f
        /** 死区之上、amount = ±1 时增益的最大 dB 数。 */
        const val TRANSIENT_RANGE_DB = 9f
    }
}

internal fun meanPower(buffer: FloatArray, offset: Int, count: Int): Float {
    var sum = 0f
    for (i in offset until offset + count) sum += buffer[i] * buffer[i]
    return sum / count
}
