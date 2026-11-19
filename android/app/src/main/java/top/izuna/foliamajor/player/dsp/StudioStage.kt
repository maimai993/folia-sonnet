package top.izuna.foliamajor.player.dsp

import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sqrt

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StudioStage.kt
//
// 工作室台：四大方向 11 项处理，位于母带台之后、限幅之前。
//
//   响度标准化：缓慢调节 RMS 电平；可选目标再降 1 dB
//   音频修复：去咔嗒（孤立异常样本顶替）、去嗡声（50/60Hz 陷波）、降噪（稳态噪声门）
//   进阶效果：动态 EQ（低频浑浊动态衰减）、M/S 声场、立体声展宽、人声增强
//   智能场景：曲风预设（隐式多段音色）、耳机校准（频响补偿）、场景强度
//
// A/B 对比（compare）不在这里做 —— 它需要原始未处理信号，在 EqAudioProcessor
// 输出选择与湿声等延迟的干声实现，见 process() 开头。
//
// 线程：只在音频渲染线程（playerLooper）调用。所有状态在类内、按声道保留，无锁、无分配。
// 包络跟随用 one-pole（y += (x - y) * coef），与 Web 的 setTargetAtTime 同一套平滑。

private const val STUDIO_MAX_CHANNELS = 8

/** 去咔嗒的比较窗口：前几个样本（48 kHz 下约 83 µs，覆盖 6 kHz 以上高频的一个完整周期）。 */
private const val CLICK_HISTORY = 4
private const val CLICK_RATIO = 1.5f
private const val CLICK_MARGIN = 0.1f

class StudioStage {

    // —— 修复 / 场景滤波：陷波用 peaking 负增益近似，其余用 shelf / peaking ——
    private val humNotch50 = BiquadFilter()
    private val humNotch60 = BiquadFilter()
    private val humNotch120 = BiquadFilter()
    private val humNotch100 = BiquadFilter()
    private val dynEqBand = BiquadFilter()
    private val vocalBand = BiquadFilter()
    private val sceneLow = BiquadFilter()
    private val sceneMid = BiquadFilter()
    private val sceneHigh = BiquadFilter()
    private val hpCalib = BiquadFilter()
    private val lpCalib = BiquadFilter()

    private var sampleRate = 0
    private var channels = 1

    // 每声道状态
    private val clickPrev = FloatArray(STUDIO_MAX_CHANNELS)
    private val clickHistory = FloatArray(STUDIO_MAX_CHANNELS * CLICK_HISTORY)
    private val clickHead = IntArray(STUDIO_MAX_CHANNELS)
    private val noiseEnv = FloatArray(STUDIO_MAX_CHANNELS)
    private val noiseGate = FloatArray(STUDIO_MAX_CHANNELS)

    // 响度标准化：短时平均功率 → 慢速目标增益
    private var normPower = 0f
    private var normGain = 1f

    private var lastStudio: StudioSettings? = null
    private var wasNeutral = true

    // 缓存系数
    private var noiseAtkCoef = 0f
    private var noiseRelCoef = 0f
    private var noiseFloorGain = 1f
    private val dynEqDetect = FloatArray(STUDIO_MAX_CHANNELS)
    private var dynEqAmount = 0f
    private var dynEqAtk = 0f
    private var dynEqRel = 0f
    private var normFollowCoef = 0f
    private var normRampCoef = 0f
    private var normTargetRms = 0.14f

    fun configure(sampleRate: Int, channels: Int) {
        this.sampleRate = sampleRate
        this.channels = channels.coerceIn(1, STUDIO_MAX_CHANNELS)
        lastStudio = null
        wasNeutral = true
        reset()
    }

    fun reset() {
        humNotch60.reset(); humNotch120.reset(); humNotch50.reset(); humNotch100.reset(); dynEqBand.reset(); vocalBand.reset()
        sceneLow.reset(); sceneMid.reset(); sceneHigh.reset(); hpCalib.reset(); lpCalib.reset()
        clickPrev.fill(0f); clickHistory.fill(0f); clickHead.fill(0)
        noiseEnv.fill(0f); noiseGate.fill(1f)
        normPower = 0f; normGain = 1f; dynEqDetect.fill(0f)
    }

    fun process(
        buffer: FloatArray,
        offset: Int,
        frames: Int,
        channelsIn: Int,
        settings: StudioSettings,
    ) {
        if (frames <= 0 || sampleRate <= 0) return
        val ch = channelsIn.coerceIn(1, STUDIO_MAX_CHANNELS)
        channels = ch

        val neutral = settings.isNeutral()
        if (neutral) {
            wasNeutral = true
            return
        }
        if (wasNeutral) {
            reset()
            wasNeutral = false
        }
        if (settings !== lastStudio) {
            applySettings(settings)
            lastStudio = settings
        }

        val count = frames * ch
        var index = offset
        val s = settings

        while (index < offset + count) {
            val channel = index % ch
            var v = buffer[index]

            // 去咔嗒：只处理「孤立异常」—— 当前样本的幅度远超它前 CLICK_HISTORY 个样本里的最大幅度
            // （1.5 倍并多出 0.1 满幅）。持续的 6/10/12 kHz 高频每个周期内幅度都在历史里出现过，
            // 不会被当成咔嗒；只剩一个代价：从近乎静音突然起音的第一个样本会被当作咔嗒处理（≤1 个样本）。
            // 判断用输入历史（不是修复后的值），免得修复把后面的检测蒙住。
            if (s.restore.declick) {
                val base = channel * CLICK_HISTORY
                var recent = 0f
                for (k in 0 until CLICK_HISTORY) recent = maxOf(recent, clickHistory[base + k])
                val mag = abs(v)
                clickHistory[base + clickHead[channel]] = mag
                clickHead[channel] = (clickHead[channel] + 1) % CLICK_HISTORY
                if (mag > recent * CLICK_RATIO + CLICK_MARGIN) {
                    // 用上一个输出样本顶替，按修复强度混合：amount = 0 不动，1 完全顶替。
                    v -= (v - clickPrev[channel]) * s.restore.amount
                }
                clickPrev[channel] = v
            }

            // 去嗡声：50/60Hz 及二次谐波陷波（peaking 负增益，Q 高）。
            if (s.restore.hum) {
                v = humNotch50.process(v, channel)
                v = humNotch100.process(v, channel)
                v = humNotch60.process(v, channel)
                v = humNotch120.process(v, channel)
            }

            // 降噪：稳态包络低于固定门限（约 -52 dBFS）时按 amount 衰减。
            if (s.restore.denoise) {
                val a = if (abs(v) > noiseEnv[channel]) noiseAtkCoef else noiseRelCoef
                noiseEnv[channel] += (abs(v) - noiseEnv[channel]) * a
                val threshold = 0.0025f
                val target = if (noiseEnv[channel] < threshold) noiseFloorGain else 1f
                val g = noiseGate[channel] + (target - noiseGate[channel]) *
                    (if (target > noiseGate[channel]) noiseAtkCoef else noiseRelCoef)
                noiseGate[channel] = g
                v *= g
            }

            // 动态 EQ：低频能量超阈值时压一把（轰头/浑浊控制）。
            if (s.advanced.dynamicEq) {
                val band = dynEqBand.process(v, channel)
                val a = if (abs(band) > dynEqDetect[channel]) dynEqAtk else dynEqRel
                dynEqDetect[channel] += (abs(band) - dynEqDetect[channel]) * a
                val over = dynEqDetect[channel] - 0.12f
                val gain = if (over > 0f) (1f - ((over / 0.25f).coerceAtMost(1f) * dynEqAmount)) else 1f
                v = v - band + band * gain
            }

            // 人声增强：抬 2~4kHz 存在感（peaking，按强度）。
            if (s.advanced.vocalBoost > 0.01f) {
                v = vocalBand.process(v, channel)
            }

            // 场景：曲风 + 耳机校准的隐式多段 EQ。
            if (!s.scene.genre.equals("flat", ignoreCase = true)
                || !s.scene.headphone.equals("flat", ignoreCase = true)) {
                v = sceneLow.process(v, channel)
                v = sceneMid.process(v, channel)
                v = sceneHigh.process(v, channel)
            }
            if (!s.scene.headphone.equals("flat", ignoreCase = true)) {
                v = hpCalib.process(v, channel)
                v = lpCalib.process(v, channel)
            }

            buffer[index] = v
            index++
        }

        // 响度标准化：以「帧」为单位 —— 每帧求所有声道的均方、功率跟随与增益斜坡各推进一次，
        // 同一个增益乘到该帧的每个声道（5.1 与立体声的时间常数相同，声道间的相对电平不被改动）。
        // 在限幅前，补完由限幅兜峰值。
        if (s.normalize.enabled) {
            var base = offset
            for (frame in 0 until frames) {
                var sum = 0f
                for (channel in 0 until ch) sum += buffer[base + channel] * buffer[base + channel]
                normPower += (sum / ch - normPower) * normFollowCoef
                val target = (normTargetRms / sqrt(normPower.coerceAtLeast(1e-8f))).coerceIn(0.5f, 2.2f)
                normGain += (target - normGain) * normRampCoef
                for (channel in 0 until ch) buffer[base + channel] *= normGain
                base += ch
            }
        }
    }

    private fun applySettings(s: StudioSettings) {
        val sr = sampleRate
        val r = s.restore
        val a = s.advanced
        val sc = s.scene

        // 降噪与去咔嗒：门限固定在 -52dB 附近的线性值，attack 快、release 慢；单独关闭时清历史状态。
        if (r.denoise) {
            noiseAtkCoef = coef(10f, sr)
            noiseRelCoef = coef(180f, sr)
            noiseFloorGain = 1f - 0.6f * r.amount
        } else {
            noiseEnv.fill(0f)
            noiseGate.fill(1f)
        }
        if (!r.declick) {
            clickPrev.fill(0f)
            clickHistory.fill(0f)
            clickHead.fill(0)
        }

        // 去嗡声：50/60 Hz 及二次谐波陷波，深度随 amount
        val humDepth = if (r.hum) -18f * r.amount else 0f
        humNotch60.setPeaking(sr, 60f, 12f, humDepth)
        humNotch120.setPeaking(sr, 120f, 12f, humDepth * 0.7f)
        humNotch50.setPeaking(sr, 50f, 12f, humDepth)
        humNotch100.setPeaking(sr, 100f, 12f, humDepth * 0.7f)

        if (a.dynamicEq) dynEqBand.setBandPass(sr, a.dynamicEqFreq, 1.2f) else {
            dynEqBand.bypass(); dynEqDetect.fill(0f)
        }
        dynEqAmount = 1f - dbToLinear(-a.dynamicEqAmount)
        dynEqAtk = coef(8f, sr)
        dynEqRel = coef(160f, sr)

        // 人声增强：3kHz peaking
        if (a.vocalBoost > 0.01f) {
            vocalBand.setPeaking(sr, 3000f, 1.0f, a.vocalBoost * 4f)
        } else {
            vocalBand.bypass()
        }

        // 曲风预设：低/中/高三段的相对增益
        val genre = sc.genre.lowercase()
        val strength = sc.amount
        val (gLow, gMid, gHigh) = when (genre) {
            "pop" -> Triple(1.5f, 0f, 1.5f)
            "rock" -> Triple(2.5f, -1.5f, 2f)
            "jazz" -> Triple(1f, 1f, 1.5f)
            "classical" -> Triple(1f, 0f, 2f)
            "electronic" -> Triple(4f, -1f, 2.5f)
            "vocal" -> Triple(0f, 2f, 1.5f)
            else -> Triple(0f, 0f, 0f)
        }
        sceneLow.setLowShelf(sr, 200f, gLow * strength)
        sceneMid.setPeaking(sr, 1000f, 0.9f, gMid * strength)
        sceneHigh.setHighShelf(sr, 6000f, gHigh * strength)

        // 耳机校准：常见耳机的频响补偿
        val hp = sc.headphone.lowercase()
        val (hLow, hHigh) = when (hp) {
            "airpods" -> Pair(-1.5f, 2f)
            "sony" -> Pair(2f, -1.5f)
            "sennheiser" -> Pair(1f, 1.5f)
            else -> Pair(0f, 0f)
        }
        if (hLow != 0f) hpCalib.setLowShelf(sr, 250f, hLow * strength) else hpCalib.bypass()
        if (hHigh != 0f) lpCalib.setHighShelf(sr, 5000f, hHigh * strength) else lpCalib.bypass()

        // 响度标准化：目标 dBFS RMS → 线性电平；单独关闭时归零功率与增益，避免重开沿用旧值。
        if (s.normalize.enabled) {
            // Legacy wire keys targetLufs/truePeak represent RMS dBFS and a target offset, not BS.1770.
            val targetDb = s.normalize.targetLufs - if (s.normalize.truePeak) 1f else 0f
            normTargetRms = 10f.pow(targetDb / 20f)
            normFollowCoef = coef(1500f, sr) // 慢速功率跟随（~1.5s）
            normRampCoef = coef(600f, sr)    // 更慢的增益斜坡，避免抽吸
        } else {
            normPower = 0f
            normGain = 1f
        }
    }

    /** 时间常数 → one-pole 系数：coef = 1 - exp(-1 / (tau * fs))。 */
    private fun coef(timeMs: Float, sampleRate: Int): Float {
        if (timeMs <= 0f) return 1f
        return 1f - kotlin.math.exp(-1f / (timeMs * 0.001f * sampleRate.toFloat()))
    }

    private fun Float.abs(): Float = kotlin.math.abs(this)
}
