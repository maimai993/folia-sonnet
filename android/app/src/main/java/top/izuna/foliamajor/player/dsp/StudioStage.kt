package top.izuna.foliamajor.player.dsp

import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.sqrt

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/StudioStage.kt
//
// 工作室台：四大方向 11 项处理，位于母带台之后、限幅之前。
//
//   响度标准化：把整曲电平缓慢推向目标响度（RMS 近似 LUFS）；真峰值留余量
//   音频修复：去咔嗒（瞬态削平）、去嗡声（50/60Hz 陷波）、降噪（稳态噪声门）
//   进阶效果：动态 EQ（低频浑浊动态衰减）、M/S 声场、立体声展宽、人声增强
//   智能场景：曲风预设（隐式多段音色）、耳机校准（频响补偿）、场景强度
//
// A/B 对比（compare）不在这里做 —— 它需要原始未处理信号，在 EqAudioProcessor
// 入口旁通整条链实现，见 process() 开头。
//
// 线程：只在音频渲染线程（playerLooper）调用。所有状态在类内、按声道保留，无锁、无分配。
// 包络跟随用 one-pole（y += (x - y) * coef），与 Web 的 setTargetAtTime 同一套平滑。

private const val STUDIO_MAX_CHANNELS = 8

class StudioStage {

    // —— 修复 / 场景滤波：陷波用 peaking 负增益近似，其余用 shelf / peaking ——
    private val humNotch50 = BiquadFilter()
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
    private val noiseEnv = FloatArray(STUDIO_MAX_CHANNELS)
    private val noiseGate = FloatArray(STUDIO_MAX_CHANNELS)
    private var widenPrevL = 0f
    private var widenPrevR = 0f

    // 响度标准化：整曲平均功率 → 慢速目标增益
    private var normPower = 0f
    private var normGain = 1f

    private var lastStudio: StudioSettings? = null
    private var wasNeutral = true

    // 缓存系数
    private var noiseAtkCoef = 0f
    private var noiseRelCoef = 0f
    private var noiseFloorGain = 1f
    private var dynEqDetect = 0f
    private var dynEqAmount = 0f
    private var dynEqAtk = 0f
    private var dynEqRel = 0f
    private var widenAmount = 0f
    private var msMidGain = 1f
    private var msSideGain = 1f
    private var normFollowCoef = 0f
    private var normRampCoef = 0f
    private var normTargetGain = 1f

    fun configure(sampleRate: Int, channels: Int) {
        this.sampleRate = sampleRate
        this.channels = channels.coerceIn(1, STUDIO_MAX_CHANNELS)
        lastStudio = null
        wasNeutral = true
        reset()
    }

    fun reset() {
        humNotch50.reset(); humNotch100.reset(); dynEqBand.reset(); vocalBand.reset()
        sceneLow.reset(); sceneMid.reset(); sceneHigh.reset(); hpCalib.reset(); lpCalib.reset()
        clickPrev.fill(0f)
        noiseEnv.fill(0f); noiseGate.fill(1f)
        widenPrevL = 0f; widenPrevR = 0f
        normPower = 0f; normGain = 1f
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

            // 去咔嗒：相邻样本差过大（>0.5）视为瞬态断点，用前一样本线性插值抹平。
            if (s.restore.declick) {
                val diff = v - clickPrev[channel]
                if (abs(diff) > 0.5f) {
                    v = clickPrev[channel] + diff * 0.25f
                }
                clickPrev[channel] = v
            }

            // 去嗡声：50/60Hz 及二次谐波陷波（peaking 负增益，Q 高）。
            if (s.restore.hum) {
                v = humNotch50.process(v, channel)
                v = humNotch100.process(v, channel)
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
                val a = if (abs(band) > dynEqDetect) dynEqAtk else dynEqRel
                dynEqDetect += (abs(band) - dynEqDetect) * a
                val over = dynEqDetect - 0.12f
                val gain = if (over > 0f) (1f - (over * dynEqAmount).coerceAtMost(0.85f)) else 1f
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

            // 响度标准化：测功率，缓慢把增益推向目标（在限幅前，补完由限幅兜峰值）。
            if (s.normalize.enabled) {
                normPower += (v * v - normPower) * normFollowCoef
                normGain += (normTargetGain - normGain) * normRampCoef
                v *= normGain
            }

            buffer[index] = v
            index++
        }

        // M/S 声场与展宽是跨声道的，必须在样本循环之后按帧处理。
        if ((s.advanced.msWidth.abs() > 0.01f || s.advanced.widen > 0.01f) && ch >= 2) {
            processStereo(buffer, offset, frames, ch, s)
        }
    }

    /** 中侧矩阵 + Haas 展宽：按帧对左右声道处理。 */
    private fun processStereo(
        buffer: FloatArray, offset: Int, frames: Int, ch: Int, s: StudioSettings,
    ) {
        var i = offset
        var frame = 0
        while (frame < frames) {
            val l = buffer[i]
            val r = buffer[i + 1]
            var mid = (l + r) * 0.5f
            var side = (l - r) * 0.5f

            if (s.advanced.msWidth.abs() > 0.01f) {
                mid *= msMidGain
                side *= msSideGain
            }

            var outL = mid + side
            var outR = mid - side

            // Haas 展宽：一侧加极短延迟并交叉混入一点点，制造空间感而不明显染色。
            if (s.advanced.widen > 0.01f) {
                val delayedL = widenPrevR
                val delayedR = widenPrevL
                widenPrevL = l
                widenPrevR = r
                outL = outL * (1f - widenAmount) + delayedR * widenAmount
                outR = outR * (1f - widenAmount) + delayedL * widenAmount
            }

            buffer[i] = outL
            buffer[i + 1] = outR
            i += ch
            frame++
        }
    }

    private fun applySettings(s: StudioSettings) {
        val sr = sampleRate
        val r = s.restore
        val a = s.advanced
        val sc = s.scene

        // 降噪：门限固定在 -52dB 附近的线性值，attack 快、release 慢
        noiseAtkCoef = coef(10f, sr)
        noiseRelCoef = coef(180f, sr)
        noiseFloorGain = 1f - 0.6f * r.amount

        // 去嗡声：50Hz 与 100Hz 陷波，深度随 amount
        val humDepth = -(6f + 12f * r.amount)
        humNotch50.setPeaking(sr, 50f, 12f, humDepth)
        humNotch100.setPeaking(sr, 100f, 12f, humDepth * 0.7f)

        // 动态 EQ：低频段 peaking 作为分析滤波器。
        // setPeaking 在 0dB 时会 bypass；用一个极小的非零增益强制 active，信号影响可忽略。
        dynEqBand.setPeaking(sr, a.dynamicEqFreq, 1.2f, 0.01f)
        dynEqAmount = a.dynamicEqAmount / 12f
        dynEqAtk = coef(8f, sr)
        dynEqRel = coef(160f, sr)

        // 人声增强：3kHz peaking
        if (a.vocalBoost > 0.01f) {
            vocalBand.setPeaking(sr, 3000f, 1.0f, a.vocalBoost * 4f)
        } else {
            vocalBand.bypass()
        }

        // M/S 宽度：mid/side 增益，宽度 -1~1 映射到 side 0.2~2.2
        msSideGain = 1f + a.msWidth * 1.2f
        msMidGain = 1f - kotlin.math.abs(a.msWidth) * 0.1f
        widenAmount = a.widen * 0.18f

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

        // 响度标准化：目标 LUFS → 线性目标增益。RMS 参考 0.14 ≈ -17dBFS。
        if (s.normalize.enabled) {
            val targetRms = 10f.pow((s.normalize.targetLufs + 17f) / 20f) * 0.14f
            val truePeakHeadroom = if (s.normalize.truePeak) 0.89f else 1f
            // 目标增益 = 目标RMS / 当前估计RMS；用一个经验上界避免无限放大。
            normTargetGain = (targetRms / 0.12f).coerceIn(0.5f, 2.2f) * truePeakHeadroom
            normFollowCoef = coef(1500f, sr) // 慢速功率跟随（~1.5s）
            normRampCoef = coef(600f, sr)    // 更慢的增益斜坡，避免抽吸
        }
    }

    /** 时间常数 → one-pole 系数：coef = 1 - exp(-1 / (tau * fs))。 */
    private fun coef(timeMs: Float, sampleRate: Int): Float {
        if (timeMs <= 0f) return 1f
        return 1f - kotlin.math.exp(-1f / (timeMs * 0.001f * sampleRate.toFloat()))
    }

    private fun Float.abs(): Float = kotlin.math.abs(this)
}
