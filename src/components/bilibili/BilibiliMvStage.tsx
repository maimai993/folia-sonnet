import React from 'react';
import type { MotionValue } from 'framer-motion';
import { isBilibiliAvailable } from '../../services/bilibili/transport';

const BilibiliMvBackground = React.lazy(() => import('./BilibiliMvBackground'));

// src/components/bilibili/BilibiliMvStage.tsx
// 把这首歌对应的 bilibili 投稿画面铺在播放页上，声音仍然是歌曲本身。
//
// 它**不是歌词样式**：以前走 defineVisualizer 注册成一个样式，于是 MV 只能从「歌词样式」
// 列表里选，和「背景」这件事无关。现在它是播放页自己的一个背景开关（见 useBilibiliMvSettingsStore），
// 由 AppSurface 在播放页上挂一份，和歌词样式互不影响。
//
// 只在安卓 App 内可用 —— api.bilibili.com 不给 CORS 头，WebView 直连一定被拦，
// 安卓那边靠 FoliaBilibili 插件用 OkHttp 代发（见 services/bilibili/transport.ts）。

/** 歌曲的缓存键：`歌名|||歌手`，忽略大小写和多余空格。 */
export const songKeyOf = (
    title: string | null | undefined,
    artist: string | null | undefined,
): string => `${(title ?? '').trim().toLowerCase()}|||${(artist ?? '').trim().toLowerCase()}`;

export type BilibiliMvStageProps = {
    songTitle?: string | null;
    songArtist?: string | null;
    currentTime: MotionValue<number>;
    duration?: number;
    paused?: boolean;
};

/**
 * 播放页上的 MV 背景层。
 *
 * 整块铺满、`pointer-events-none`：点击要能穿到底下的播放页画面上（点空白收界面、
 * 点歌词跳转都由那一层管），这里只负责画画。
 */
const BilibiliMvStage: React.FC<BilibiliMvStageProps> = ({
    songTitle,
    songArtist,
    currentTime,
    duration,
    paused,
}) => (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <React.Suspense fallback={null}>
            <BilibiliMvRenderer
                songKey={songKeyOf(songTitle, songArtist)}
                songTitle={songTitle ?? ''}
                songArtist={songArtist ?? ''}
                currentTime={currentTime}
                duration={duration ?? 0}
                paused={paused ?? false}
            />
        </React.Suspense>
    </div>
);

export default BilibiliMvStage;

/**
 * 把 MotionValue 的时钟折成普通数字再喂给视频层。
 *
 * 视频层的同步逻辑要「读一次当前值、决定跳不跳」，用 number 最直接。
 * 这里用 framer-motion 的 useMotionValue 订阅，节流到约 20Hz ——
 * 视频本身 24~30fps，比这更密的更新没有意义，反而让 React 白跑。
 */
const BilibiliMvRenderer: React.FC<{
    songKey: string;
    songTitle: string;
    songArtist: string;
    currentTime: MotionValue<number>;
    duration: number;
    paused: boolean;
}> = ({ songKey, songTitle, songArtist, currentTime, duration, paused }) => {
    const clock = useTimeTicker(currentTime, paused);
    // 没有原生桥时别放视频、也别打接口，直接说清楚为什么。
    if (!isBilibiliAvailable()) {
        return (
            <div className="absolute inset-0 flex items-center justify-center bg-black">
                <span className="px-6 text-center text-sm text-white/45">
                    B 站 MV 只在安卓 App 内可用
                </span>
            </div>
        );
    }

    return (
        <BilibiliMvBackground
            songKey={songKey}
            songTitle={songTitle}
            songArtist={songArtist}
            currentTime={clock}
            duration={duration}
            isPlaying={!paused}
        />
    );
};

/** 订阅 MotionValue，按 20Hz 吐一个新数字；暂停时停止更新（省电、也不白算）。 */
const useTimeTicker = (value: MotionValue<number>, paused: boolean): number => {
    const [tick, setTick] = React.useState(() => value.get());

    React.useEffect(() => {
        if (paused) {
            // 暂停时同步一次末值，之后不再更新。
            setTick(value.get());
            return;
        }
        let frame = 0;
        let lastEmit = 0;
        const MIN_INTERVAL_MS = 50;
        const loop = (now: number) => {
            if (now - lastEmit >= MIN_INTERVAL_MS) {
                lastEmit = now;
                setTick(value.get());
            }
            frame = requestAnimationFrame(loop);
        };
        frame = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(frame);
    }, [value, paused]);

    return tick;
};
