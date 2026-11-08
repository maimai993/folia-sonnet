// src/library/suites/rhine/RhineVisualOverlay.tsx
//
// 莱茵生命的可视化叠层：**整张展开的透明卡片**变成 Folia 的歌词可视化界面。
//
// ## 用的是桌面那一套
//
// 直接复用桌面播放页的装配：`useVisualizerRendererModel()` 出全套 props，
// 喂给同一个 `VisualizerRenderer`。不是另画一套简化版 —— 主题、歌词、背景、
// 逐字流光、动效设置全跟着用户的既有配置走，跟播放页看到的完全一致。
//
// 那个 hook 当初就是为了「多个宿主共用同一个渲染器」写的（注释里点名了
// VisPlayground / Theme Park / OBS），订阅边界在 hook 里，不在渲染器里。
//
// ## 位置为什么不写死
//
// 卡片在三维空间里，屏幕位置由相机投影决定，**不跟屏幕尺寸成比例**：横竖屏、
// 不同机型、相机拉近拉远都会变。第一版按 1920×864 的截图写死圆心和直径，
// 换机型就错位 —— 位置必须实测。
//
// bundle 自己有 `projectCard(x, y)`（卡片局部坐标 → 容器像素坐标）。补丁脚本在
// 渲染循环里挂了个回调，把卡片四角的投影结果 postMessage 给宿主
// （见 folia-rhine-overlay.js 的 publishCardRect）。这里收下矩形，按像素定位。
import React from 'react';
import VisualizerRenderer from '../../../components/visualizer/VisualizerRenderer';
import { useVisualizerRendererModel } from '../../../components/visualizer/useVisualizerRendererModel';
import { usePlaybackStore, selectDisplayPlayerState, selectDisplaySong } from '../../../stores/usePlaybackStore';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import { PlayerState } from '../../../types';

/** 卡片在容器里的屏幕矩形（像素）。由 iframe 每帧投影算出来。 */
export type RhineCardRect = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export type RhineOverlayState = {
    /** 有没有歌可显示。false 时叠层不出现，露出原本的卡片内容。 */
    visible: boolean;
    /** 卡片矩形；null 表示还没量到（开屏、或不在 detail）。 */
    rect: RhineCardRect | null;
    /** iframe 量矩形失败的原因；null 表示没失败。 */
    rectError?: string | null;
};

type Props = {
    state: RhineOverlayState;
};

/**
 * 叠层里的可视化不许自己后退 / 关面板：它嵌在档案首页里，那两个动作属于播放页。
 * 用一份稳定的空实现，省得每次渲染新建函数把渲染器逼着重挂。
 */
const noop = (): void => {};

const RhineVisualOverlay: React.FC<Props> = ({ state }) => {
    const displaySong = usePlaybackStore(selectDisplaySong);
    const displayPlayerState = usePlaybackStore(selectDisplayPlayerState);
    const visualizerMode = useVisualizerSettingsStore(store => store.visualizerMode);

    /*
     * 主题：从 CSS 变量读，不去够宿主的 store。
     *
     * `theme` / `appStyle` 都是 App 那一层算出来再往下传的，叠层这里拿不到。
     * 但应用已经把主题变量同步到 `<html>` 上了（见 useAppChromeAndGestures 里
     * 「主题变量原本只挂在 App 根节点的 inline style 上……这里往 <html> 同步一份」），
     * 而且是每次变主题就更新 —— 直接从根元素取，永远跟当前主题一致。
     *
     * 只取可视化真正要用的三项：底色、主色、强调色。缺了就退回透明/白色，
     * 不至于因为读不到变量就画不出来。
     */
    const { visualizerTheme, visualizerSubtitleTheme, visualizerGeometrySeed } = React.useMemo(() => {
        const style = getComputedStyle(document.documentElement);
        const read = (name: string, fallback: string): string => {
            const value = style.getPropertyValue(name).trim();
            return value || fallback;
        };
        const base = {
            name: 'rhine-overlay',
            fontStyle: 'sans' as const,
            backgroundColor: read('--bg-color', 'transparent'),
            primaryColor: read('--text-color', '#ffffff'),
            accentColor: read('--accent-color', '#8fb8d8'),
            secondaryColor: read('--secondary-color', '#6a6a6a'),
            glowColor: read('--accent-color', '#8fb8d8'),
            lyricColor: read('--text-color', '#ffffff'),
        } as unknown as Parameters<typeof useVisualizerRendererModel>[0]['theme'];
        return {
            visualizerTheme: base,
            visualizerSubtitleTheme: base,
            visualizerGeometrySeed: displaySong?.id ?? `geometry-${visualizerMode}`,
        };
    }, [displaySong?.id, visualizerMode]);

    /*
     * 桌面播放页那套装配。参数含义：
     *   - theme / subtitleTheme：同一份，叠层不区分字幕主题。
     *   - seed：用曲目 id，可视化靠它判断「换歌了」，换成别的会让每次重渲都当过切歌。
     *   - isObsBrowserSourceRendering：不是 OBS，要动。
     *   - shouldPauseVisualizerBackground：不额外暂停，交给下面的 staticMode。
     *   - isPlayerPageTransparent：卡片本身就是透明玻璃，按透明页面处理。
     */
    const model = useVisualizerRendererModel({
        theme: visualizerTheme,
        subtitleTheme: visualizerSubtitleTheme,
        seed: visualizerGeometrySeed,
        isObsBrowserSourceRendering: false,
        shouldPauseVisualizerBackground: false,
        hideTranslationSubtitle: false,
        isPlayerPageTransparent: true,
        onLyricLineSeek: noop,
        onBack: noop,
    });

    const rect = state.rect;

    /*
     * 诊断：把整条链路上每一环的状态画出来。
     *
     * 叠层「不显示」可能是好几个原因之一 —— 开关没传到、没有歌、iframe 没把卡片矩形
     * 送过来、或者可视化本身挂了。静默失败没法排查，所以这里直接在屏幕上写出是哪一环。
     * 等确认位置和显隐都对了，把 DIAGNOSTIC 关掉就行。
     */
    const DIAGNOSTIC = true;
    if (DIAGNOSTIC) {
        const reasons = [
            `visible=${state.visible}`,
            `song=${displaySong ? 'ok' : 'none'}`,
            `rect=${rect ? `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}` : 'none'}`,
        ];
        if (state.rectError) reasons.push(`err=${state.rectError}`);
        return (
            <div
                className="pointer-events-none fixed left-2 top-2 z-[9999] rounded px-2 py-1 font-mono text-[10px] leading-tight"
                style={{ background: 'rgba(0,0,0,0.85)', color: '#7cf', maxWidth: '90vw' }}
            >
                {reasons.join(' | ')}
            </div>
        );
    }

    if (!state.visible || !displaySong || !rect) return null;

    const isPlaying = displayPlayerState === PlayerState.PLAYING;

    return (
        <div
            className="pointer-events-none absolute z-10 overflow-hidden"
            aria-hidden
            style={{
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                /*
                 * 圆角跟着卡片的比例走，不是写死像素 —— 卡片是圆角的挤出体，
                 * 方块直角会露出四个尖角。
                 */
                borderRadius: `${Math.min(rect.width, rect.height) * 0.06}px`,
                /*
                 * 边缘柔化：卡片本身是透明玻璃，边界不是硬切。外圈淡出一点，
                 * 让可视化和玻璃边缘融在一起，而不是糊上一块贴边的方图。
                 */
                WebkitMask: 'radial-gradient(ellipse 94% 90% at 50% 50%, #000 68%, transparent 100%)',
                mask: 'radial-gradient(ellipse 94% 90% at 50% 50%, #000 68%, transparent 100%)',
                opacity: isPlaying ? 1 : 0.46,
                transition: 'opacity 400ms ease',
                contain: 'layout paint style',
            }}
        >
            <VisualizerRenderer
                {...model}
                /*
                 * 卡片是透明玻璃：不画封面那块不透明方图，也不带背景 ——
                 * 否则会把卡片自己的封面区和刻字全糊掉。
                 */
                hideCoverArt
                backgroundStaticMode
                staticMode={!isPlaying}
            />
        </div>
    );
};

export default RhineVisualOverlay;
