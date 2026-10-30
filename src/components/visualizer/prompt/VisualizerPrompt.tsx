import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { getLineRenderEndTime } from '../../../utils/lyrics/renderHints';
import type { VisualizerSharedProps } from '../definition';
import { useVisualizerPixiHost } from '../pixi/pixiRuntimeHost';
import { useVisualizerRuntime } from '../runtime';
import { useVisualizerSongCommit } from '../songHandover';
import VisualizerShell from '../VisualizerShell';
import VisualizerSubtitleOverlay from '../VisualizerSubtitleOverlay';
import { compilePromptBoxes } from './promptProgram';
import type { PromptPixiRuntime, PromptSongContext } from './createPromptPixiRuntime';

// src/components/visualizer/prompt/VisualizerPrompt.tsx
// 「提示词」样式的 React 外壳：挂载惰性加载的 Pixi 运行时，自己只管背景、兜底文字和字幕条。
// 它既不认商籁的节目单，也不共用商籁的组件 —— 样式目录里出现的每个 import 都在这一层之下。

const VisualizerPrompt: React.FC<VisualizerSharedProps> = (props) => {
    const {
        currentTime,
        currentLineIndex,
        lines,
        theme,
        audioPower,
        audioBands,
        showText = true,
        lyricsFontScale = 1,
        staticMode = false,
        paused = false,
        seed = 'prompt',
        isPlayerChromeHidden = false,
        hideTranslationSubtitle = false,
        subtitleOverlayLayout,
        subtitleTheme,
        subtitleFontScale,
        subtitleOverlayOpacity,
        subtitleOverlayBackground,
        subtitleUpcomingLyricsBlur,
    } = props;
    const { t } = useTranslation();
    const hostRef = useRef<HTMLDivElement>(null);
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    const staticModeRef = useRef(staticMode);
    staticModeRef.current = staticMode;
    const [runtimeFailed, setRuntimeFailed] = useState(false);

    // 和商籁同一条闸门：歌词是「加载完才换」的，不然会对着空歌词先搭一遍再重搭。
    const committedSong = useVisualizerSongCommit({
        seed,
        lines,
        currentTime,
        readyGraceMs: 3000,
    });

    // 只依赖歌词与种子：主题换了不该重编节目单（否则运行时会当成换歌重搭框，见 swapSong 的注释）。
    const boxes = useMemo(
        () => (showText ? compilePromptBoxes(committedSong.lines, committedSong.seed ?? 'prompt') : []),
        [showText, committedSong.lines, committedSong.seed],
    );

    const songContext = useMemo<PromptSongContext>(
        () => ({ seed: committedSong.seed, boxes, theme, fontScale: lyricsFontScale }),
        [committedSong.seed, boxes, theme, lyricsFontScale],
    );

    const runtimeRef = useVisualizerPixiHost<PromptPixiRuntime, PromptSongContext>({
        hostRef,
        label: 'Prompt',
        // 只有「动感开关」会改变运行时的行为方式；字号变了要重搭（字是在搭框时量好烤进纹理的）。
        rebuildKey: [staticMode, lyricsFontScale],
        song: songContext,
        create: async (host, song, signal) => {
            const { PromptPixiRuntime } = await import('./createPromptPixiRuntime');
            const runtime = await PromptPixiRuntime.create({
                host,
                song,
                currentTime,
                paused: pausedRef.current,
                staticMode: staticModeRef.current,
                signal,
            });
            // 导入与初始化期间这两项可能已经变了。
            runtime.setPaused(pausedRef.current);
            return runtime;
        },
        swap: (runtime, song) => runtime.swapSong(song),
        destroy: runtime => runtime.destroy(),
        onFailedChange: setRuntimeFailed,
    });

    useEffect(() => {
        runtimeRef.current?.setPaused(paused);
    }, [paused, runtimeRef]);

    // 候选面板里的词来自随包带的 30000 词词表（promptVocab.ts），不需要网络，
    // 所以这里没有「进来先挂一次抓取」那套了。

    useEffect(() => currentTime.on('change', () => {
        if (paused) runtimeRef.current?.renderOnce();
    }), [currentTime, paused, runtimeRef]);

    const { activeLine, recentCompletedLine, nextLines } = useVisualizerRuntime({
        currentTime,
        currentLineIndex,
        lines,
        getLineEndTime: getLineRenderEndTime,
    });

    const fallbackFontFamily = resolveThemeFontStack(theme);
    const fallbackFontWeight = resolveThemeFontWeight(theme, 600);
    const finalLine = lines.at(-1);
    const creditsRecentCompletedLine = recentCompletedLine === finalLine ? null : recentCompletedLine;
    const showFallback = runtimeFailed || boxes.length === 0;

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={props}
        >
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
                <div ref={hostRef} className="absolute inset-0 z-10" aria-hidden="true" />
                {showFallback && (
                    <div
                        className="absolute inset-0 flex items-center justify-center px-10 text-center transition-opacity duration-300"
                        style={{
                            color: theme.primaryColor,
                            fontFamily: fallbackFontFamily,
                            fontWeight: fallbackFontWeight,
                            fontSize: `clamp(2rem, ${5.4 * lyricsFontScale}vw, 5.6rem)`,
                        }}
                    >
                        {showText && !committedSong.isInstrumental
                            ? (activeLine?.fullText || t('ui.waitingForMusic'))
                            : null}
                    </div>
                )}
            </div>

            <VisualizerSubtitleOverlay
                showText={showText}
                activeLine={activeLine}
                recentCompletedLine={creditsRecentCompletedLine}
                nextLines={nextLines}
                theme={theme}
                subtitleTheme={subtitleTheme}
                translationFontSize={`clamp(${1.05 * lyricsFontScale}rem, ${2.2 * lyricsFontScale}vw, ${1.25 * lyricsFontScale}rem)`}
                upcomingFontSize={`clamp(${0.9 * lyricsFontScale}rem, ${1.8 * lyricsFontScale}vw, ${1.05 * lyricsFontScale}rem)`}
                subtitleFontScale={subtitleFontScale}
                subtitleOverlayOpacity={subtitleOverlayOpacity}
                subtitleOverlayBackground={subtitleOverlayBackground}
                subtitleUpcomingLyricsBlur={subtitleUpcomingLyricsBlur}
                isPlayerChromeHidden={isPlayerChromeHidden}
                hideTranslationSubtitle={hideTranslationSubtitle}
                subtitleOverlayLayout={subtitleOverlayLayout}
            />
        </VisualizerShell>
    );
};

export default VisualizerPrompt;
