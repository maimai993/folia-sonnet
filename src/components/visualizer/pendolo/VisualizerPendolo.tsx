import React, { useMemo, useState, useEffect, useRef } from 'react';
import { motion, useSpring, useTransform } from 'framer-motion';
import { Star, type LucideIcon } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { DEFAULT_PENDOLO_TUNING } from '../../../types';
import { colorWithAlpha } from '../colorMix';
import { type VisualizerSharedProps } from '../definition';
import VisualizerShell from '../VisualizerShell';
import PendoloClockworkCanvas from './PendoloClockworkCanvas';
import { resolveThemeFontStack, resolveThemeFontWeight, resolveThemeTranslationFontStack } from '../../../utils/fontStacks';
import { resolveSubtitleContentMode, resolveLyricAlternateText } from '../../../utils/lyrics/alternateText';
import { calculatePendoloWheelLayout } from './pendoloGeometry';
import PendoloActiveLyricSweep from './PendoloActiveLyricSweep';
import { buildPendoloTextLayout } from './pendoloTextLayout';

// src/components/visualizer/pendolo/VisualizerPendolo.tsx

/**
 * VisualizerPendolo: Escapement wheel & pendulum clockwork lyric visualizer.
 * Renders lyrics arranged in an adjustable circular arc on the left side of the screen.
 * Advance of song lines triggers a springy mechanical escapement ratchet step and subtle balance wheel motion.
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
        lyricsFontScale = 1,
        subtitleTheme,
        subtitleOverlayOpacity,
        subtitleOverlayBackground,
        subtitleFontScale,
        isPlayerChromeHidden = false,
        hideTranslationSubtitle = false,
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

    const centerX = viewportSize.width * pendoloTuning.wheelCenterX;
    const centerY = viewportSize.height * pendoloTuning.wheelCenterY;
    const baseRadius = Math.min(viewportSize.width, viewportSize.height) * pendoloTuning.arcRadius;
    const lyricRadiusOffset = Math.min(viewportSize.width, viewportSize.height) * 0.06;
    const lyricRingRadius = baseRadius + lyricRadiusOffset;

    const maxItemX = centerX + baseRadius;
    const availableTextWidth = Math.max(
        140,
        Math.min(viewportSize.width * 0.46, viewportSize.width - maxItemX - 48),
    );

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

    const resolvedMode = useMemo(() => resolveSubtitleContentMode(subtitleContentMode, showSubtitleTranslation), [subtitleContentMode, showSubtitleTranslation]);

    const lineBlockHeights = useMemo(() => {
        const measureWidth = availableTextWidth / pendoloTuning.activeScale;
        return lines.map((line, index) => {
            if (Math.abs(index - targetLineIndex) > 8) {
                return 0;
            }
            // Always pre-allocate space for the focal state to prevent overlapping when scaled up
            const fontPx = Math.round(28 * lyricsFontScale);
            const mainHeight = buildPendoloTextLayout(
                line.fullText,
                `${fontWeight} ${fontPx}px ${fontFamily}`,
                measureWidth,
                Math.round(fontPx * 1.2),
            ).height;

            const translation = hideTranslationSubtitle ? null : resolveLyricAlternateText(line, resolvedMode);
            const hasReadableText = !!translation && /[\p{L}\p{N}]/u.test(translation);
            const translationPx = Math.round(16 * (subtitleFontScale ?? 1));
            
            const translationHeight = hasReadableText
                ? buildPendoloTextLayout(
                    translation,
                    `${resolveThemeFontWeight(subtitleTheme ?? theme, 500)} ${translationPx}px ${resolveThemeTranslationFontStack(subtitleTheme ?? theme)}`,
                    measureWidth,
                    Math.round(translationPx * 1.2),
                ).height + translationPx * 0.25 // Equivalent to marginTop: 0.25em
                : 0;

            return (mainHeight + translationHeight) * pendoloTuning.activeScale;
        });
    }, [availableTextWidth, fontFamily, fontWeight, hideTranslationSubtitle, lines, lyricsFontScale, pendoloTuning.activeScale, resolvedMode, subtitleFontScale, subtitleTheme, targetLineIndex, theme]);

    // Calculate line items for wheel
    const lineItems = useMemo(() => {
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
                    lyricRingRadius={lyricRingRadius}
                    escapementAngleMotionValue={gearRotationAngleRad}
                    audioBassMotionValue={audioBands.bass}
                    primaryTextColor={primaryTextColor}
                    accentTextColor={accentTextColor}
                    backgroundColor={theme.backgroundColor}
                    showGearDecor={pendoloTuning.showGearDecor}
                    showCenterGradient={pendoloTuning.showCenterGradient ?? true}
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
                            const maxTextWidth = availableTextWidth / item.scale;
                            const fontPx = Math.round((isFocal ? 28 : 22) * lyricsFontScale);
                            const translation = hideTranslationSubtitle ? null : resolveLyricAlternateText(item.line, resolvedMode);
                            const hasReadableText = !!translation && /[\p{L}\p{N}]/u.test(translation);
                            const translationPx = Math.round((isFocal ? 16 : 12) * (subtitleFontScale ?? 1));

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
                                    <div
                                        className="relative inline-block"
                                        style={{ transform: `rotate(${item.angleDeg * 0.35}deg) scale(${item.scale})`, transformOrigin: 'left center' }}
                                    >
                                        <div style={{ transform: 'translateY(-50%)' }}>
                                            <div>
                                                {isFocal ? (
                                                    <PendoloActiveLyricSweep
                                                        line={item.line}
                                                        currentTime={currentTime}
                                                        fontFamily={fontFamily}
                                                        fontWeight={fontWeight}
                                                        maxWidth={maxTextWidth}
                                                        primaryTextColor={primaryTextColor}
                                                        accentTextColor={accentTextColor}
                                                        fontPx={fontPx}
                                                        wordColors={theme.wordColors}
                                                    />
                                                ) : (
                                                    <div
                                                        className="transition-all duration-200 whitespace-pre-wrap"
                                                        style={{
                                                            fontSize: `${fontPx}px`,
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
                                            {hasReadableText && (
                                                <div
                                                    className="whitespace-pre-wrap transition-opacity duration-200"
                                                    style={{
                                                        fontFamily: resolveThemeTranslationFontStack(subtitleTheme ?? theme),
                                                        fontWeight: resolveThemeFontWeight(subtitleTheme ?? theme, 500),
                                                        fontSize: `${translationPx}px`,
                                                        maxWidth: `${maxTextWidth}px`,
                                                        color: isFocal ? secondaryTextColor : colorWithAlpha(secondaryTextColor, 0.6),
                                                        letterSpacing: '0.01em',
                                                        whiteSpace: 'pre-wrap',
                                                        overflowWrap: 'anywhere',
                                                        wordBreak: 'break-word',
                                                        marginTop: '0.25em',
                                                    }}
                                                >
                                                    {translation}
                                                </div>
                                            )}
                                        </div>
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
