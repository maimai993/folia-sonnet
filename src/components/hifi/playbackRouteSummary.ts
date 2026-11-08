import type { HifiSignalPath } from '../../types/hifi';
import { isCapacitorAndroid } from '../../platform/runtime';
import type { webAudioSignal } from './webAudioSignal';

// 信号链路入口和 Web 面板上的一词概括：原生直通 / 原生处理 / 原生（未确认）/ 转码播放 / Web 引擎 / 原生播放；没有音频时为 null。

export type PlaybackRouteSummary = 'nativePassthrough' | 'nativeProcessed' | 'nativeUnconfirmed' | 'transcoded' | 'webEngine' | 'nativePlayer';

/** HiFi 路线按结论分直通和处理（经 PipeWire 的采样率直通也算处理）；Web 路线按当前源是不是 Folia 的转码副本分。 */
export const playbackRouteSummary = (
    hifiPath: HifiSignalPath | null,
    web: ReturnType<typeof webAudioSignal>,
): PlaybackRouteSummary | null => {
    if (hifiPath) {
        if (hifiPath.verdict === 'bit-perfect' || hifiPath.verdict === 'dop') return 'nativePassthrough';
        return hifiPath.verdict === 'unknown' ? 'nativeUnconfirmed' : 'nativeProcessed';
    }
    /*
     * 安卓的 App 壳里两条桌面路线都不存在：没有 mpv，出声的也不是 Web Audio 图，而是
     * ExoPlayer（FoliaNativePlayer）。以前这里一路落到 webEngine，牌子就写着「Web 引擎」——
     * 那是在描述一条根本没在跑的链路，用户看到只会更糊涂。
     *
     * 判断放在 hifiPath 之后、transcode 之前：转码是这条链路上的一件事（转码后照样由
     * ExoPlayer 播），不该被单独当成一条路线。
     */
    if (isCapacitorAndroid()) return 'nativePlayer';
    if (web.transcode === 'transcoded') return 'transcoded';
    return web.transcode === 'notTranscoded' ? 'webEngine' : null;
};
