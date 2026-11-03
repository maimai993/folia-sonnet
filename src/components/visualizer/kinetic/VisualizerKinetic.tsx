import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useMotionValueEvent } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Line } from '../../../types';
import { useFontsEpoch } from '../../../hooks/useFontsEpoch';
import { getLineRenderEndTime } from '../../../utils/lyrics/renderHints';
import { resolveGlowWordRenderProfile } from '../glowWordTiming';
import { shouldPreheatLine, useVisualizerRuntime } from '../runtime';
import type { VisualizerSharedProps } from '../definition';
import VisualizerShell from '../VisualizerShell';
import VisualizerSubtitleOverlay from '../VisualizerSubtitleOverlay';
import { resolveKineticTuning, type KineticTuning } from './types';
import {
    EMPTY_KINETIC_LAYOUT,
    type KineticLayout,
    type KineticViewport,
    getOrBuildKineticLayout,
    buildKineticViewport,
} from './kineticLayout';
import { KineticChar } from './KineticChar';

// src/components/visualizer/kinetic/VisualizerKinetic.tsx
// 文字PV 渲染器：把当前行当成一个「文字 PV 场景」。
// React 只持布局（useMemo + 缓存 + 预热）与行级离散状态；逐字动画全部由 framer-motion variants
// 在状态切换时驱动，播放中没有一帧一次的 React 渲染（照 partita 的机制）。

type VisualizerKineticProps = VisualizerSharedProps & { kineticTuning: KineticTuning };

const KINETIC_PREHEAT_WINDOW = { minLead: 0.18, maxLead: 1.2 };

const VisualizerKinetic: React.FC<VisualizerKineticProps> = (props) => {
    const {
        currentTime,
        currentLineIndex,
        lines,
        theme,
        subtitleTheme,
        audioPower,
        audioBands,
        showText = true,
        kineticTuning,
        lyricsFontScale = 1,
        subtitleFontScale = 1,
        subtitleOverlayOpacity,
        subtitleOverlayBackground,
        subtitleUpcomingLyricsBlur,
        isPlayerChromeHidden = false,
        hideTranslationSubtitle = false,
        subtitleOverlayLayout,
    } = props;
    const { t } = useTranslation();
    // tuning 从 tuning.ts 的 read() 取（README 的做法）：不用 definition.ts 加 prop。
    const tuning = useMemo<KineticTuning>(
        () => resolveKineticTuning(kineticTuning),
        [],
    );

    const [windowSize, setWindowSize] = useState(() => ({
        width: typeof window === 'undefined' ? 1200 : window.innerWidth,
        height: typeof window === 'undefined' ? 800 : window.innerHeight,
    }));
    // 一个 ResizeObserver 代替 resize 事件，尺寸真变了才 setState。
    useEffect(() => {
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const { width, height } = entry.contentRect;
            setWindowSize((previous) => (
                Math.round(previous.width) === Math.round(width) && Math.round(previous.height) === Math.round(height)
                    ? previous
                    : { width, height }
            ));
        });
        observer.observe(document.documentElement);
        return () => observer.disconnect();
    }, []);

    const layoutCacheRef = useRef<Map<string, KineticLayout>>(new Map());
    const fontsEpoch = useFontsEpoch();
    useEffect(() => {
        if (fontsEpoch > 0) {
            layoutCacheRef.current.clear();
        }
    }, [fontsEpoch]);

    const viewport = useMemo<KineticViewport>(
        () => buildKineticViewport(windowSize.width, windowSize.height, lyricsFontScale, theme),
        [windowSize, lyricsFontScale, theme],
    );
    const viewportRef = useRef<KineticViewport>(viewport);
    useEffect(() => {
        viewportRef.current = viewport;
    }, [viewport]);

    const {
        activeLine,
        upcomingLine,
        recentCompletedLine,
        nextLines,
    } = useVisualizerRuntime({
        currentTime,
        currentLineIndex,
        lines,
        getLineEndTime: getLineRenderEndTime,
    });

    const layout = useMemo(() => {
        if (!activeLine) return EMPTY_KINETIC_LAYOUT;
        return getOrBuildKineticLayout(layoutCacheRef.current, activeLine, theme, viewport, tuning);
    }, [activeLine, theme, viewport, tuning]);

    const upcomingLineRef = useRef<Line | null>(upcomingLine);
    useEffect(() => {
        upcomingLineRef.current = upcomingLine;
    }, [upcomingLine]);

    // 下一句进预热窗口时提前建布局，切行不卡（照 partita 的预热窗口机制）。
    useMotionValueEvent(currentTime, 'change', (latest: number) => {
        const nextLine = upcomingLineRef.current;
        if (!nextLine) return;
        if (!shouldPreheatLine(nextLine, latest, KINETIC_PREHEAT_WINDOW)) return;
        getOrBuildKineticLayout(layoutCacheRef.current, nextLine, theme, viewportRef.current, tuning);
    });

    // 镜头晃动：整块容器上一个极慢的 framer 循环动画，幅度乘 tuning.cameraShake；
    // 纯 CSS/motion 层，不进 React state。0 时禁用。
    const shake = tuning.cameraShake;
    const cameraMotion = useMemo(() => (shake > 0
        ? {
            animate: {
                x: [0, -3 * shake, 0, 2.5 * shake, 0],
                y: [0, 2 * shake, 0, -2.5 * shake, 0],
                rotate: [0, -0.3 * shake, 0, 0.3 * shake, 0],
            },
            transition: { duration: 9, repeat: Infinity, ease: 'easeInOut' as const },
        }
        : {}), [shake]);

    const emptyFontSize = `clamp(1.1rem, 2.4vw, 1.7rem)`;

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={props}
        >
            <motion.div
                className="relative z-10 w-full h-full flex items-center justify-center pointer-events-none will-change-transform overflow-hidden"
                {...cameraMotion}
            >
                {showText && activeLine && layout.rows.length > 0 && (
                    <div
                        className="relative"
                        style={{ width: '100%', maxWidth: viewport.width, height: layout.totalHeight }}
                    >
                        {layout.rows.map((row) => (
                            <div
                                key={row.id}
                                className="absolute left-1/2 will-change-transform"
                                style={{
                                    // 行框定宽定高：行内字用绝对位置排，行与行之间由布局的 offsetY 保证 0 重叠。
                                    top: `calc(50% + ${row.offsetY - row.height / 2}px)`,
                                    width: row.width + Math.abs(row.offsetX) * 2,
                                    height: row.height,
                                    transform: `translateX(calc(-50% + ${row.offsetX}px))`,
                                }}
                            >
                                {row.chars.map((meta, charIndex) => (
                                    <KineticChar
                                        key={`${meta.word.startTime}-${meta.indexInWord}`}
                                        meta={meta}
                                        row={row}
                                        charIndexInRow={charIndex}
                                        currentTime={currentTime}
                                        theme={theme}
                                        renderProfile={renderProfileOf(activeLine)}
                                        tuning={tuning}
                                        fontPx={layout.fontPx}
                                    />
                                ))}
                            </div>
                        ))}
                    </div>
                )}

                {showText && !activeLine && (
                    <div
                        className="absolute opacity-50"
                        style={{ color: theme.secondaryColor, fontSize: emptyFontSize }}
                    >
                        {t('ui.waitingForMusic')}
                    </div>
                )}
            </motion.div>

            <VisualizerSubtitleOverlay
                showText={showText}
                activeLine={activeLine}
                recentCompletedLine={recentCompletedLine}
                nextLines={nextLines}
                theme={theme}
                subtitleTheme={subtitleTheme}
                translationFontSize={`clamp(1.05rem, 2.2vw, 1.2rem)`}
                upcomingFontSize={`clamp(0.875rem, 1.8vw, 1rem)`}
                subtitleOverlayOpacity={subtitleOverlayOpacity}
                subtitleOverlayBackground={subtitleOverlayBackground}
                subtitleUpcomingLyricsBlur={subtitleUpcomingLyricsBlur}
                subtitleFontScale={subtitleFontScale}
                isPlayerChromeHidden={isPlayerChromeHidden}
                hideTranslationSubtitle={hideTranslationSubtitle}
                subtitleOverlayLayout={subtitleOverlayLayout}
            />
        </VisualizerShell>
    );
};

/** 每行的 render profile：统一从歌词管线的 renderHints 整理，按行缓存，组件里不猜时序。 */
const renderProfileCache = new WeakMap<Line, ReturnType<typeof resolveGlowWordRenderProfile>>();
const renderProfileOf = (line: Line) => {
    const cached = renderProfileCache.get(line);
    if (cached) return cached;
    const profile = resolveGlowWordRenderProfile(line)!;
    renderProfileCache.set(line, profile);
    return profile;
};

export default VisualizerKinetic;
