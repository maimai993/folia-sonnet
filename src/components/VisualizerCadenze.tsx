import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, MotionValue } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { layoutWithLines, prepareWithSegments, type LayoutLine, type LayoutCursor, type PreparedTextWithSegments } from '@chenglou/pretext';
import { AudioBands, DEFAULT_CADENZE_TUNING, Line, Theme, Word as WordType, type CadenzeTuning } from '../types';
import GeometricBackground from './GeometricBackground';
import FluidBackground from './FluidBackground';

interface VisualizerProps {
    currentTime: MotionValue<number>;
    currentLineIndex: number;
    lines: Line[];
    theme: Theme;
    audioPower: MotionValue<number>;
    audioBands: AudioBands;
    showText?: boolean;
    coverUrl?: string | null;
    useCoverColorBg?: boolean;
    seed?: string | number;
    backgroundOpacity?: number;
    cadenzeTuning?: CadenzeTuning;
    onBack?: () => void;
}

interface SegmentMeta {
    graphemeStart: number;
    graphemeEnd: number;
    graphemeCount: number;
}

interface WordRange {
    word: WordType;
    start: number;
    end: number;
    color: string;
}

interface WordFragment {
    word: WordType;
    text: string;
    color: string;
    startX: number;
    endX: number;
}

interface LineView {
    line: LayoutLine;
    lineStart: number;
    lineEnd: number;
    fragments: WordFragment[];
}

interface PreparedState {
    prepared: PreparedTextWithSegments;
    text: string;
    font: string;
    fontPx: number;
    lineHeight: number;
    maxWidth: number;
    layout: ReturnType<typeof layoutWithLines>;
    segmentMetas: SegmentMeta[];
    graphemes: string[];
    lineViews: LineView[];
}

const graphemeSegmenter = typeof Intl !== 'undefined'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

const splitGraphemes = (text: string) => {
    if (!text) return [] as string[];
    if (graphemeSegmenter) {
        return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
    }
    return Array.from(text);
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isCJK = (text: string) => /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(text);

const fontFamilyByStyle: Record<Theme['fontStyle'], string> = {
    sans: '"Inter", "Helvetica Neue", Arial, sans-serif',
    serif: '"Iowan Old Style", "Georgia", serif',
    mono: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
};

const colorWithAlpha = (color: string, alpha: number) => {
    const normalizedAlpha = clamp(alpha, 0, 1);

    if (color.startsWith('#')) {
        const hex = color.slice(1);
        const parse = (value: string) => Number.parseInt(value, 16);

        if (hex.length === 3) {
            const r = parse(hex[0] + hex[0]);
            const g = parse(hex[1] + hex[1]);
            const b = parse(hex[2] + hex[2]);
            return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
        }

        if (hex.length === 6) {
            const r = parse(hex.slice(0, 2));
            const g = parse(hex.slice(2, 4));
            const b = parse(hex.slice(4, 6));
            return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
        }
    }

    const rgbMatch = color.match(/^rgba?\(([^)]+)\)$/);
    if (rgbMatch) {
        const channels = rgbMatch[1].split(',').slice(0, 3).map(part => part.trim());
        return `rgba(${channels.join(', ')}, ${normalizedAlpha})`;
    }

    return color;
};

const getWordStatus = (time: number, word: WordType) => {
    const lookahead = 0.18;
    if (time >= word.startTime - lookahead && time <= word.endTime) {
        return 'active' as const;
    }
    if (time > word.endTime) {
        return 'passed' as const;
    }
    return 'waiting' as const;
};

const getWordProgress = (time: number, word: WordType) => {
    const duration = Math.max(word.endTime - word.startTime, 0.01);
    return clamp((time - word.startTime) / duration, 0, 1);
};

const chooseFontPx = (width: number, line: Line) => {
    const graphemeCount = splitGraphemes(line.fullText).length || 1;
    const wordCount = line.words.length || 1;
    const widthBase = clamp(width * 0.086, 34, 94);
    const lengthPenalty = graphemeCount > 12 ? Math.min((graphemeCount - 12) * 1.8, 34) : 0;
    const densityPenalty = wordCount > 7 ? Math.min((wordCount - 7) * 1.5, 18) : 0;
    const interludeBoost = line.fullText === '......' ? 10 : 0;
    return clamp(widthBase - lengthPenalty - densityPenalty + interludeBoost, 28, 104);
};

const buildCanvasFont = (theme: Theme, fontPx: number) => `700 ${fontPx}px ${fontFamilyByStyle[theme.fontStyle]}`;

const getActiveColor = (wordText: string, theme: Theme) => {
    if (!theme.wordColors || theme.wordColors.length === 0) {
        return theme.accentColor;
    }

    const cleanCurrent = wordText.trim();
    const matched = theme.wordColors.find(entry => {
        const target = entry.word;
        if (isCJK(cleanCurrent)) {
            return target.includes(cleanCurrent);
        }

        const targetWords = target.split(/\s+/).map(value => value.toLowerCase().replace(/[^\w]/g, ''));
        const normalizedCurrent = cleanCurrent.toLowerCase().replace(/[^\w]/g, '');
        return targetWords.includes(normalizedCurrent);
    });

    return matched?.color ?? theme.accentColor;
};

const buildSegmentMetas = (prepared: PreparedTextWithSegments) => {
    const segmentMetas: SegmentMeta[] = [];
    const graphemes: string[] = [];
    let graphemeCursor = 0;

    for (const segment of prepared.segments) {
        const segmentGraphemes = splitGraphemes(segment);
        segmentMetas.push({
            graphemeStart: graphemeCursor,
            graphemeEnd: graphemeCursor + segmentGraphemes.length,
            graphemeCount: segmentGraphemes.length,
        });
        graphemes.push(...segmentGraphemes);
        graphemeCursor += segmentGraphemes.length;
    }

    return { segmentMetas, graphemes };
};

const findWordRanges = (line: Line, graphemes: string[], theme: Theme) => {
    const ranges: WordRange[] = [];
    let cursor = 0;

    for (const word of line.words) {
        const target = splitGraphemes(word.text);
        let start = -1;

        for (let i = cursor; i <= graphemes.length - target.length; i++) {
            let isMatch = true;
            for (let j = 0; j < target.length; j++) {
                if (graphemes[i + j] !== target[j]) {
                    isMatch = false;
                    break;
                }
            }
            if (isMatch) {
                start = i;
                break;
            }
        }

        if (start === -1) {
            start = clamp(cursor, 0, graphemes.length);
        }

        const end = clamp(start + target.length, start, graphemes.length);

        ranges.push({
            word,
            start,
            end,
            color: getActiveColor(word.text, theme),
        });

        cursor = end;
    }

    return ranges;
};

const cursorToGlobalOffset = (cursor: LayoutCursor, segmentMetas: SegmentMeta[]) => {
    if (segmentMetas.length === 0) return 0;
    const segment = segmentMetas[cursor.segmentIndex];

    if (!segment) {
        return segmentMetas[segmentMetas.length - 1]!.graphemeEnd;
    }

    return clamp(segment.graphemeStart + cursor.graphemeIndex, segment.graphemeStart, segment.graphemeEnd);
};

const getPartialSegmentWidth = (
    prepared: PreparedTextWithSegments,
    segmentIndex: number,
    segmentMeta: SegmentMeta,
    startOffset: number,
    endOffset: number,
) => {
    const localStart = clamp(startOffset - segmentMeta.graphemeStart, 0, segmentMeta.graphemeCount);
    const localEnd = clamp(endOffset - segmentMeta.graphemeStart, 0, segmentMeta.graphemeCount);

    if (localEnd <= localStart) return 0;
    if (localStart === 0 && localEnd === segmentMeta.graphemeCount) {
        return prepared.widths[segmentIndex] ?? 0;
    }

    const prefixWidths = prepared.breakablePrefixWidths[segmentIndex];
    if (prefixWidths && prefixWidths.length > 0) {
        const endWidth = prefixWidths[localEnd - 1] ?? 0;
        const startWidth = localStart > 0 ? (prefixWidths[localStart - 1] ?? 0) : 0;
        return endWidth - startWidth;
    }

    const breakableWidths = prepared.breakableWidths[segmentIndex];
    if (breakableWidths && breakableWidths.length > 0) {
        let width = 0;
        for (let i = localStart; i < localEnd; i++) {
            width += breakableWidths[i] ?? 0;
        }
        return width;
    }

    const fullWidth = prepared.widths[segmentIndex] ?? 0;
    if (segmentMeta.graphemeCount === 0) return fullWidth;
    return fullWidth * ((localEnd - localStart) / segmentMeta.graphemeCount);
};

const widthBetweenOffsets = (
    prepared: PreparedTextWithSegments,
    segmentMetas: SegmentMeta[],
    startOffset: number,
    endOffset: number,
) => {
    if (endOffset <= startOffset) return 0;

    let width = 0;

    for (let segmentIndex = 0; segmentIndex < segmentMetas.length; segmentIndex++) {
        const meta = segmentMetas[segmentIndex]!;
        if (endOffset <= meta.graphemeStart) break;
        if (startOffset >= meta.graphemeEnd) continue;

        const sliceStart = Math.max(startOffset, meta.graphemeStart);
        const sliceEnd = Math.min(endOffset, meta.graphemeEnd);
        width += getPartialSegmentWidth(prepared, segmentIndex, meta, sliceStart, sliceEnd);
    }

    return width;
};

const buildLineViews = (
    prepared: PreparedTextWithSegments,
    segmentMetas: SegmentMeta[],
    graphemes: string[],
    layout: ReturnType<typeof layoutWithLines>,
    ranges: WordRange[],
) => layout.lines.map(line => {
    const lineStart = cursorToGlobalOffset(line.start, segmentMetas);
    const lineEnd = cursorToGlobalOffset(line.end, segmentMetas);

    const fragments = ranges.flatMap(range => {
        if (range.end <= lineStart || range.start >= lineEnd) {
            return [];
        }

        const fragmentStart = Math.max(range.start, lineStart);
        const fragmentEnd = Math.min(range.end, lineEnd);
        return [{
            word: range.word,
            text: graphemes.slice(fragmentStart, fragmentEnd).join(''),
            color: range.color,
            startX: widthBetweenOffsets(prepared, segmentMetas, lineStart, fragmentStart),
            endX: widthBetweenOffsets(prepared, segmentMetas, lineStart, fragmentEnd),
        }];
    });

    return { line, lineStart, lineEnd, fragments };
});

const drawRoundedRect = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
) => {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
};

const drawActiveBeam = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    energy: number,
    beamIntensity: number,
) => {
    const beamHeight = Math.max(6, height * (0.14 + energy * 0.08) * Math.max(beamIntensity, 0.15));
    const beamY = y + height * 0.72;
    const gradient = ctx.createLinearGradient(x, beamY, x + width, beamY);
    gradient.addColorStop(0, colorWithAlpha(color, 0));
    gradient.addColorStop(0.18, colorWithAlpha(color, (0.5 + energy * 0.18) * beamIntensity));
    gradient.addColorStop(0.82, colorWithAlpha(color, (0.5 + energy * 0.18) * beamIntensity));
    gradient.addColorStop(1, colorWithAlpha(color, 0));
    ctx.fillStyle = gradient;
    drawRoundedRect(ctx, x, beamY, width, beamHeight, beamHeight / 2);
    ctx.fill();

    ctx.fillStyle = colorWithAlpha(color, 0.8 * beamIntensity);
    ctx.beginPath();
    ctx.arc(x + 2, beamY + beamHeight / 2, beamHeight / 1.8, 0, Math.PI * 2);
    ctx.arc(x + width - 2, beamY + beamHeight / 2, beamHeight / 1.8, 0, Math.PI * 2);
    ctx.fill();
};

const VisualizerCadenze: React.FC<VisualizerProps & { staticMode?: boolean; }> = ({
    currentTime,
    currentLineIndex,
    lines,
    theme,
    audioPower,
    audioBands,
    showText = true,
    coverUrl,
    useCoverColorBg = false,
    seed,
    staticMode = false,
    backgroundOpacity = 0.75,
    cadenzeTuning = DEFAULT_CADENZE_TUNING,
    onBack,
}) => {
    const { t } = useTranslation();
    const [showBackButton, setShowBackButton] = useState(false);
    const [viewport, setViewport] = useState({ width: 0, height: 0 });
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const currentTimeValue = currentTime.get();
    const activeLine = lines[currentLineIndex];

    let recentCompletedLine = null;
    if (currentLineIndex === -1 && lines.length > 0) {
        for (let i = lines.length - 1; i >= 0; i--) {
            if (currentTimeValue > lines[i].endTime) {
                recentCompletedLine = lines[i];
                break;
            }
        }
    }

    const nextLines = lines.slice(currentLineIndex + 1, currentLineIndex + 3);
    const tuning = cadenzeTuning;

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;

        const observer = new ResizeObserver(entries => {
            const entry = entries[0];
            if (!entry) return;
            setViewport({
                width: entry.contentRect.width,
                height: entry.contentRect.height,
            });
        });

        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const preparedState = useMemo<PreparedState | null>(() => {
        if (!activeLine || !showText || viewport.width <= 0 || viewport.height <= 0) {
            return null;
        }

        const fontPx = clamp(chooseFontPx(viewport.width, activeLine) * tuning.fontScale, 24, 132);
        const font = buildCanvasFont(theme, fontPx);
        const prepared = prepareWithSegments(activeLine.fullText, font);
        const text = prepared.segments.join('');
        const { segmentMetas, graphemes } = buildSegmentMetas(prepared);
        const lineHeight = Math.round(fontPx * (isCJK(text) ? 1.22 : 1.1));
        const availableWidth = Math.max(viewport.width - 48, 120);
        const minWidth = Math.min(220, availableWidth);
        const maxWidth = clamp(Math.min(viewport.width * tuning.widthRatio, 980), minWidth, availableWidth);
        const layout = layoutWithLines(prepared, maxWidth, lineHeight);
        const ranges = findWordRanges(activeLine, graphemes, theme);
        const lineViews = buildLineViews(prepared, segmentMetas, graphemes, layout, ranges);

        return {
            prepared,
            text,
            font,
            fontPx,
            lineHeight,
            maxWidth,
            layout,
            segmentMetas,
            graphemes,
            lineViews,
        };
    }, [activeLine, showText, theme, tuning.fontScale, tuning.widthRatio, viewport.height, viewport.width]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || viewport.width <= 0 || viewport.height <= 0) return;

        let frameId = 0;
        const context = canvas.getContext('2d');
        if (!context) return;

        const draw = () => {
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

            if (!showText || !preparedState || !activeLine) {
                frameId = window.requestAnimationFrame(draw);
                return;
            }

            const time = currentTime.get();
            const energy = staticMode ? 0 : clamp(audioPower.get() / 255, 0, 1);
            const motionEnergy = energy * tuning.motionAmount;
            const verticalLift = staticMode ? 0 : Math.sin(time * 2.3) * (3 + motionEnergy * 8);
            const focusY = height * 0.42 + verticalLift;
            const blockHeight = preparedState.layout.height;
            const baseY = focusY - blockHeight / 2 + preparedState.fontPx;

            context.font = preparedState.font;
            context.textBaseline = 'alphabetic';
            context.lineJoin = 'round';
            context.lineCap = 'round';

            const backdrop = context.createRadialGradient(
                width / 2,
                focusY,
                preparedState.fontPx * 0.2,
                width / 2,
                focusY,
                Math.max(width, height) * 0.42,
            );
            backdrop.addColorStop(0, colorWithAlpha(theme.accentColor, (0.06 + energy * 0.08) * tuning.glowIntensity));
            backdrop.addColorStop(1, colorWithAlpha(theme.accentColor, 0));
            context.fillStyle = backdrop;
            context.fillRect(0, 0, width, height);

            preparedState.lineViews.forEach((lineView, index) => {
                const lineX = (width - lineView.line.width) / 2;
                const lineY = baseY + index * preparedState.lineHeight;
                const driftX = staticMode ? 0 : Math.sin(time * 1.35 + index * 0.7) * (2 + motionEnergy * 6);
                const driftY = staticMode ? 0 : Math.cos(time * 1.1 + index) * (1 + motionEnergy * 2.5);
                const drawX = lineX + driftX;
                const drawY = lineY + driftY;
                const lineBoxY = drawY - preparedState.fontPx * 0.82;

                context.fillStyle = colorWithAlpha(theme.secondaryColor, 0.12);
                drawRoundedRect(
                    context,
                    drawX - 18,
                    lineBoxY - 16,
                    lineView.line.width + 36,
                    preparedState.lineHeight + 20,
                    22,
                );
                context.fill();

                context.shadowBlur = 0;
                context.fillStyle = colorWithAlpha(theme.primaryColor, 0.24);
                context.fillText(lineView.line.text, drawX, drawY);

                lineView.fragments.forEach(fragment => {
                    const status = getWordStatus(time, fragment.word);
                    const fragmentWidth = Math.max(fragment.endX - fragment.startX, preparedState.fontPx * 0.18);
                    const fragmentX = drawX + fragment.startX;
                    const progress = getWordProgress(time, fragment.word);
                    const pulse = status === 'active'
                        ? 1 + Math.sin(time * 16 + fragment.word.startTime * 5) * 0.04 * tuning.motionAmount
                        : 1;
                    const highlightHeight = preparedState.fontPx * (0.86 + energy * 0.05);

                    if (status === 'waiting') {
                        return;
                    }

                    if (status === 'active') {
                        context.fillStyle = colorWithAlpha(fragment.color, (0.1 + energy * 0.06) * tuning.glowIntensity);
                        drawRoundedRect(
                            context,
                            fragmentX - 14,
                            lineBoxY - 10,
                            fragmentWidth + 28,
                            highlightHeight + 16,
                            18,
                        );
                        context.fill();

                        drawActiveBeam(
                            context,
                            fragmentX - 4,
                            lineBoxY - 4,
                            fragmentWidth + 8,
                            highlightHeight,
                            fragment.color,
                            energy,
                            tuning.beamIntensity,
                        );

                        context.save();
                        context.translate(fragmentX + fragmentWidth / 2, drawY - preparedState.fontPx * 0.12);
                        context.scale(pulse, pulse);
                        context.translate(-(fragmentX + fragmentWidth / 2), -(drawY - preparedState.fontPx * 0.12));
                        context.shadowColor = colorWithAlpha(fragment.color, 0.85 * tuning.glowIntensity);
                        context.shadowBlur = (18 + energy * 18) * tuning.glowIntensity;
                        context.fillStyle = colorWithAlpha(fragment.color, 0.96);
                        context.fillText(fragment.text, fragmentX, drawY - preparedState.fontPx * 0.04);
                        context.restore();

                        const scanX = fragmentX + fragmentWidth * progress;
                        context.strokeStyle = colorWithAlpha(fragment.color, 0.75 * tuning.beamIntensity);
                        context.lineWidth = 1.2 * Math.max(tuning.beamIntensity, 0.5);
                        context.beginPath();
                        context.moveTo(scanX, lineBoxY - 4);
                        context.lineTo(scanX, lineBoxY + highlightHeight * 0.92);
                        context.stroke();
                    } else {
                        context.fillStyle = colorWithAlpha(fragment.color, 0.76);
                        context.fillText(fragment.text, fragmentX, drawY);
                    }
                });
            });

            frameId = window.requestAnimationFrame(draw);
        };

        draw();
        return () => window.cancelAnimationFrame(frameId);
    }, [
        activeLine,
        audioPower,
        currentTime,
        preparedState,
        showText,
        staticMode,
        theme,
        tuning.beamIntensity,
        tuning.glowIntensity,
        tuning.motionAmount,
        viewport.height,
        viewport.width,
    ]);

    return (
        <div
            ref={containerRef}
            className="w-full h-full flex flex-col items-center justify-center overflow-hidden relative transition-colors duration-1000"
            style={{ backgroundColor: 'transparent' }}
            onMouseMove={(event) => {
                const nearBackArea = event.clientX <= 120 && event.clientY <= 120;
                if (nearBackArea !== showBackButton) {
                    setShowBackButton(nearBackArea);
                }
            }}
            onMouseLeave={() => {
                if (showBackButton) {
                    setShowBackButton(false);
                }
            }}
        >
            {onBack && (
                <motion.button
                    type="button"
                    aria-label={t('ui.backToHome')}
                    initial={false}
                    animate={{
                        opacity: showBackButton ? 1 : 0,
                        scale: showBackButton ? 1 : 0.92,
                        x: showBackButton ? 0 : -6,
                    }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    onClick={(event) => {
                        event.stopPropagation();
                        onBack();
                    }}
                    className="absolute top-6 left-6 z-30 h-10 w-10 rounded-full flex items-center justify-center transition-colors backdrop-blur-md bg-black/20 hover:bg-white/10 text-white/60 pointer-events-auto"
                    style={{ pointerEvents: showBackButton ? 'auto' : 'none' }}
                >
                    <ChevronLeft size={20} />
                </motion.button>
            )}

            <AnimatePresence>
                {useCoverColorBg && !staticMode && (
                    <motion.div
                        key="fluid-bg"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 1 }}
                        className="absolute inset-0 z-0"
                    >
                        <FluidBackground coverUrl={coverUrl} theme={theme} />
                    </motion.div>
                )}
            </AnimatePresence>

            <div
                className="absolute inset-0 z-0 transition-all duration-1000"
                style={{ backgroundColor: theme.backgroundColor, opacity: (useCoverColorBg && !staticMode) ? backgroundOpacity : 1 }}
            />

            {!staticMode && (
                <div className="absolute inset-0 z-0">
                    <GeometricBackground theme={theme} audioPower={audioPower} audioBands={audioBands} seed={seed} />
                </div>
            )}

            <div className="absolute inset-0 z-10 pointer-events-none">
                <canvas ref={canvasRef} className="w-full h-full" />
            </div>

            {preparedState && showText && (
                <div className="absolute top-6 right-6 z-20 pointer-events-none">
                    <div className="rounded-full border border-white/10 bg-black/20 backdrop-blur-md px-4 py-2 text-[10px] uppercase tracking-[0.25em] text-white/70">
                        Cadenze / pretext / {preparedState.layout.lineCount}L / {preparedState.prepared.segments.length}S
                    </div>
                </div>
            )}

            <div className="relative z-10 w-full h-[70vh] flex items-center justify-center p-8 pointer-events-none">
                <AnimatePresence mode="wait">
                    {showText && !activeLine && (
                        <motion.div
                            key="empty"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="text-2xl opacity-50 absolute"
                            style={{ color: theme.secondaryColor }}
                        >
                            {t('ui.waitingForMusic')}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <AnimatePresence>
                {showText && (
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 0.72, y: 0 }}
                        exit={{ opacity: 0, y: 20 }}
                        className="absolute bottom-28 w-full text-center space-y-2 px-4 z-20 pointer-events-none"
                    >
                        {(activeLine?.translation || recentCompletedLine?.translation) ? (
                            <motion.div
                                key={`trans-${activeLine?.startTime || recentCompletedLine?.startTime}`}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0 }}
                                className="text-lg md:text-xl font-medium max-w-4xl mx-auto"
                                style={{ color: theme.secondaryColor }}
                            >
                                {activeLine?.translation || recentCompletedLine?.translation}
                            </motion.div>
                        ) : (
                            activeLine && nextLines.map((line, index) => (
                                <p
                                    key={index}
                                    className="text-sm md:text-base truncate max-w-2xl mx-auto transition-all duration-500 blur-[1px]"
                                    style={{ color: theme.secondaryColor }}
                                >
                                    {line.fullText}
                                </p>
                            ))
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default VisualizerCadenze;
