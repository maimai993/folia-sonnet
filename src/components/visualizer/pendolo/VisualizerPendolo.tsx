import React, { useMemo, useState, useEffect, useRef } from 'react';
import { motion, useSpring, useTransform } from 'framer-motion';
import { Star, type LucideIcon } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { DEFAULT_PENDOLO_TUNING } from '../../../types';
import { colorWithAlpha } from '../colorMix';
import { type VisualizerSharedProps } from '../definition';
import VisualizerShell from '../VisualizerShell';
import PendoloClockworkCanvas from './PendoloClockworkCanvas';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { calculatePendoloWheelLayout } from './pendoloGeometry';
import PendoloActiveLyricSweep from './PendoloActiveLyricSweep';
import { buildPendoloTextLayout } from './pendoloTextLayout';

// src/components/visualizer/pendolo/VisualizerPendolo.tsx

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
        showSubtitleTranslation = true,
        subtitleContentMode = 'translation',
        pendoloTuning = DEFAULT_PENDOLO_TUNING,
        onLyricLineSeek,
    } = props;

    const [viewportSize, setViewportSize] = useState({
        width: typeof window !== 'undefined' ? window.innerWidth : 1920,
        height: typeof window !== 'undefined' ? window.innerHeight : 1080,
    });
    const visualizerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const element = visualizerRef.current;
        if (!element) return;

        const updateViewportSize = () => {
            const width = Math.round(element.clientWidth);
            const height = Math.round(element.clientHeight);
            if (width === 0 || height === 0) return;
            setViewportSize(previous => (
                previous.width === width && previous.height === height
                    ? previous
                    : { width, height }
            ));
        };

        updateViewportSize();
        const observer = new ResizeObserver(updateViewportSize);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
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

    const lineBlockHeights = useMemo(() => {
        const measureWidth = Math.max(140, viewportSize.width * 0.38);
        return lines.map((line, index) => {
            if (Math.abs(index - targetLineIndex) > 5) {
                return 0;
            }
            const isFocal = index === targetLineIndex;
            const fontPx = isFocal ? 28 : 22;
            const mainHeight = buildPendoloTextLayout(
                line.fullText,
                `${fontWeight} ${fontPx}px ${fontFamily}`,
                measureWidth,
                Math.round(fontPx * 1.2),
            ).height;
            const translation = showSubtitleTranslation
                ? line.translation
                : subtitleContentMode === 'romanization' ? line.romanization : undefined;
            const translationHeight = translation
                ? buildPendoloTextLayout(
                    translation,
                    `${fontWeight} ${isFocal ? 16 : 12}px ${fontFamily}`,
                    measureWidth,
                    Math.round((isFocal ? 16 : 12) * 1.2),
                ).height + 4
                : 0;
            const scale = isFocal ? pendoloTuning.activeScale : Math.max(0.7, 1 - Math.abs(index - targetLineIndex) * 0.08);
            return (mainHeight + translationHeight) * scale;
        });
    }, [fontFamily, fontWeight, lines, pendoloTuning.activeScale, showSubtitleTranslation, subtitleContentMode, targetLineIndex, viewportSize.width]);

    // Calculate line items for wheel
    const lineItems = useMemo(() => {
        const lyricRadiusOffset = Math.min(viewportSize.width, viewportSize.height) * 0.06;
        return calculatePendoloWheelLayout(
            lines,
            targetLineIndex,
            0,
            viewportSize.width,
            viewportSize.height,
            pendoloTuning,
            lyricRadiusOffset,
            lineBlockHeights,
        );
    }, [lineBlockHeights, lines, targetLineIndex, viewportSize, pendoloTuning]);

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
            <div ref={visualizerRef} className="relative w-full h-full overflow-hidden select-none pointer-events-none">
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
                            const availableTextWidth = Math.max(
                                140,
                                Math.min(viewportSize.width * 0.46, viewportSize.width - item.x - 48),
                            );
                            const maxTextWidth = availableTextWidth / item.scale;

                            return (
                                <div
                                    key={item.line.id ?? `pendolo-line-${item.index}`}
                                    className="absolute transition-opacity duration-300 pointer-events-auto cursor-pointer"
                                    style={{
                                        left: `${item.x}px`,
                                        top: `${item.y}px`,
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
                                        className="relative inline-block"
                                        style={{ transform: `rotate(${item.angleDeg * 0.35}deg) scale(${item.scale})`, transformOrigin: 'left center' }}
                                    >
                                        <div style={{ transform: 'translateY(-50%)' }}>
                                            {isFocal ? (
                                                <PendoloActiveLyricSweep
                                                    line={item.line}
                                                    currentTime={currentTime}
                                                    fontFamily={fontFamily}
                                                    fontWeight={fontWeight}
                                                    maxWidth={maxTextWidth}
                                                    primaryTextColor={primaryTextColor}
                                                    accentTextColor={accentTextColor}
                                                />
                                            ) : (
                                                <div
                                                    className="transition-all duration-200 whitespace-pre-wrap"
                                                    style={{
                                                        fontSize: '22px',
                                                        maxWidth: `${maxTextWidth}px`,
                                                        color: colorWithAlpha(primaryTextColor, 0.75),
                                                        letterSpacing: '0.01em',
                                                        whiteSpace: 'pre-wrap',
                                                        overflowWrap: 'anywhere',
                                                        wordBreak: 'break-word',
                                                    }}
                                                >
                                                    {item.line.fullText}
                                                </div>
                                            )}
                                        </div>
                                    {/* Secondary Translation / Romanization Line */}
                                    {(displayTranslation || displayRomanization) && (
                                        <div
                                            className="whitespace-pre-wrap transition-opacity duration-200"
                                            style={{
                                                fontSize: isFocal ? '16px' : '12px',
                                                maxWidth: `${maxTextWidth}px`,
                                                color: isFocal ? secondaryTextColor : colorWithAlpha(secondaryTextColor, 0.6),
                                                letterSpacing: '0.01em',
                                                whiteSpace: 'pre-wrap',
                                                overflowWrap: 'anywhere',
                                                wordBreak: 'break-word',
                                                transform: 'translateY(-50%)',
                                                marginTop: isFocal ? '-0.7em' : '-0.4em',
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
        </VisualizerShell>
    );
};

export default React.memo(VisualizerPendolo);
