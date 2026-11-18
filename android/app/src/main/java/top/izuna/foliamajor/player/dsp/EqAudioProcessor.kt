package top.izuna.foliamajor.player.dsp

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.exp
import kotlin.math.pow

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/EqAudioProcessor.kt
// 原生播放层的调音台：解码后的 PCM 在进 AudioTrack 之前经过这里。
//
// 这是整个方案的核心 —— ExoPlayer 出声时不经过 WebView 的 Web Audio 图，
// 所以均衡器、压缩、混响只能在这里做。挂载点见 FoliaAudioSinkFactory.buildAudioSink()。
//
// 信号链（顺着一路往下，每一站都能单独关掉）：
//   ① 前置十段 EQ（GEQ / PEQ，含总增益）
//   ② 高通 / 低通
//   ③ punch（Web 遗留的单段压缩）+ 自动 headroom
//   ④ 四段压缩（Low / Mid / High / Air）
//   ⑤ 后置十段 EQ
//   ⑥ 饱和 / 染色（磁带 / 电子管 / 二极管）
//   ⑦ 声场宽度（M/S，只作用于干声）+ 低频单声道
//   ⑧ 空间混响
//   ⑨ 前瞻限幅（整条链的最后一步，交给声卡之前不许超过 0 dBFS）
//   ⑩ 频谱取样（只读，不影响声音）
//
// 顺序为什么是这样：压缩要看到「音色已经定下来」的信号，所以它在两个 EQ 之间；
// 饱和放在后置 EQ 之后，是「染色」的最后一道 —— 它加的谐波不该再被 EQ 削回去。
// 混响是空间，必须在所有动态处理之后，否则压缩器会把混响的尾巴一起压掉（抽气感）。
// 限幅永远最后 —— 前面任何一站加的增益都要由它兜住。
//
// ⚠️ 三条 media3 的隐式规则，改动前先读 FoliaAudioSinkFactory 的注释：
//   1. float 输出会让整条 processor 链被跳过 → 必须 setEnableFloatOutput(false)；
//   2. offload 不支持 processor → 必须 OFFLOAD_MODE_DISABLED；
//   3. 输入到这里一定是 16bit PCM（高解析度源已被 toInt16PcmAudioProcessor 转过）。
//
// 线程：只在 playerLooper（ExoPlayer 的音频渲染线程）上调用。
// 全部缓冲在 configure 时按格式分配一次，queueInput 里不再 new（GC 抖一下就是一次欠载）。

/**
 * headroom 只补偿 6 dB 以上的部分。
 *
 * 全量补偿会让「低音 +12」听起来比电脑上小一半；完全不补偿又会让 16bit 中间态长期顶到
 * 限幅器上（泵感）。折算一半是这两者的折中，数值听感在真机上再调。
 */
private const val MAX_UNCOMPENSATED_BOOST_DB = 6f

/**
 * 静态 headroom 只承担这个比例的补偿量，剩下的交给前瞻限幅器按实际峰值动态处理。
 *
 * 为什么不全额静态补：静态衰减是「不管这首歌安静还是吵闹都先砍一刀」，砍掉的正是动态余量
 * ——用户听到的是「开了 EQ 声音变小、变闷」。限幅器只在峰值真的顶上来时才降增益，安静段落
 * 一个样本都不碰，动态范围保住了。留 0.5 是为了让持续大电平的曲目不至于让限幅器一直工作。
 */
private const val HEADROOM_TRIM = 0.5f

@UnstableApi
class EqAudioProcessor(
    private val state: NativeEqualizerState,
) : BaseAudioProcessor() {

    private var sampleRate = 0
    private var channels = 0

    private var settings: EqSettings = EqSettings.NEUTRAL
    private var seenSeq = Long.MIN_VALUE

    private val frontEq = TenBandEq()
    private val postEq = TenBandEq()
    private val highPass = BiquadFilter()
    private val lowPass = BiquadFilter()
    private val dynamics = DynamicsStage()
    private val compressor = MultibandCompressor()
    private val saturation = SaturationStage()
    private val stereo = StereoStage()
    private val reverb = ReverbStage()
    private val mastering = MasteringStage()
    private val studio = StudioStage()
    private val spectrum = SpectrumAnalyzer()
    private val limiter = LookaheadLimiter()
    private val pcm = Pcm16Codec()

    private val targetGains = FloatArray(EQ_BAND_COUNT)
    private val smoothedGains = FloatArray(EQ_BAND_COUNT)
    private var targetGlobalGainDb = 0f
    private var smoothedGlobalGainDb = 0f
    private var applyPostEqNext = true
    /** 下一次 smoothGains 直接落到目标（冷启动 / seek 之后），而不是从 0 dB 滑过去。 */
    private var snapGainsNext = true
    private var smoothingCoef = 0.5f
    private var preGain = 1f

    /** 浮点中间态，长度按块增长，永不缩小（避免每块 new）。 */
    private var scratch = FloatArray(0)

    /** 上一块剩下的整字节（不完整的一帧）。 */
    private var raw = ByteArray(0)
    private var carry = ByteArray(0)
    private var carrySize = 0
    private var dryRing = ByteArray(0)
    private var dryIndex = 0

    override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        // 只处理 16bit。走到别的编码说明链路和预期不一样（见文件头第 3 条），
        // 这时返回 NOT_SET 让 media3 把这条 processor 摘掉：宁可 EQ 不生效，也不能让播放失败。
        //
        // 摘链是**静默**的：没有异常、没有日志，表现只是「这首歌没有 EQ」。所以这里记一笔，
        // 开发者面板上 dspBypassCount > 0 就是这件事发生过的证据（见 AudioPipelineTelemetry）。
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            AudioPipelineTelemetry.noteDspBypassed()
            AudioPipelineTelemetry.noteDspConfigured(false)
            return AudioProcessor.AudioFormat.NOT_SET
        }
        AudioPipelineTelemetry.noteDspConfigured(true)
        sampleRate = inputAudioFormat.sampleRate
        channels = inputAudioFormat.channelCount.coerceAtLeast(1)
        carry = ByteArray(2 * channels)
        carrySize = 0
        raw = ByteArray(0)
        scratch = FloatArray(0)

        frontEq.configure(sampleRate)
        postEq.configure(sampleRate)
        compressor.configure(sampleRate)
        saturation.configure(sampleRate)
        stereo.configure(sampleRate)
        reverb.configure(sampleRate, channels)
        mastering.configure(sampleRate, channels)
        studio.configure(sampleRate, channels)
        spectrum.configure(sampleRate)
        dynamics.configure(sampleRate, DSP_BLOCK_FRAMES)
        limiter.configure(sampleRate, channels)
        dryRing = ByteArray(limiter.delayFrames * 2 * channels)

        // 先取一份参数再清状态：第一块音频直接落在目标增益上，不从 0 dB 淡进来。
        settings = EqSettings.NEUTRAL
        pullSettings(state.snapshot())
        resetStages(primeGains = true)
        return inputAudioFormat
    }

    override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
        carrySize = 0
        // seek / 换源 / 单曲循环：把滤波器与混响的尾巴清掉，否则新位置会拖着旧信号。
        resetStages(primeGains = true)
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        val incoming = inputBuffer.remaining()
        if (incoming <= 0) return

        if (channels <= 0) {
            // 还没 configure（理论上不会发生）：原样交出去，别丢数据。
            val out = replaceOutputBuffer(incoming)
            out.put(inputBuffer)
            out.flip()
            return
        }

        syncSettings()

        val frameBytes = 2 * channels
        val total = carrySize + incoming
        val frames = total / frameBytes
        if (frames <= 0) {
            // 连一帧都凑不齐：全留在 carry 里等下一拍（carry 就是一帧的容量）。
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

        val sampleCount = frames * channels

        // A/B 对比：工作室里的 compare 打开时，输出同一时轴上的干声，湿声链保持运行（频谱照常显示）。
        // 这样用户能在「调音后」与「原声」间无缝切换，判断调音到底有没有变好听。
        val abCompare = settings.mastering.studio.scene.compare
        // 关掉、或打开但全平且没有音效：按字节直通，输出与输入逐字节相同。
        // 频谱是「看」不是「听」，直通时照样取样 —— 否则关了效果就看不到曲线，很奇怪。
        //
        // A/B 固定为原声时不能走这条无延迟的直通：开关最后一个实际 DSP（或把它调平）会让输出在
        // 「无延迟」与「延迟 delayFrames 帧」之间切换，表现为头 delayFrames 帧静音、回平又跳 delayFrames 帧。
        // 所以 A/B 开着时，平的/关掉的链也只输出等延迟的干声；干声环在任何状态下都保持最新。
        if (!settings.enabled || settings.isFlat()) {
            AudioPipelineTelemetry.noteDspPassthroughFrames(frames)
            pushDry(used, exchange = abCompare)
            if (state.spectrumEnabled) {
                ensureScratch(sampleCount)
                pcm.decode(raw, sampleCount, scratch)
                pushSpectrumBlocks(frames)
            }
            val out = replaceOutputBuffer(used)
            out.put(raw, 0, used)
            out.flip()
            return
        }

        ensureScratch(sampleCount)
        pcm.decode(raw, sampleCount, scratch)
        // Keep both timelines warm. Only exchange the original bytes after decoding the wet input.
        pushDry(used, exchange = abCompare)
        AudioPipelineTelemetry.noteDspFrames(frames)

        var frame = 0
        while (frame < frames) {
            val block = minOf(DSP_BLOCK_FRAMES, frames - frame)
            // 计时只包住 processBlock：解码、量化、抖动不算在「处理器负载」里，那几项是固定成本。
            val startedAt = System.nanoTime()
            processBlock(frame, block)
            AudioPipelineTelemetry.noteDspCost(System.nanoTime() - startedAt, block, sampleRate)
            frame += block
        }

        val out = replaceOutputBuffer(used)
        if (abCompare) {
            out.put(raw, 0, used)
            if (state.spectrumEnabled) {
                pcm.decode(raw, sampleCount, scratch)
                pushSpectrumBlocks(frames)
            }
        } else pcm.encode(scratch, sampleCount, out)
        out.flip()
    }

    /**
     * 把 [scratch] 里已解码的前 [frames] 帧按 DSP 块长（128 帧，小于频谱的 48 ms 间隔）切开喂给频谱。
     * 干声直通与 A/B 原声路径一次拿到整个 queueInput（可达数千帧），而一次 push 只会报告一帧新频谱；
     * 切块后每 48 ms 的音频恰好发布一帧，与湿声链一致。
     */
    private fun pushSpectrumBlocks(frames: Int) {
        var frame = 0
        while (frame < frames) {
            val block = minOf(DSP_BLOCK_FRAMES, frames - frame)
            if (spectrum.push(scratch, frame * channels, block, channels)) state.publishSpectrum(spectrum.bands)
            frame += block
        }
    }

    /**
     * 把本块的原始字节写进干声环（与湿声链的限幅延迟等长）。exchange 为真时把环里 delayFrames 帧之前的
     * 字节换进 [raw]，输出的就是等延迟的原声；为假时只写环、[raw] 不变。
     */
    private fun pushDry(used: Int, exchange: Boolean) {
        if (dryRing.isEmpty()) return
        var pos = 0
        while (pos < used) {
            val n = minOf(used - pos, dryRing.size - dryIndex)
            if (exchange) {
                for (i in 0 until n) {
                    val incomingByte = raw[pos + i]
                    raw[pos + i] = dryRing[dryIndex + i]
                    dryRing[dryIndex + i] = incomingByte
                }
            } else raw.copyInto(dryRing, dryIndex, pos, pos + n)
            dryIndex = (dryIndex + n) % dryRing.size
            pos += n
        }
    }

    /** 只在本进程里读快照；seq 没变就什么都不做（每 128 帧调一次，必须便宜）。 */
    private fun syncSettings() {
        val snapshot = state.snapshot()
        if (snapshot.seq == seenSeq) return

        val wasEnabled = settings.enabled
        val wasBypassed = settings.isFlat()
        val crossfeedWasActive = settings.stereo.enabled && settings.stereo.crossfeed > 0f
        val previousReverb = settings.reverb
        pullSettings(snapshot)

        // 开/关切换：清掉旧状态。开启时增益从 0 dB 滑上来（Web 也是滑入），不硬切。
        // 干声环不在这里清：它与开关无关，清了就是 A/B 固定原声时的一段静音。
        if (wasEnabled != snapshot.enabled || (wasBypassed && !snapshot.isFlat())) {
            resetStages(primeGains = !snapshot.enabled, clearDry = false)
        }
        if (crossfeedWasActive && (!snapshot.stereo.enabled || snapshot.stereo.crossfeed <= 0f)) stereo.reset()
        // 混响从开到关：把尾巴留在缓冲里自然落下去，下一次打开不会突然接上旧房间。
        if (previousReverb.enabled && !snapshot.reverb.enabled) {
            reverb.reset()
        }
    }

    /** 把快照里的参数搬进目标值。**不动滤波器状态** —— 状态只在开关切换与 flush 时清。 */
    private fun pullSettings(snapshot: EqSettings) {
        seenSeq = snapshot.seq
        settings = snapshot
        snapshot.gains.copyInto(targetGains)
        targetGlobalGainDb = snapshot.globalGainDb
        applyPostEqNext = true

        // 限幅器的两个旋钮存的是物理量（dBFS / ms），限幅器本身要线性增益与秒。
        // 在这里换而不是在 process 里换：每块一次 pow 就够了，不该逐样本做。
        limiter.ceiling = 10f.pow(snapshot.limiter.ceilingDb.coerceIn(-6f, 0f) / 20f)
        limiter.releaseSeconds = snapshot.limiter.releaseMs.coerceIn(40f, 500f) / 1000f

        val glideSeconds = snapshot.glideMs.coerceIn(5, 1000) / 1000f
        smoothingCoef = if (sampleRate > 0) {
            (1.0 - exp(-DSP_BLOCK_FRAMES.toDouble() / (glideSeconds * sampleRate))).toFloat()
        } else {
            1f
        }
    }

    private fun resetStages(primeGains: Boolean, clearDry: Boolean = true) {
        frontEq.reset()
        postEq.reset()
        highPass.reset()
        lowPass.reset()
        dynamics.reset()
        compressor.reset()
        saturation.reset()
        stereo.reset()
        reverb.reset()
        mastering.reset()
        studio.reset()
        spectrum.reset()
        limiter.reset()
        if (clearDry) { dryRing.fill(0); dryIndex = 0 }
        snapGainsNext = false
        applyPostEqNext = true
        if (primeGains) {
            targetGains.copyInto(smoothedGains)
            smoothedGlobalGainDb = targetGlobalGainDb
        } else {
            smoothedGains.fill(0f)
            smoothedGlobalGainDb = 0f
        }
    }

    private fun processBlock(startFrame: Int, blockFrames: Int) {
        smoothGains()

        val offset = startFrame * channels
        val count = blockFrames * channels

        val compensate = settings.mastering.compensation.enabled
        val reference = if (compensate) meanPower(scratch, offset, count) else 0f

        // ① 前置十段
        frontEq.update(smoothedGains, settings.mode, settings.q, smoothedGlobalGainDb)
        if (frontEq.isActive()) frontEq.process(scratch, offset, blockFrames, channels)

        // ② 高通 / 低通（Web 的 highpass / lowpass）
        highPass.setHighPass(sampleRate, settings.highpassHz, SHELF_Q)
        lowPass.setLowPass(sampleRate, settings.lowpassHz, SHELF_Q)
        if (highPass.active || lowPass.active) {
            for (index in 0 until count) {
                val channel = index % channels
                var sample = scratch[offset + index]
                sample = highPass.process(sample, channel)
                sample = lowPass.process(sample, channel)
                scratch[offset + index] = sample
            }
        }

        // ③ punch（Web 遗留）+ 自动 headroom
        dynamics.processPunch(scratch, offset, blockFrames, channels, settings.punch, preGain)

        // ④ 四段压缩
        if (settings.compressor.enabled) {
            compressor.process(scratch, offset, blockFrames, channels, settings.compressor)
        }

        // ⑤ 后置十段
        val post = settings.postEq
        if (post.enabled) {
            if (applyPostEqNext) {
                postEq.update(post.gains, post.mode, post.q, post.globalGainDb)
                applyPostEqNext = false
            }
            if (postEq.isActive()) postEq.process(scratch, offset, blockFrames, channels)
        }

        // ⑥ 饱和 / 染色：只加谐波，不改频响（那是两个 EQ 的事）。
        if (settings.saturation.enabled) {
            saturation.process(scratch, offset, blockFrames, channels, settings.saturation)
        }

        // ⑦ 声场宽度与低频单声道：只改干声的侧向分量，必须放在混响之前 ——
        //    混响自己的梳状延时线已经有声道差，再拉一次会像两个房间叠在一起。
        stereo.process(scratch, offset, blockFrames, channels, settings.stereo)

        // ⑧ 混响：新参数优先，没开时退回 Web 的 space
        reverb.process(scratch, offset, blockFrames, channels, settings.space, settings.reverb)

        // ⑧.5 母带台：混响之后、限幅之前。修复/塑造/增强十项，其中损失补偿按最终
        //      输出电平把响度补回 —— 必须在这里（限幅之前），补完再由限幅兜住峰值。
        mastering.process(scratch, offset, blockFrames, channels, settings.mastering)

        // ⑧.6 工作室台：母带之后、限幅之前。响度标准化 / 修复 / 进阶效果 / 智能场景。
        //      标准化缓慢调节 RMS 电平，同样在限幅前，补完由限幅兜峰值。
        studio.process(scratch, offset, blockFrames, channels, settings.mastering.studio)

        if (compensate) mastering.compensate(scratch, offset, blockFrames, channels, reference)

        // ⑨ 前瞻限幅：整条链最后一步。波形不弯，只乘一个慢变增益。
        limiter.process(scratch, offset, blockFrames, channels)

        // ⑩ 频谱（只读）
        if (!settings.mastering.studio.scene.compare && state.spectrumEnabled && spectrum.push(scratch, offset, blockFrames, channels)) {
            state.publishSpectrum(spectrum.bands)
        }
    }

    /**
     * 增益滑向目标。
     *
     * 第一次跑（configure / 刚开启）直接落到目标，否则从静音开始会听到一声「淡入」。
     */
    private fun smoothGains() {
        if (snapGainsNext) {
            targetGains.copyInto(smoothedGains)
            smoothedGlobalGainDb = targetGlobalGainDb
            snapGainsNext = false
            // 冷启动也要算一次：漏掉这一步，第一块会按 preGain = 1 处理，直接顶到限幅器上。
            updatePreGain()
            return
        }
        val coefficient = smoothingCoef
        for (index in 0 until EQ_BAND_COUNT) {
            val target = targetGains[index]
            val current = smoothedGains[index]
            if (target == current) continue
            smoothedGains[index] = current + (target - current) * coefficient
        }
        if (targetGlobalGainDb != smoothedGlobalGainDb) {
            smoothedGlobalGainDb += (targetGlobalGainDb - smoothedGlobalGainDb) * coefficient
        }
        updatePreGain()
    }

    /**
     * 自动 headroom：把十段里最大的提升量（前后两个 EQ 取大的）折回一部分，
     * 免得 16bit 中间态在进限幅器之前就先削顶。
     *
     * 只折 [HEADROOM_TRIM] 的比例：剩下的交给前瞻限幅器按实际峰值处理，
     * 安静段落因此不会被「预设好的一刀」白砍掉动态。
     */
    private fun updatePreGain() {
        var maxBoost = 0f
        for (index in 0 until EQ_BAND_COUNT) {
            if (smoothedGains[index] > maxBoost) maxBoost = smoothedGains[index]
            val post = settings.postEq.gains[index]
            if (post > maxBoost) maxBoost = post
        }
        val excess = (maxBoost - MAX_UNCOMPENSATED_BOOST_DB).coerceAtLeast(0f)
        preGain = dbToLinear(-excess * HEADROOM_TRIM)
    }

    private fun ensureScratch(sampleCount: Int) {
        if (scratch.size < sampleCount) scratch = FloatArray(sampleCount)
    }

    private companion object {
        /** 高通 / 低通的 Q。0.7 接近 Butterworth：切得干净，又没有明显的隆起。 */
        const val SHELF_Q = 0.7f
    }
}
