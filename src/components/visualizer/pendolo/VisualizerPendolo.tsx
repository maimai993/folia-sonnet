import React, { useMemo, useState, useEffect } from 'react';
import { motion, useSpring, useTransform, type MotionValue } from 'framer-motion';
import { Star, type LucideIcon } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import {
    DEFAULT_PENDOLO_TUNING,
    type Line,
} from '../../../types';
import { colorWithAlpha, mixColors } from '../colorMix';
import { type VisualizerSharedProps } from '../definition';
import { useVisualizerRuntime } from '../runtime';
import VisualizerShell from '../VisualizerShell';
import VisualizerSubtitleOverlay from '../VisualizerSubtitleOverlay';
import PendoloClockworkCanvas from './PendoloClockworkCanvas';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { buildLineGraphemeTimeline } from '../../../utils/lyrics/graphemeTiming';
import { measureMonetGraphemeOffsets } from '../monet/monetLyricsModel';
import { calculatePendoloWheelLayout } from './pendoloGeometry';

// src/components/visualizer/pendolo/VisualizerPendolo.tsx

interface PendoloActiveLyricSweepProps {
    line: Line;
    currentTime: MotionValue<number>;
    fontFamily: string;
    fontWeight: number;
    primaryTextColor: string;
    accentTextColor: string;
}

/** Draws a Monet-style timed text sweep without its glow treatment. */
const PendoloActiveLyricSweep: React.FC<PendoloActiveLyricSweepProps> = ({
    line,
    currentTime,
    fontFamily,
    fontWeight,
    primaryTextColor,
    accentTextColor,
}) => {
    const text = line.fullText;
    const fontPx = 28;
    const fontSpec = `${fontWeight} ${fontPx}px ${fontFamily}`;
    const graphemeTimings = useMemo(() => buildLineGraphemeTimeline(line), [line]);
    const graphemeOffsets = useMemo(
        () => measureMonetGraphemeOffsets(text, fontPx, fontSpec),
        [fontPx, fontSpec, text],
    );
    const fillWidth = useTransform(currentTime, latest => {
        const fullWidth = graphemeOffsets[graphemeOffsets.length - 1] ?? 0;
        const timingCount = Math.min(graphemeTimings.length, graphemeOffsets.length - 1);
        if (timingCount === 0 || latest <= line.startTime) return 0;

        for (let index = 0; index < timingCount; index += 1) {
            const timing = graphemeTimings[index];
            const start = Math.max(line.startTime, timing.startTime);
            const end = Math.max(start, timing.endTime);
            const startWidth = graphemeOffsets[index] ?? 0;
            const endWidth = graphemeOffsets[index + 1] ?? startWidth;
            if (latest < start) return startWidth;
            if (latest <= end) {
                return startWidth + (endWidth - startWidth)
                    * ((latest - start) / Math.max(0.001, end - start));
            }
        }

        return fullWidth;
    });
    const maskImage = useTransform(fillWidth, width => {
        const edgeSoftness = Math.min(Math.max(fontPx * 0.42, 8), 16);
        const solidEnd = Math.max(width - edgeSoftness, 0);
        return `linear-gradient(90deg, #000 0px, #000 ${solidEnd}px, rgba(0, 0, 0, 0.84) ${width}px, transparent ${width + edgeSoftness}px)`;
    });
    const fillColor = mixColors(primaryTextColor, accentTextColor, 0.32);

    return (
        <span className="relative inline-block whitespace-nowrap" style={{ fontSize: `${fontPx}px` }}>
            <span style={{ color: colorWithAlpha(primaryTextColor, 0.52) }}>{text}</span>
            <motion.span
                aria-hidden
                className="pointer-events-none absolute inset-0 block whitespace-nowrap"
                style={{
                    color: fillColor,
                    WebkitMaskImage: maskImage,
                    maskImage,
                    WebkitMaskRepeat: 'no-repeat',
                    maskRepeat: 'no-repeat',
                    textShadow: 'none',
                }}
            >
                {text}
            </motion.span>
        </span>
    );
};

/**
 * VisualizerPendolo: Escapement wheel & pendulum clockwork lyric visualizer.
 * Renders lyrics arranged in an adjustable circular arc on the left side of the screen.
 * Advance of song lines triggers a springy mechanical escapement ratchet step and subtle balance wheel oscillation.
 */
const VisualizerPendolo: React.FC<VisualizerSharedProps> = (props) => {
    const {
        currentTime,
        currentLineIndex,
        lines,
        theme,
        audioBands,
        audioPower,
        showText = true,
        subtitleTheme,
        hideTranslationSubtitle,
        showSubtitleTranslation = true,
        subtitleContentMode = 'translation',
        subtitleOverlayOpacity,
        subtitleOverlayBackground,
        subtitleFontScale,
        pendoloTuning = DEFAULT_PENDOLO_TUNING,
        onLyricLineSeek,
    } = props;

    const { activeLine, recentCompletedLine, nextLines } = useVisualizerRuntime({
        currentTime,
        currentLineIndex,
        lines,
    });

    const [viewportSize, setViewportSize] = useState({
        width: typeof window !== 'undefined' ? window.innerWidth : 1920,
        height: typeof window !== 'undefined' ? window.innerHeight : 1080,
    });

    useEffect(() => {
        const handleResize = () => {
            setViewportSize({
                width: window.innerWidth,
                height: window.innerHeight,
            });
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const lastValidLineIndexRef = React.useRef<number>(0);
    if (currentLineIndex >= 0 && currentLineIndex < lines.length) {
        lastValidLineIndexRef.current = currentLineIndex;
    }

    const targetLineIndex = useMemo(() => {
        if (lines.length === 0) return 0;
        if (currentLineIndex >= 0 && currentLineIndex < lines.length) {
            return currentLineIndex;
        }
        const currentTimeVal = currentTime.get();
        if (lastValidLineIndexRef.current === 0 && currentTimeVal < (lines[0]?.startTime ?? 0)) {
            return -1;
        }
        return lastValidLineIndexRef.current + 0.5;
    }, [currentLineIndex, currentTime, lines]);

    // Escapement spring motion for line transition tick
    const springSnappiness = pendoloTuning.tickSnappiness;
    const tickSpring = useSpring(targetLineIndex, {
        stiffness: 180 * springSnappiness,
        damping: 18 + 4 / Math.max(0.5, springSnappiness),
        mass: 0.8,
    });

    // Update target escapement spring when targetLineIndex updates
    useEffect(() => {
        tickSpring.set(targetLineIndex);
    }, [targetLineIndex, tickSpring]);

    // Font stack & weight setup
    const fontFamily = useMemo(() => resolveThemeFontStack(theme), [theme]);
    const fontWeight = useMemo(() => resolveThemeFontWeight(theme, 400), [theme]);

    // Center and radius coordinates
    const centerX = viewportSize.width * pendoloTuning.wheelCenterX;
    const centerY = viewportSize.height * pendoloTuning.wheelCenterY;
    const baseRadius = Math.min(viewportSize.width, viewportSize.height) * pendoloTuning.arcRadius;

    // Escapement angular shift calculation
    const totalArcRad = (pendoloTuning.arcAngleDeg * Math.PI) / 180;
    const visibleWindowCount = 9;
    const angleStepRad = totalArcRad / Math.max(1, visibleWindowCount - 1);
    // Keep the ratchet interpolation out of React's render path. A line change is
    // discrete, but the spring emits many intermediate values while settling.
    const wheelRotationDeg = useTransform(
        tickSpring,
        value => -(value - targetLineIndex) * angleStepRad * (180 / Math.PI),
    );
    const textRotationCorrectionDeg = useTransform(wheelRotationDeg, value => -value * 0.65);
    const gearRotationAngleRad = useTransform(tickSpring, value => value * angleStepRad);

    // Calculate line items for wheel
    const lineItems = useMemo(() => {
        return calculatePendoloWheelLayout(
            lines,
            targetLineIndex,
            0,
            viewportSize.width,
            viewportSize.height,
            pendoloTuning,
        );
    }, [lines, targetLineIndex, viewportSize, pendoloTuning]);

    const primaryTextColor = theme.primaryColor || '#FFFFFF';
    const accentTextColor = theme.accentColor || '#3B82F6';
    const secondaryTextColor = theme.secondaryColor || '#9CA3AF';
    const BalanceIcon = useMemo<LucideIcon>(() => {
        const iconName = theme.lyricsIcons?.[0];
        return (iconName
            ? LucideIcons[iconName as keyof typeof LucideIcons]
            : undefined) as LucideIcon | undefined ?? Star;
    }, [theme.lyricsIcons]);
    const balanceGearX = centerX + baseRadius * 0.2;
    const balanceGearY = centerY - baseRadius * 0.75;

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={props}
        >
            <div className="relative w-full h-full overflow-hidden select-none pointer-events-none">
                {/* Wireframe Dynamic Clockwork Canvas (Gears, Escapement & Hairspring) */}
                <PendoloClockworkCanvas
                    centerX={centerX}
                    centerY={centerY}
                    baseRadius={baseRadius}
                    escapementAngleMotionValue={gearRotationAngleRad}
                    audioBassMotionValue={audioBands.bass}
                    primaryTextColor={primaryTextColor}
                    accentTextColor={accentTextColor}
                    showGearDecor={pendoloTuning.showGearDecor}
                    paused={props.paused}
                />
                {pendoloTuning.showGearDecor !== 'none' && (
                    <div
                        className="absolute pointer-events-none"
                        style={{
                            left: `${balanceGearX}px`,
                            top: `${balanceGearY}px`,
                            zIndex: 1,
                            transform: 'translate(-50%, -50%)',
                        }}
                    >
                        <BalanceIcon
                            size={Math.max(14, baseRadius * 0.13)}
                            strokeWidth={1.2}
                            absoluteStrokeWidth
                            color={colorWithAlpha(accentTextColor, 0.62)}
                        />
                    </div>
                )}

                {/* Lyric Wheel Arc Items */}
                {showText && (
                    <motion.div
                        className="absolute inset-0 w-full h-full pointer-events-none"
                        style={{
                            zIndex: 2,
                            rotate: wheelRotationDeg,
                            transformOrigin: `${centerX}px ${centerY}px`,
                        }}
                    >
                        {lineItems.map((item) => {
                            const isFocal = item.isActive;
                            const displayTranslation = showSubtitleTranslation && Boolean(item.line.translation);
                            const displayRomanization = subtitleContentMode === 'romanization' && Boolean(item.line.romanization);

                            return (
                                <div
                                    key={item.line.id ?? `pendolo-line-${item.index}`}
                                    className="absolute transform -translate-y-1/2 transition-opacity duration-300 pointer-events-auto cursor-pointer"
                                    style={{
                                        left: `${item.x}px`,
                                        top: `${item.y}px`,
                                        transform: 'translate(0, -50%)',
                                        transformOrigin: 'left center',
                                        opacity: item.alpha,
                                        fontFamily,
                                        fontWeight,
                                    }}
                                    onClick={() => onLyricLineSeek?.(item.line.startTime)}
                                >
                                    <motion.div
                                        className="inline-block"
                                        style={{ rotate: textRotationCorrectionDeg, transformOrigin: 'left center' }}
                                    >
                                    {/* Main Lyric Text with Mechanical Press & Drop */}
                                    <div
                                        className="relative inline-block whitespace-nowrap"
                                        style={{ transform: `rotate(${item.angleDeg * 0.35}deg) scale(${item.scale})`, transformOrigin: 'left center' }}
                                    >
                                        {isFocal ? (
                                            <PendoloActiveLyricSweep
                                                line={item.line}
                                                currentTime={currentTime}
                                                fontFamily={fontFamily}
                                                fontWeight={fontWeight}
                                                primaryTextColor={primaryTextColor}
                                                accentTextColor={accentTextColor}
                                            />
                                        ) : (
                                            <div
                                                className="transition-all duration-200"
                                                style={{
                                                    fontSize: '22px',
                                                    color: colorWithAlpha(primaryTextColor, 0.75),
                                                    letterSpacing: '0.01em',
                                                }}
                                            >
                                                {item.line.fullText}
                                            </div>
                                        )}
                                    {/* Secondary Translation / Romanization Line */}
                                    {(displayTranslation || displayRomanization) && (
                                        <div
                                            className="whitespace-nowrap mt-1 transition-opacity duration-200"
                                            style={{
                                                fontSize: isFocal ? '16px' : '12px',
                                                color: isFocal ? secondaryTextColor : colorWithAlpha(secondaryTextColor, 0.6),
                                                letterSpacing: '0.01em',
                                            }}
                                        >
                                            {displayTranslation ? item.line.translation : item.line.romanization}
                                        </div>
                                    )}
                                    </div>
                                    </motion.div>
                                </div>
                            );
                        })}
                    </motion.div>
                )}
            </div>

            {showText && (
                <VisualizerSubtitleOverlay
                    showText={showText}
                    activeLine={activeLine}
                    recentCompletedLine={recentCompletedLine}
                    nextLines={nextLines}
                    theme={theme}
                    subtitleTheme={subtitleTheme}
                    translationFontSize="clamp(1.1rem, 2.2vw, 1.45rem)"
                    upcomingFontSize="clamp(0.95rem, 1.8vw, 1.2rem)"
                    subtitleOverlayOpacity={subtitleOverlayOpacity}
                    subtitleOverlayBackground={subtitleOverlayBackground}
                    subtitleFontScale={subtitleFontScale}
                    hideTranslationSubtitle={hideTranslationSubtitle}
                    showSubtitleTranslation={showSubtitleTranslation}
                    subtitleContentMode={subtitleContentMode}
                />
            )}
        </VisualizerShell>
    );
};

export default React.memo(VisualizerPendolo);
