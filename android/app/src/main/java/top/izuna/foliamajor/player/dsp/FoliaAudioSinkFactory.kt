package top.izuna.foliamajor.player.dsp

import android.content.Context
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink

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
) : DefaultRenderersFactory(context) {

    override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioTrackPlaybackParams: Boolean,
    ): AudioSink = DefaultAudioSink.Builder(context)
        // 坑 1：不看入参，永远 false。
        .setEnableFloatOutput(false)
        .setEnableAudioOutputPlaybackParameters(enableAudioTrackPlaybackParams)
        // 显式写出元素类型：Kotlin 的 Array<EqAudioProcessor> 不会自动变 Array<AudioProcessor>。
        .setAudioProcessors(arrayOf<AudioProcessor>(EqAudioProcessor(state)))
        .build()
}
