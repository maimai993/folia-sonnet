package top.izuna.foliamajor.player.transition.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import top.izuna.foliamajor.player.dsp.BiquadFilter
import top.izuna.foliamajor.player.transition.engine.EffectOutput
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.pow

// android/app/src/main/java/top/izuna/foliamajor/player/transition/dsp/TransitionDspProcessor.kt
// 过渡专用的 PCM 处理器：三频段换手、扫频滤波、回声抛掷、riser、软限幅。
//
// 挂点：FoliaAudioSinkFactory.buildAudioSink() 的 setAudioProcessors 数组里在 EqAudioProcessor
// 之后加一个本类实例（补丁见 TRANSITION_NATIVE.md）。每台播放器各有一个实例，
// 用 DeckRole 区分自己是 incoming 还是 outgoing，于是同一份 EffectOutput 能让两台
// 播放器做出相反的动作 —— 这正是「低频同一时刻只属于一方」能成立的原因。
//
// ⚠️ 与 EqAudioProcessor 同样的三条 media3 隐式规则：
//   1. setEnableFloatOutput 必须 false，否则 24bit 源会让整条 processor 链被跳过；
//   2. offload 会绕过 processor，本项目没开；
//   3. 输入到这里一定是 16bit PCM。
//
// 线程：只在 playerLooper（音频渲染线程）上调用。缓冲区在 configure 时分配一次，
// queueInput 里不再 new —— GC 抖一下就是一次欠载。

enum class DeckRole { INCOMING, OUTGOING, INACTIVE }

/** 执行引擎每 20 ms 发布一帧，两台 processor 各自读走属于自己那一半。 */
object TransitionDspState {
    @Volatile private var current: EffectOutput? = null

    @JvmStatic
    fun publish(output: EffectOutput?) {
        current = output
    }

    @JvmStatic
    fun snapshot(): EffectOutput? = current?.takeIf { it.needsDsp }

    @JvmStatic
    fun clear() {
        current = null
    }
}

@UnstableApi
class TransitionDspProcessor(
    /**
     * 角色是可变的：一台播放器在非过渡期是 INACTIVE（直通），过渡开始后原来的主播放器
     * 变成 OUTGOING、新造的那台变成 INCOMING，交接完成后新的那台又变回 INACTIVE。
     * 由 FoliaNativePlayer 持有的 AtomicReference 提供，音频线程每块读一次。
     */
    private val roleProvider: () -> DeckRole = { DeckRole.INCOMING },
) : BaseAudioProcessor() {

    private var sampleRate = 0
    private var channels = 0

    private val lowShelf = BiquadFilter()
    private val highShelf = BiquadFilter()
    private val lowPass = BiquadFilter()
    private val highPass = BiquadFilter()

    private var raw = ByteArray(0)
    private var carry = ByteArray(0)
    private var carrySize = 0
    private var scratch = FloatArray(0)

    /** 回声 / riser 用的环形延迟线，按声道各一条。 */
    private var echoLines = arrayOf<FloatArray>()
    private var echoIndex = 0

    private var lastLowDb = Float.NaN
    private var lastHighDb = Float.NaN
    private var lastLp = 0f
    private var lastHp = 0f

    @UnstableApi
    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            return AudioProcessor.AudioFormat.NOT_SET
        }
        sampleRate = inputAudioFormat.sampleRate
        channels = inputAudioFormat.channelCount.coerceAtLeast(1).coerceAtMost(8)
        raw = ByteArray(0)
        scratch = FloatArray(0)
        carry = ByteArray(2 * channels)
        carrySize = 0
        // 280 ms 的回声尾巴，够盖住一个断口，又不会一直挂在场上。
        val echoLen = (sampleRate * 0.28f).toInt().coerceAtLeast(256)
        echoLines = Array(channels) { FloatArray(echoLen) }
        echoIndex = 0
        resetFilters()
        return inputAudioFormat
    }

    override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
        // seek / 换源：清掉滤波器和延迟线的尾巴，否则新位置会拖着旧信号。
        resetFilters()
        carrySize = 0
        echoLines.forEach { it.fill(0f) }
    }

    private fun resetFilters() {
        lowShelf.bypass(); highShelf.bypass(); lowPass.bypass(); highPass.bypass()
        lastLowDb = Float.NaN; lastHighDb = Float.NaN; lastLp = 0f; lastHp = 0f
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val incoming = inputBuffer.remaining()
        if (incoming <= 0) return
        if (channels <= 0 || sampleRate <= 0) {
            val out = replaceOutputBuffer(incoming)
            out.put(inputBuffer)
            out.flip()
            return
        }

        val frameBytes = 2 * channels
        val total = carrySize + incoming
        val frames = total / frameBytes
        if (frames <= 0) {
            inputBuffer.get(carry, carrySize, incoming)
            carrySize = total
            return
        }
        val used = frames * frameBytes
        if (raw.size < used) raw = ByteArray(used)
        if (carrySize > 0) System.arraycopy(carry, 0, raw, 0, carrySize)
        inputBuffer.get(raw, carrySize, used - carrySize)
        carrySize = total - used
        if (carrySize > 0) inputBuffer.get(carry, 0, carrySize)

        val role = roleProvider()
        val state = if (role == DeckRole.INACTIVE) null else TransitionDspState.snapshot()
        if (state == null) {
            // 不在过渡里：逐字节直通，不多花一个样本的时间。
            val out = replaceOutputBuffer(used)
            out.put(raw, 0, used)
            out.flip()
            return
        }

        val sampleCount = frames * channels
        if (scratch.size < sampleCount) scratch = FloatArray(sampleCount)
        decode(raw, sampleCount, scratch)
        syncFilters(state, role)

        val gains = if (role == DeckRole.INCOMING) state.bandIn else state.bandOut
        val tiltDb = if (role == DeckRole.INCOMING) state.tiltDbIn else 0f
        val midGain = gains.mid * dbToLinear(tiltDb)
        val echoMix = if (role == DeckRole.OUTGOING) state.echoMix + state.reverbTail else 0f
        val riser = if (role == DeckRole.INCOMING) state.riserLevel else 0f

        var riserPhase = 0
        for (f in 0 until frames) {
            for (c in 0 until channels) {
                val idx = f * channels + c
                var v = scratch[idx]
                v = lowShelf.process(v, c)
                v = highShelf.process(v, c)
                v = lowPass.process(v, c)
                v = highPass.process(v, c)
                v *= midGain

                if (echoMix > 0f && echoLines.isNotEmpty()) {
                    val line = echoLines[c]
                    val delayed = line[echoIndex]
                    line[echoIndex] = v + delayed * 0.35f
                    v += delayed * echoMix
                }
                if (riser > 0f) {
                    // 极轻量的 riser：一个随帧爬升的锯齿 + 白噪声，够做「抽拉感」的提示。
                    riserPhase = (riserPhase + 1) and 0xFFFF
                    val tone = (riserPhase / 32768f) - 1f
                    v += tone * riser * 0.08f
                }
                // 软限幅：两曲叠加时峰值可能过 0 dBFS，用 tanh 形状压住，不硬削。
                v = softClip(v * state.limiterDrive)
                scratch[idx] = v
            }
            echoIndex = (echoIndex + 1) % (echoLines.firstOrNull()?.size ?: 1)
        }

        val out = replaceOutputBuffer(used)
        encode(scratch, sampleCount, out)
        out.flip()
    }

    private fun syncFilters(state: EffectOutput, role: DeckRole) {
        val gains = if (role == DeckRole.INCOMING) state.bandIn else state.bandOut
        val lowDb = gainToDb(gains.low)
        val highDb = gainToDb(gains.high)
        if (lastLowDb.isNaN() || abs(lowDb - lastLowDb) > 0.25f) {
            if (abs(lowDb) < 0.05f) lowShelf.bypass()
            else lowShelf.setLowShelf(sampleRate, 250f, lowDb)
            lastLowDb = lowDb
        }
        if (lastHighDb.isNaN() || abs(highDb - lastHighDb) > 0.25f) {
            if (abs(highDb) < 0.05f) highShelf.bypass()
            else highShelf.setHighShelf(sampleRate, 4_000f, highDb)
            lastHighDb = highDb
        }
        val lp = if (role == DeckRole.INCOMING) state.lowPassInHz else state.lowPassOutHz
        val hp = if (role == DeckRole.INCOMING) state.highPassInHz else state.highPassOutHz
        if (abs(lp - lastLp) > 60f) {
            if (lp <= 0f) lowPass.bypass() else lowPass.setLowPass(sampleRate, lp, 0.7f)
            lastLp = lp
        }
        if (abs(hp - lastHp) > 20f) {
            if (hp <= 0f) highPass.bypass() else highPass.setHighPass(sampleRate, hp, 0.7f)
            lastHp = hp
        }
    }

    private fun decode(source: ByteArray, sampleCount: Int, target: FloatArray) {
        var b = 0
        for (i in 0 until sampleCount) {
            val lo = source[b].toInt() and 0xFF
            val hi = source[b + 1].toInt()
            target[i] = ((hi shl 8) or lo).toShort() / 32768f
            b += 2
        }
    }

    private fun encode(source: FloatArray, sampleCount: Int, target: ByteBuffer) {
        for (i in 0 until sampleCount) {
            var v = (source[i] * 32768f).toInt()
            if (v > 32767) v = 32767 else if (v < -32768) v = -32768
            target.put((v and 0xFF).toByte())
            target.put(((v shr 8) and 0xFF).toByte())
        }
    }

    private fun gainToDb(gain: Float): Float =
        if (gain <= 0.001f) -60f else (20.0 * kotlin.math.log10(gain.toDouble())).toFloat()

    private fun dbToLinear(db: Float): Float = 10f.pow(db / 20f)

    /**
     * 软限幅：|x| ≤ 0.8 完全不动，之上平滑压向 1 —— 两曲叠加时峰值不会被硬削，
     * 安静段落也不会被「预设一刀」砍掉动态（这也是不用固定 headroom 的原因）。
     */
    private fun softClip(x: Float): Float {
        val a = abs(x)
        if (a <= 0.8f) return x
        val sign = if (x < 0f) -1f else 1f
        return sign * (0.8f + 0.2f * (1f - kotlin.math.exp(-(a - 0.8f) / 0.2f).toFloat()))
    }
}
