import React from 'react';
import { clearLyricon, publishLyriconPosition, publishLyriconSong } from '../platform/foliaLyricon';
import { isCapacitorAndroid } from '../platform/runtime';
import { useLyriconStore } from '../stores/useLyriconStore';
import type { Line } from '../types';

// src/hooks/useLyriconFeed.ts
// 把当前歌曲与歌词推给状态栏歌词（Lyricon）。
//
// 分工和歌词壁纸正好相反：**段内的推进由中心服务自己算。**
//
// 原生送一份带速度的 `PlaybackState`（位置 + speed + 时间戳），中心服务拿到之后
// 按 `position + (now - updateTime) * speed` 自己往前推。我们在段内一句话都不说，
// 只在离散事件上告诉它"现在在哪、以多快在走"：
// 换歌 / 播放暂停 / 拖动进度条 / 回前台 / 转屏，外加一道 10 秒的慢速重锚保险。
//
// 为什么不按节拍灌位置：每灌一次就把中心服务自己的推算拽回应用的实际位置，
// 两边时钟差几十毫秒就够看出来 —— 那就是"抽搐"。
//
// 两条硬约束（都是踩过的坑）：
//   1. **setSong 之后必须补位置**，而且必须等它做完（await）再补 ——
//      它会重置中心服务的显示状态，位置先到就会被冲掉。
//   2. 原生的 `setPlaybackState` 必须写在 `setPosition` **前面**，理由同上。
//   3. 不要用"漂移"决定推不推：中心服务没有回读通道，我们算不出它现在到哪了
//      （能算的只有应用自己有没有卡，正常播放时恒为 0）→ 门槛永不满足 → 不动。

/** 多久看一眼"进度跳了没有"。只是看一眼，不是推送节拍。 */
const SEEK_CHECK_INTERVAL_MS = 500;
/**
 * 判定「这是一次跳转」的跨度（毫秒）。
 *
 * 正常播放一个采样周期只走 500ms；差出 2 秒就只可能是拖动进度条或跳到了别的歌。
 * 只有这种时候才立刻推送。
 */
const SEEK_JUMP_MS = 2000;
/**
 * 慢速重锚间隔（毫秒）。
 *
 * 它**不是**段内推进的来源 —— 那是原生心跳的活（见 FoliaLyricon.heartbeatTask，
 * 每 5 秒按锚点自己往前推，JS 冻住也照走）。这一条只用来修漂移：
 * 卡顿、缓冲、倍速之类的偏差，锚点始终在原生手里，不校正就会一直偏下去。
 *
 * 两个约束：
 *   1. **只在可见时跑。** 后台本来就会被系统挂起，指望不上；
 *      真在后台，原生那边照样在走，不需要它。
 *   2. **必须标 continuous。** 不标的话原生那边按跨度会判定这是一次 seek，
 *      于是中心服务每隔 10 秒重启一次显示状态去追位置 —— 那就是抽搐。
 */
const REANCHOR_INTERVAL_MS = 10000;

type UseLyriconFeedOptions = {
    lyrics: { lines: Line[] } | null;
    getCurrentTime: () => number;
    title: string | null;
    artist: string | null;
    /** 歌曲的唯一标识，用来让中心服务判断换没换歌。 */
    songId?: string | null;
    duration?: number;
    playerState: string;
};

export const useLyriconFeed = ({
    lyrics,
    getCurrentTime,
    title,
    artist,
    songId,
    duration,
    playerState,
}: UseLyriconFeedOptions): void => {
    const enabled = isCapacitorAndroid();
    const lyriconEnabled = useLyriconStore(state => state.enabled);
    const active = enabled && lyriconEnabled;

    const playing = playerState === 'PLAYING';
    const latest = React.useRef({ playing });
    latest.current.playing = playing;
    /**
     * 最新一次的"整首推送"。
     *
     * 用 ref 而不是把那段逻辑直接写进事件回调的依赖里：可见性/转屏回调只需要
     * 拿到当前最新的函数，重新订阅整段推送逻辑反而会让监听器反复挂上摘掉。
     */
    const publishSongRef = React.useRef<(() => void) | null>(null);

    // 启动时把开关同步给原生：原生那边的状态是进程级的，应用重启后要重新注册一次。
    React.useEffect(() => {
        if (!enabled) return;
        useLyriconStore.getState().syncLyriconStatus();
    }, [enabled]);

    // 关掉开关时清一次，别让状态栏停在上一首的歌词上。
    React.useEffect(() => {
        if (enabled && !lyriconEnabled) {
            void clearLyricon();
        }
    }, [enabled, lyriconEnabled]);

    /**
     * 把整首（歌名 + 全量歌词）推给中心服务。
     * 换歌、回到前台、转屏都要用同一份，抽出来避免两处各写一遍然后慢慢长歪。
     */
    const publishSong = React.useCallback(async () => {
        const lines = lyrics?.lines ?? [];
        // **必须 await**：setSong 会重置中心服务的显示状态（位置也一起清掉），
        // 位置得等它真的做完再补。不 await 的话两个桥调用的到达顺序没有保证，
        // 位置先到就会被紧接着的 setSong 冲掉 —— 表现就是"换歌/回前台/转屏都没反应"。
        await publishLyriconSong({
            id: songId ?? null,
            title: title ?? '',
            artist: artist ?? '',
            durationMs: Math.max(0, Math.round((duration ?? 0) * 1000)),
            // 没有翻译的行干脆不带这个字段：带上 null 过桥会变成 JSONObject.NULL，
            // 而原生 optString 对 NULL 返回的是字符串 "null"，状态栏上就真显示 null 了。
            lines: lines.map((line) => {
                const translation = line.translation?.trim();
                return translation
                    ? {
                        text: line.fullText,
                        start: Math.round(line.startTime * 1000),
                        end: Math.round(line.endTime * 1000),
                        translation,
                    }
                    : {
                        text: line.fullText,
                        start: Math.round(line.startTime * 1000),
                        end: Math.round(line.endTime * 1000),
                    };
            }),
        });
    }, [lyrics, title, artist, songId, duration]);

    // 换歌（或歌词本身变了）时整首推过去 —— **并且立刻补一次位置**。
    React.useEffect(() => {
        if (!active) return;
        /*
         * 顺序是硬要求：setSong 会把中心服务的显示状态重置掉，
         * 只发歌词不发位置的话，状态栏会停在上一首的那个位置上不动。
         * 而且必须等 setSong 真的做完（await）再补，否则会被它冲掉。
         */
        void (async () => {
            await publishSong();
            void publishLyriconPosition(
                Math.round(getCurrentTime() * 1000), latest.current.playing);
        })();
    }, [active, publishSong, getCurrentTime]);

    /**
     * 推一次「现在在哪 + 以多快在走」。
     *
     * 只在这些时刻调用：换歌、播放/暂停翻转、拖动进度条、回前台、转屏。
     * 正常播放期间一次都不调。
     */
    const pushNow = React.useCallback(() => {
        void publishLyriconPosition(Math.round(getCurrentTime() * 1000), latest.current.playing);
    }, [getCurrentTime]);

    /** 同上，但标明「这只是正常播放的延续」，别让原生把它当成一次跳转。 */
    const pushContinuous = React.useCallback(() => {
        void publishLyriconPosition(
            Math.round(getCurrentTime() * 1000),
            latest.current.playing,
            { continuous: true });
    }, [getCurrentTime]);

    // 播放/暂停翻转、以及刚开始可用时。
    React.useEffect(() => {
        if (active) pushNow();
    }, [active, playing, pushNow]);

    /*
     * 段内**不按节拍喂位置** —— 那是原生心跳的活（见 REANCHOR_INTERVAL_MS 的说明）。
     *
     * 这里两件事：认出"拖动进度条"这个事件，以及一道只在可见时跑的慢速重锚。
     */
    React.useEffect(() => {
        if (!active) return;
        let sampleMs = getCurrentTime() * 1000;
        const seekTimer = window.setInterval(() => {
            const currentMs = getCurrentTime() * 1000;
            const step = Math.abs(currentMs - sampleMs);
            sampleMs = currentMs;
            // 拖动进度条 / 跳歌：真跳变，立刻对齐。
            if (step >= SEEK_JUMP_MS) {
                pushNow();
            }
        }, SEEK_CHECK_INTERVAL_MS);
        const reanchorTimer = window.setInterval(() => {
            // 后台跑不动（被挂起），也没必要跑（原生心跳在走）。
            if (latest.current.playing && document.visibilityState === 'visible') {
                pushContinuous();
            }
        }, REANCHOR_INTERVAL_MS);
        return () => {
            window.clearInterval(seekTimer);
            window.clearInterval(reanchorTimer);
        };
    }, [active, pushNow, pushContinuous, getCurrentTime]);

    /*
     * 回到前台（含解锁）时补推一次整首 + 位置。
     *
     * 应用在后台时 JS 是冻结的，一个字节都推不出去；而这段时间里中心服务那边的绑定
     * 可能已经掉了、显示状态也可能被系统重置。用户看到的就是「解锁后状态栏没歌词，
     * 非得按一下暂停/播放才回来」。所以这里在可见性变化时重新走一遍整首推送。
     */
    React.useEffect(() => {
        if (!active) return;
        // 同样必须等 setSong 做完再补位置，理由见 publishSong。
        const resync = () => {
            void (async () => {
                await publishSongRef.current?.();
                pushNow();
            })();
        };
        const handleVisibility = () => {
            if (document.visibilityState !== 'visible') return;
            resync();
        };
        /*
         * 转屏后状态栏也要重来一遍。
         *
         * 横竖屏切换会让 SystemUI 重建状态栏的视图，中心服务那边的显示状态跟着被重置 ——
         * 结果就是转屏之后歌词没了，得等下一次事件才回来。这里把转屏也当成一次
         * "事件同步"处理。
         *
         * resize 也一起听：有些机型转屏只发 resize 不发 orientationchange。
         * 两者可能连着来（转屏常常先 resize 再 orientationchange），
         * 合并到同一个时间片里只用推一次。
         */
        let pending = 0;
        const scheduleResync = () => {
            if (pending) window.clearTimeout(pending);
            pending = window.setTimeout(() => {
                pending = 0;
                resync();
            }, 250);
        };
        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('orientationchange', scheduleResync);
        window.addEventListener('resize', scheduleResync);
        return () => {
            if (pending) window.clearTimeout(pending);
            document.removeEventListener('visibilitychange', handleVisibility);
            window.removeEventListener('orientationchange', scheduleResync);
            window.removeEventListener('resize', scheduleResync);
        };
    }, [active, pushNow]);

    // 让可见性/转屏回调总是调用最新一版。
    React.useEffect(() => {
        publishSongRef.current = publishSong;
    }, [publishSong]);
};
