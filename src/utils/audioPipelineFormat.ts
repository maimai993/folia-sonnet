import type { AudioPipelineReading } from '../services/audioPipelineDiagnostics';

// src/utils/audioPipelineFormat.ts
//
// 把一次原生音频链路读数拍平成「标签 → 值」的行。
//
// 两个地方要显示同一批数字：桌面/键盘可开的开发者浮层（Perf 页），和手机上的
// 设置 → 开发者选项（安卓没有键盘，浮层打不开，见 PerfDebugPanel 的说明）。
// 格式化只写一份，两边看到的数是同一份，不会出现「这边 16bit 那边 24bit」。

export type AudioPipelineRow = { label: string; value: string };

const khz = (rate: number): string => (rate > 0 ? `${rate}Hz` : 'n/a');
const kbps = (value: number): string => (value > 0 ? `${value}kbps` : 'n/a');

export const audioPipelineRows = (reading: AudioPipelineReading): AudioPipelineRow[] => [
    {
        label: 'source',
        value: [
            reading.inputMime || 'n/a',
            reading.inputCodecs || null,
            kbps(reading.inputBitrateKbps),
        ].filter(Boolean).join(' · '),
    },
    {
        // 解码器交出来的 PCM —— 高解析度源被降位就发生在这里。
        label: 'decoded',
        value: `${khz(reading.inputSampleRate)} · ${reading.inputPcm} · ${reading.inputChannels > 0 ? `${reading.inputChannels}ch` : 'n/a'}`,
    },
    {
        // 处理器链在不在、跑过多少帧、被静默摘链几次。
        label: 'dsp',
        value: `${reading.dspActive ? 'in chain' : 'bypassed'} · ${(reading.dspFrames / 1e6).toFixed(1)}M frames · bypass ${reading.dspBypassCount}`,
    },
    {
        /*
         * 处理器自己花了多少时间。
         *
         * 这一行是「CPU 高到底是音频重还是画面重」的分界线：load 是相对**播放这一块
         * 音频本身需要的时间**的占比（100% = 刚好跑得及），p99 远高于 p50 说明是长尾
         * （某一段效果器偶发变慢），两个都高才是整条链太重。
         */
        label: 'dsp cost',
        value: reading.dspCostP50Us === undefined
            ? 'n/a'
            : `${(reading.dspCostP50Us / 1000).toFixed(2)}ms/block · p99 ${((reading.dspCostP99Us ?? 0) / 1000).toFixed(2)}ms · load ${(reading.dspLoadPercent ?? 0).toFixed(0)}%`,
    },
    {
        // 真正交给声卡的格式 —— 设备不支持源采样率时这里会看到别的值。
        label: 'output',
        value: [
            khz(reading.trackSampleRate),
            reading.trackPcm,
            reading.trackBufferMs > 0 ? `buffer ${reading.trackBufferMs.toFixed(0)}ms` : null,
            reading.trackOffload ? 'offload' : null,
            reading.trackTunneling ? 'tunneling' : null,
        ].filter(Boolean).join(' · '),
    },
    {
        label: 'underruns',
        value: `${reading.underrunCount} (${(reading.underrunBytes / 1024).toFixed(0)}KB) · sink errors ${reading.sinkErrorCount}${reading.lastSinkError ? ` · ${reading.lastSinkError}` : ''}`,
    },
    {
        // cpu 是「相对单核」的百分比（两次采样之间的增量），多线程跑满会超过 100。
        label: 'cost',
        value: `cpu ${reading.cpuPercent === null ? 'n/a' : `${reading.cpuPercent.toFixed(0)}%`} / ${reading.cpuCores} cores · tick ${reading.positionTickHz === null ? 'n/a' : `${reading.positionTickHz.toFixed(2)}Hz`} · ${reading.interactive ? 'screen on' : 'screen off'}`,
    },
    {
        label: 'battery',
        value: `${reading.batteryPercent >= 0 ? `${reading.batteryPercent}%` : 'n/a'} · ${reading.batteryCurrentMa !== 0 ? `${reading.batteryCurrentMa}mA` : 'n/a'}`,
    },
    {
        label: 'players',
        value: `${reading.players}${reading.dspPassthroughFrames > 0 ? ` · passthrough ${(reading.dspPassthroughFrames / 1e6).toFixed(1)}M` : ''}`,
    },
];
