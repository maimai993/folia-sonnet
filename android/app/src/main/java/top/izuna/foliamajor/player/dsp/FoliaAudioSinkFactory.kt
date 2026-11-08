package top.izuna.foliamajor.player.dsp

import android.content.Context
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import top.izuna.foliamajor.player.transition.dsp.DeckRole
import top.izuna.foliamajor.player.transition.dsp.TransitionDspProcessor

// android/app/src/main/java/top/izuna/foliamajor/player/dsp/FoliaAudioSinkFactory.kt
// 把 EQ 处理器挂进 ExoPlayer 的唯一出口：所有播放器都必须经这里造 AudioSink。
//
// 为什么必须是这一层：ExoPlayer 解码后的 PCM 走 AudioSink → AudioTrack，WebView 的
// Web Audio 图完全不在这条路上。要改声音，只有在 AudioSink 里插 AudioProcessor 一条路。
//
// ⚠️⚠️ 两条「写了但不生效」的坑，都是读 media3 1.11.1 字节码确认过的：
//
//   1. setEnableFloatOutput 必须是 false。
//      DefaultAudioSink.configure() 装配处理器链的分支是：
//          shouldUseFloatOutput = enableFloatOutput && Util.isEncodingHighResolutionPcm(输入编码)
//          if (shouldUseFloatOutput) { ... + ToFloatPcmAudioProcessor }        // 没有用户处理器
//          else                      { ... + ToInt16PcmAudioProcessor + audioProcessorChain.getAudioProcessors() }
//      注意用户处理器只出现在 else 分支 —— 打开 float 输出后，24bit FLAC 会让整条链（包括 EQ）
//      从管线里消失，表现是「有些歌有 EQ，有些没有」。所以这里不看入参，永远传 false。
//      代价是高解析度源会先降到 16bit 再进链（ToInt16 排在用户处理器之前，顺序改不了）。
//
//   2. 自定义 processor 排在 SilenceSkipping 与 Sonic 之前（DefaultAudioProcessorChain 的顺序）。
//      好处：倍速 / 静音跳过照旧工作；副作用：EQ 在变速之前处理。不需要与 Web 逐样本等价。
//
// 关于 offload：1.11 的 DefaultAudioSink.Builder 已经没有 setOffloadMode（那是 1.2 时代的 API），
// 本项目也没有任何地方开启音频 offload，所以 processor 一定参与。**以后要开 offload 之前先想清楚**：
// offload 把压缩流直接交给 DSP，processor 整条会被绕过，EQ 会静默失效。

@UnstableApi
class FoliaAudioSinkFactory(
    context: Context,
    private val state: NativeEqualizerState,
    /**
     * 原生过渡系统的 PCM 处理器角色提供者。null = 不挂过渡处理器，行为与改动前完全一致。
     * FoliaNativePlayer 为每台播放器各持有一个 AtomicReference，过渡期间动态切换
     * INCOMING / OUTGOING / INACTIVE（见 transition/dsp/TransitionDspProcessor.kt）。
     */
    private val transitionRoleProvider: (() -> DeckRole)? = null,
) : DefaultRenderersFactory(context) {

    init {
        /*
         * 硬件解码器失败时允许回退到软解。
         *
         * 默认是关的：某个 ROM 的 MediaCodec 声明支持某种编码、实际初始化失败（或者
         * 只支持到 48 kHz 而源是 96 kHz），播放器就直接抛 DecoderInitializationException，
         * 表现是「这首歌在这台手机上永远播不了」。打开之后 media3 会按 硬件 → 软解 的顺序
         * 再试一次，代价只是那一次初始化慢几十毫秒。
         */
        setEnableDecoderFallback(true)
    }

    override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioTrackPlaybackParams: Boolean,
    ): AudioSink {
        // 过渡处理器排在 EQ 之后：EQ 先定音色，过渡链再做换手 / 扫频 / 回声，
        // 否则换手时两路的 EQ 状态会互相干扰。
        // 显式写出元素类型：Kotlin 的 Array<EqAudioProcessor> 不会自动变 Array<AudioProcessor>。
        val processors: Array<AudioProcessor> = if (transitionRoleProvider != null) {
            arrayOf<AudioProcessor>(EqAudioProcessor(state), TransitionDspProcessor(transitionRoleProvider))
        } else {
            arrayOf<AudioProcessor>(EqAudioProcessor(state))
        }
        return DefaultAudioSink.Builder(context)
            // 坑 1：不看入参，永远 false。
            .setEnableFloatOutput(false)
            .setEnableAudioOutputPlaybackParameters(enableAudioTrackPlaybackParams)
            .setAudioProcessors(processors)
            .build()
    }
}
