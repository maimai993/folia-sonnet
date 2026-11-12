import React from 'react';
import type { MotionValue } from 'framer-motion';
import { defineVisualizer } from '../definition';
import { isBilibiliAvailable } from '../../../services/bilibili/transport';
import BilibiliMvSettingsPanel from './BilibiliMvSettingsPanel';

const BilibiliMvBackground = React.lazy(() => import('./BilibiliMvBackground'));

// src/components/visualizer/bilibili/entry.tsx
// 注册「B 站 MV」背景：把这首歌对应的 bilibili 投稿画面铺满播放页，声音仍然是歌曲本身。
//
// 只在安卓 App 内可用 —— api.bilibili.com 不给 CORS 头，WebView 直连一定被拦，
// 安卓那边靠 FoliaBilibili 插件用 OkHttp 代发（见 services/bilibili/transport.ts）。
//
// 画面怎么和歌曲对齐：见 BilibiliMvBackground.tsx。这里只负责把歌曲时钟、
// 播放状态和歌名歌手喂进去。

/** 歌曲的缓存键：`歌名|||歌手`，忽略大小写和多余空格。 */
export const songKeyOf = (
    title: string | null | undefined,
    artist: string | null | undefined,
): string => `${(title ?? '').trim().toLowerCase()}|||${(artist ?? '').trim().toLowerCase()}`;

export default defineVisualizer({
    mode: 'bilibili',
    order: 28,
    labelKey: 'ui.visualizerBilibili',
    labelFallback: 'B 站 MV',
    previewSeed: 'bilibili',
    previewStartOffset: 0,
    // 一卷胶片：MV 的意思。
    glyph: (
        <>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 5v14M17 5v14" opacity="0.6" />
            <path d="M10.5 9.5l4 2.5-4 2.5z" />
        </>
    ),
    command: {
        title: 'Visualizer: Bilibili MV',
        description: "Play the song's bilibili MV behind the lyrics",
        keywords: ['bilibili', 'bili', 'mv', 'video', 'b站', 'b 站', 'mv 背景'],
    },
    // MV 是自己的一整块画面，不需要共享背景垫在底下。
    background: false,
    render: props => (
        <React.Suspense fallback={null}>
            <BilibiliMvStage
                songKey={songKeyOf(props.songTitle, props.songArtist)}
                songTitle={props.songTitle ?? ''}
                songArtist={props.songArtist ?? ''}
                currentTime={props.currentTime}
                duration={props.duration ?? 0}
                paused={props.paused ?? false}
            />
        </React.Suspense>
    ),
    // 设置面板：只有登录卡片 + 音画偏移。没有别的可调项。
    renderSettingsPanel: props => <BilibiliMvSettingsPanel {...props} />,
});

/**
 * 把 MotionValue 的时钟折成普通数字再喂给视频层。
 *
 * 视频层的同步逻辑要「读一次当前值、决定跳不跳」，用 number 最直接。
 * 这里用 framer-motion 的 useMotionValue 订阅，节流到约 20Hz ——
 * 视频本身 24~30fps，比这更密的更新没有意义，反而让 React 白跑。
 */
const BilibiliMvStage: React.FC<{
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
