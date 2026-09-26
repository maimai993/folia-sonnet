import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Hourglass } from 'lucide-react';
import { DEFAULT_FUME_TUNING, FumeTuning } from '../../../types';
import { getLineRenderEndTime } from '../../../utils/lyrics/renderHints';
import { colorWithAlpha } from '../colorMix';

import { type VisualizerSharedProps } from '../definition';
import { buildFumeBackgroundScene, drawFumeBackground, type FumeBackgroundAudioLevels } from '../FumeBackground';
import { getRecentCompletedLine, getUpcomingLines } from '../runtime';
import VisualizerShell from '../VisualizerShell';
import VisualizerSubtitleOverlay from '../VisualizerSubtitleOverlay';
import type { FumeArticleLayout, StaticBlockSnapshot, ViewportSize } from './fumeTypes';
import { createFumeCameraState, resolveFumeBackgroundView, stepFumeCamera, syncFumeCameraToArticle, type FumeCameraState } from './fumeCameraStep';
import { isFumeBlockOnScreen, resolveFumeBlockTiming, resolveFumeGlowBases, resolveFumeStaticLayers, type FumeStaticLayerInput } from './fumeBlockFrame';
import { clamp } from './fumeMath';

import { resolveFumePassedFadeDuration } from './fumeTextStyle';

import { buildArticleLayout, buildLayoutCacheKey } from './fumeArticleLayout';
import { resolveArticleOverviewCamera } from './fumeCamera';
import { createStaticBlockSnapshot, drawFumeLiveBlock, type FumeLiveBlockParams } from './fumeCanvasText';

// This mode is basically "turn the whole lyric into an article, then move a camera through it".
// So the pipeline is much bigger than the others: prebuild the article layout, split it into blocks/render lines/graphemes,
// resolve which block the camera should care about right now, then draw background + paper + typed text + passed text together every frame.
// If this mode breaks, it is usually not one tiny animation bug, it is some step in that whole pipeline drifting out of sync.
//
// For a single lyric line, the state handling is:
// waiting -> line already exists in the article, but the camera may not be on it yet and glyphs can stay unprinted.
// active -> line becomes the main reading target, camera focuses in, and glyphs print with stronger glow/presence.
// passed -> line becomes already-read text, keep some paper trace and fade it out with textHoldRatio instead of removing it instantly.
type VisualizerProps = VisualizerSharedProps;

let lastFumeLayoutCache: {
    key: string;
    article: FumeArticleLayout | null;
} | null = null;

const LAYOUT_REBUILD_DEBOUNCE_MS = 96;

const VisualizerFume: React.FC<VisualizerProps> = (props) => {
    const {
        currentTime,
        currentLineIndex,
        lines,
        theme,
        subtitleTheme,
        audioPower,
        audioBands,
        showText = true,
        seed,
        staticMode = false,
        lyricsFontScale = 1,
        subtitleFontScale = 1,
        fumeTuning,
        subtitleOverlayOpacity,
        subtitleOverlayBackground,
        subtitleUpcomingLyricsBlur,
        isPlayerChromeHidden = false,
        hideTranslationSubtitle = false,
        showSubtitleTranslation = true,
        subtitleContentMode,
        paused = false,
    } = props;
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const currentLineIndexRef = useRef(currentLineIndex);
    const cameraStateRef = useRef<FumeCameraState>(createFumeCameraState());
    const staticBlockSnapshotCacheRef = useRef<Map<string, StaticBlockSnapshot>>(new Map());
    const layoutBuildVersionRef = useRef(0);
    const hasResolvedArticleRef = useRef(false);
    const [viewport, setViewport] = useState<ViewportSize>({ width: 0, height: 0 });
    const [article, setArticle] = useState<FumeArticleLayout | null>(null);
    const [isLayoutPending, setIsLayoutPending] = useState(false);
    const [hasPrintedContent, setHasPrintedContent] = useState(false);
    const hasPrintedContentRef = useRef(false);

    useEffect(() => {
        currentLineIndexRef.current = currentLineIndex;
    }, [currentLineIndex]);

    useEffect(() => {
        const element = viewportRef.current;
        if (!element) {
            return;
        }

        const observer = new ResizeObserver(entries => {
            const entry = entries[0];
            if (!entry) return;
            const nextWidth = entry.contentRect.width;
            const nextHeight = entry.contentRect.height;
            setViewport(previous => (
                previous.width === nextWidth && previous.height === nextHeight
                    ? previous
                    : { width: nextWidth, height: nextHeight }
            ));
        });

        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const runtime = useMemo(() => {
        const activeLine = lines[currentLineIndex] ?? null;
        const timeNow = currentTime.get();
        return {
            activeLine,
            recentCompletedLine: getRecentCompletedLine({
                lines,
                currentLineIndex,
                currentTime: timeNow,
                getLineEndTime: getLineRenderEndTime,
            }),
            nextLines: getUpcomingLines(lines, currentLineIndex, 2),
        };
    }, [currentLineIndex, lines]);
    const resolvedFumeTuning = useMemo<FumeTuning>(() => ({
        hidePrintSymbols: fumeTuning?.hidePrintSymbols ?? DEFAULT_FUME_TUNING.hidePrintSymbols,
        disableGeometricBackground: fumeTuning?.disableGeometricBackground ?? DEFAULT_FUME_TUNING.disableGeometricBackground,
        backgroundObjectOpacity: clamp(
            fumeTuning?.backgroundObjectOpacity ?? DEFAULT_FUME_TUNING.backgroundObjectOpacity,
            0,
            1,
        ),
        textHoldRatio: clamp(fumeTuning?.textHoldRatio ?? DEFAULT_FUME_TUNING.textHoldRatio, 0, 1),
        cameraTrackingMode: fumeTuning?.cameraTrackingMode === 'stepped' || fumeTuning?.cameraTrackingMode === 'smooth'
            ? fumeTuning.cameraTrackingMode
            : DEFAULT_FUME_TUNING.cameraTrackingMode,
        cameraSpeed: clamp(fumeTuning?.cameraSpeed ?? DEFAULT_FUME_TUNING.cameraSpeed, 0.55, 1.85),
        glowIntensity: clamp(fumeTuning?.glowIntensity ?? DEFAULT_FUME_TUNING.glowIntensity, 0, 1.8),
        heroScale: clamp(fumeTuning?.heroScale ?? DEFAULT_FUME_TUNING.heroScale, 0.82, 1.32),
    }), [fumeTuning]);
    const layoutTheme = useMemo(
        () => ({
            name: theme.name,
            fontStyle: theme.fontStyle,
            fontFamily: theme.fontFamily,
            fontFamilyStack: theme.fontFamilyStack,
            fontWeight: theme.fontWeight,
        }),
        [theme.fontFamily, theme.fontFamilyStack, theme.fontStyle, theme.fontWeight, theme.name],
    );
    const layoutFumeTuning = useMemo<FumeTuning>(() => ({
        ...DEFAULT_FUME_TUNING,
        heroScale: resolvedFumeTuning.heroScale,
    }), [resolvedFumeTuning.heroScale]);

    useEffect(() => {
        const requestVersion = layoutBuildVersionRef.current + 1;
        layoutBuildVersionRef.current = requestVersion;

        if (viewport.width <= 0 || viewport.height <= 0 || lines.length === 0) {
            hasResolvedArticleRef.current = false;
            setArticle(null);
            setIsLayoutPending(false);
            return;
        }

        setIsLayoutPending(true);

        let rafId = 0;
        let timeoutId = 0;
        const delay = hasResolvedArticleRef.current ? LAYOUT_REBUILD_DEBOUNCE_MS : 0;

        rafId = window.requestAnimationFrame(() => {
            timeoutId = window.setTimeout(() => {
                if (layoutBuildVersionRef.current !== requestVersion) {
                    return;
                }

                const layoutCacheKey = buildLayoutCacheKey(lines, viewport, layoutTheme, lyricsFontScale, layoutFumeTuning);
                const nextArticle = lastFumeLayoutCache?.key === layoutCacheKey
                    ? lastFumeLayoutCache.article
                    : buildArticleLayout(lines, viewport, layoutTheme, lyricsFontScale, layoutFumeTuning);
                if (layoutBuildVersionRef.current !== requestVersion) {
                    return;
                }

                lastFumeLayoutCache = {
                    key: layoutCacheKey,
                    article: nextArticle,
                };
                hasResolvedArticleRef.current = nextArticle !== null;
                setArticle(nextArticle);
                setIsLayoutPending(false);
            }, delay);
        });

        return () => {
            window.cancelAnimationFrame(rafId);
            window.clearTimeout(timeoutId);
        };
    }, [layoutFumeTuning, layoutTheme, lines, lyricsFontScale, viewport]);
    const lastRenderableLine = useMemo(() => {
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index];
            if (line?.fullText.trim().length) {
                return line;
            }
        }
        return null;
    }, [lines]);
    const overviewStartTime = useMemo(() => {
        if (!lastRenderableLine) {
            return Number.POSITIVE_INFINITY;
        }

        const lineStartTime = lastRenderableLine.startTime;
        const lineRenderEndTime = getLineRenderEndTime(lastRenderableLine);
        return lineStartTime + Math.max(lineRenderEndTime - lineStartTime, 0) * 0.5;
    }, [lastRenderableLine]);
    const backgroundScene = useMemo(
        () => buildFumeBackgroundScene({
            viewport,
            world: {
                width: article?.width ?? Math.max(viewport.width * 1.8, viewport.width),
                height: article?.height ?? Math.max(viewport.height * 1.8, viewport.height),
            },
            paperBounds: article?.paperBounds,
            seed: `${seed ?? 'fume'}:${theme.name}`,
        }),
        [article?.height, article?.paperBounds, article?.width, seed, theme.name, viewport],
    );
    const overviewCamera = useMemo(
        () => (article ? resolveArticleOverviewCamera(article, viewport) : null),
        [article, viewport],
    );
    const cameraSpeed = resolvedFumeTuning.cameraSpeed;
    const glowIntensity = resolvedFumeTuning.glowIntensity;
    const backgroundObjectOpacity = resolvedFumeTuning.backgroundObjectOpacity;
    const showPrintStamp = !resolvedFumeTuning.hidePrintSymbols;
    const textHoldRatio = resolvedFumeTuning.textHoldRatio;
    const passedFadeDuration = useMemo(
        () => resolveFumePassedFadeDuration(lines, textHoldRatio),
        [lines, textHoldRatio],
    );
    const translationFontSize = `clamp(${(1.05 * lyricsFontScale).toFixed(3)}rem, ${(2.2 * lyricsFontScale).toFixed(3)}vw, ${(1.2 * lyricsFontScale).toFixed(3)}rem)`;
    const upcomingFontSize = `clamp(${(0.875 * lyricsFontScale).toFixed(3)}rem, ${(1.8 * lyricsFontScale).toFixed(3)}vw, ${(1 * lyricsFontScale).toFixed(3)}rem)`;

    useEffect(() => {
        staticBlockSnapshotCacheRef.current.clear();
    }, [
        article,
        theme.name,
        theme.primaryColor,
        theme.secondaryColor,
        theme.accentColor,
        theme.fontStyle,
        theme.fontFamily,
        theme.fontFamilyStack,
    ]);

    useEffect(() => {
        hasPrintedContentRef.current = false;
        setHasPrintedContent(false);
    }, [article]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }

        const width = Math.max(Math.floor(viewport.width), 1);
        const height = Math.max(Math.floor(viewport.height), 1);
        const dpr = window.devicePixelRatio || 1;

        if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }

        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, width, height);

        syncFumeCameraToArticle(cameraStateRef.current, article);
        let frameId = 0;
        let lastFrameAt: number | null = null;

        const draw = () => {
            const now = performance.now();
            const dt = lastFrameAt === null
                ? 1 / 60
                : clamp((now - lastFrameAt) / 1000, 1 / 240, 0.05);
            lastFrameAt = now;

            const currentWidth = Math.max(Math.floor(viewport.width), 1);
            const currentHeight = Math.max(Math.floor(viewport.height), 1);
            const currentDpr = window.devicePixelRatio || 1;

            if (canvas.width !== Math.floor(currentWidth * currentDpr) || canvas.height !== Math.floor(currentHeight * currentDpr)) {
                canvas.width = Math.floor(currentWidth * currentDpr);
                canvas.height = Math.floor(currentHeight * currentDpr);
                canvas.style.width = `${currentWidth}px`;
                canvas.style.height = `${currentHeight}px`;
            }

            context.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
            context.clearRect(0, 0, currentWidth, currentHeight);

            const time = currentTime.get();
            const viewportCenterX = viewport.width * 0.5;
            const viewportCenterY = viewport.height * 0.5;
            const fumeBackgroundAudioLevels: FumeBackgroundAudioLevels = {
                power: audioPower.get(),
                bass: audioBands.bass.get(),
                lowMid: audioBands.lowMid.get(),
                mid: audioBands.mid.get(),
                vocal: audioBands.vocal.get(),
                treble: audioBands.treble.get(),
            };

            if (!article) {
                if (!staticMode) {
                    context.save();
                    context.translate(viewportCenterX, viewportCenterY);
                    context.translate(-backgroundScene.width * 0.5, -backgroundScene.height * 0.5);
                    drawFumeBackground({
                        context,
                        scene: backgroundScene,
                        theme,
                        time: time + now * 0.00018,
                        audioLevels: fumeBackgroundAudioLevels,
                        objectOpacityMultiplier: backgroundObjectOpacity * 2,
                    });
                    context.restore();
                }

                if (!paused) {
                    frameId = window.requestAnimationFrame(draw);
                }
                return;
            }

            // One-shot detection: once any block starts printing, flip hasPrintedContent
            if (!hasPrintedContentRef.current && time >= article.firstRenderableStartTime) {
                hasPrintedContentRef.current = true;
                setHasPrintedContent(true);
            }

            const { shouldShowOverview, overviewTextRestoreProgress } = stepFumeCamera(cameraStateRef.current, {
                article,
                time,
                now,
                dt,
                lineIndex: currentLineIndexRef.current,
                viewport,
                overviewCamera,
                overviewStartTime,
                cameraSpeed,
                cameraTrackingMode: resolvedFumeTuning.cameraTrackingMode,
                staticMode,
                animationIntensity: theme.animationIntensity,
            });
            const camera = cameraStateRef.current.camera;

            const screenScale = camera.scale;

            if (!staticMode) {
                const {
                    backgroundCenterX,
                    backgroundCenterY,
                    backgroundCameraX,
                    backgroundCameraY,
                    backgroundScale,
                } = resolveFumeBackgroundView(backgroundScene, camera, viewport);

                context.save();
                context.translate(viewportCenterX, viewportCenterY);
                context.scale(backgroundScale, backgroundScale);
                context.translate(-backgroundCameraX, -backgroundCameraY);
                drawFumeBackground({
                    context,
                    scene: backgroundScene,
                    theme,
                    time,
                    audioLevels: fumeBackgroundAudioLevels,
                    objectOpacityMultiplier: backgroundObjectOpacity * 2,
                    parallax: {
                        cameraX: backgroundCameraX,
                        cameraY: backgroundCameraY,
                        originX: backgroundCenterX,
                        originY: backgroundCenterY,
                        strength: 0.72,
                    },
                });
                context.restore();
            }

            // TODO: the live line is drawn with fillText under this continuously zooming transform, which
            // asks Chromium's glyph cache for a new size every frame and still leaks ~0.06 fd/s on Linux
            // with Lab > Fix lyric animation freeze on Linux on. Rounding the scale fixes it but makes the
            // camera visibly step. See docs/linux-glyph-cache-fd-leak.md.
            context.save();
            context.translate(viewportCenterX, viewportCenterY);
            context.scale(screenScale, screenScale);
            context.translate(-camera.x, -camera.y);

            const { activeGlowBoost, passedGlowBase } = resolveFumeGlowBases(theme.animationIntensity, glowIntensity);
            const liveParams: FumeLiveBlockParams = { time, theme, glowIntensity, activeGlowBoost, passedGlowBase, showPrintStamp };
            const staticLayerInput: FumeStaticLayerInput = {
                time,
                theme,
                passedGlowBase,
                passedFadeDuration,
                overviewTextRestoreProgress,
                snapshotScale: clamp(window.devicePixelRatio || 1, 1, 2),
            };

            if (showText) {
                for (const block of article.blocks) {
                if (!isFumeBlockOnScreen(block, camera, viewport)) {
                    continue;
                }

                const timing = resolveFumeBlockTiming(
                    block,
                    time,
                    lines[block.sourceLineIndex + 1]?.startTime ?? null,
                    textHoldRatio,
                );
                const layers = resolveFumeStaticLayers(block, timing, staticLayerInput, (spec) => {
                    let snapshot = staticBlockSnapshotCacheRef.current.get(spec.key);
                    if (!snapshot) {
                        snapshot = createStaticBlockSnapshot(block, theme, spec.fill, spec.shadowBlur, spec.shadowColor) ?? undefined;
                        if (snapshot) {
                            staticBlockSnapshotCacheRef.current.set(spec.key, snapshot);
                        }
                    }
                    return snapshot;
                });

                if (layers) {
                    for (const { snapshot, alpha } of layers) {
                        context.globalAlpha = alpha;
                        context.drawImage(
                            snapshot.canvas,
                            block.x - snapshot.padding,
                            block.y - snapshot.padding,
                            block.width + snapshot.padding * 2,
                            block.height + snapshot.padding * 2,
                        );
                    }
                    context.globalAlpha = 1;
                    continue;
                }

                drawFumeLiveBlock(context, block, timing, liveParams);
            }
            }
            context.restore();

            if (!paused) {
                frameId = window.requestAnimationFrame(draw);
            }
        };

        draw();
        return () => {
            window.cancelAnimationFrame(frameId);
            lastFrameAt = null;
        };
    }, [
        article,
        audioBands,
        audioPower,
        backgroundScene,
        backgroundObjectOpacity,
        cameraSpeed,
        currentTime,
        glowIntensity,
        passedFadeDuration,
        showPrintStamp,
        showText,
        paused,
        staticMode,
        textHoldRatio,
        theme,
        viewport.height,
        viewport.width,
    ]);

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={{
                ...props,
                background: {
                    ...props.background,
                    common: {
                        ...props.background?.common,
                        disableGeometricBackground: Boolean(props.background?.common?.disableGeometricBackground)
                            || resolvedFumeTuning.disableGeometricBackground,
                    },
                },
            }}
        >
            <div ref={viewportRef} className="relative z-10 h-full w-full pointer-events-none">
                {(article || lines.length === 0) && (
                    <motion.div
                        initial={false}
                        animate={{
                            opacity: 1,
                            scale: article && showText ? (hasPrintedContent ? 1 : 0.985) : 1,
                        }}
                        transition={{ duration: 0.45, ease: 'easeOut' }}
                        className="absolute left-1/2 top-0 -translate-x-1/2"
                        style={{
                            width: viewport.width,
                            height: viewport.height,
                        }}
                    >
                        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
                    </motion.div>
                )}

                {isLayoutPending && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 flex items-center justify-center"
                    >
                        <div
                            className="flex min-w-40 flex-col items-center gap-4 rounded-3xl border px-6 py-5"
                            style={{
                                backgroundColor: theme.backgroundColor,
                                borderColor: colorWithAlpha(theme.secondaryColor, 0.24),
                                boxShadow: `0 18px 60px ${colorWithAlpha(theme.backgroundColor, 0.52)}`,
                            }}
                        >
                            <Hourglass
                                size={24}
                                className="animate-pulse"
                                style={{ color: colorWithAlpha(theme.primaryColor, 0.78) }}
                            />
                            <div className="flex w-28 flex-col gap-2.5">
                                <div
                                    className="h-2 rounded-full animate-pulse"
                                    style={{ backgroundColor: colorWithAlpha(theme.primaryColor, 0.32) }}
                                />
                                <div
                                    className="h-2 rounded-full animate-pulse"
                                    style={{
                                        width: '78%',
                                        backgroundColor: colorWithAlpha(theme.primaryColor, 0.22),
                                    }}
                                />
                                <div
                                    className="h-2 rounded-full animate-pulse"
                                    style={{
                                        width: '56%',
                                        backgroundColor: colorWithAlpha(theme.secondaryColor, 0.2),
                                    }}
                                />
                            </div>
                        </div>
                    </motion.div>
                )}
            </div>

            <VisualizerSubtitleOverlay
                showText={showText}
                activeLine={runtime.activeLine}
                recentCompletedLine={runtime.recentCompletedLine}
                nextLines={runtime.nextLines}
                theme={theme}
                subtitleTheme={subtitleTheme}
                translationFontSize={translationFontSize}
                upcomingFontSize={upcomingFontSize}
                subtitleOverlayOpacity={subtitleOverlayOpacity}
                subtitleOverlayBackground={subtitleOverlayBackground}
                subtitleUpcomingLyricsBlur={subtitleUpcomingLyricsBlur}
                subtitleFontScale={subtitleFontScale}
                isPlayerChromeHidden={isPlayerChromeHidden}
                hideTranslationSubtitle={hideTranslationSubtitle}
                showSubtitleTranslation={showSubtitleTranslation}
                subtitleContentMode={subtitleContentMode}
            />
        </VisualizerShell>
    );
};

export default VisualizerFume;
