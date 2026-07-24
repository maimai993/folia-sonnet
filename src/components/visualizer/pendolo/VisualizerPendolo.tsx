import React, { useMemo, useState, useEffect } from 'react';
import { motion, useSpring, useMotionValueEvent } from 'framer-motion';
import {
    DEFAULT_PENDOLO_TUNING,
    type Line,
} from '../../../types';
import { colorWithAlpha } from '../colorMix';
import { type VisualizerSharedProps } from '../definition';
import { useVisualizerRuntime } from '../runtime';
import VisualizerShell from '../VisualizerShell';
import VisualizerSubtitleOverlay from '../VisualizerSubtitleOverlay';
import PendoloClockworkCanvas from './PendoloClockworkCanvas';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { calculatePendoloWheelLayout, measurePendoloLineWidth } from './pendoloGeometry';

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

    const [springLineVal, setSpringLineVal] = useState(targetLineIndex);
    useMotionValueEvent(tickSpring, 'change', (val) => {
        setSpringLineVal(val);
    });

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
    const escapementAngleOffsetRad = -(springLineVal - targetLineIndex) * angleStepRad;

    // Absolute gear rotation angle (ratchets smoothly with springLineVal when lyric lines switch)
    const gearRotationAngleRad = springLineVal * angleStepRad;

    // Read current bass motion value for canvas
    const currentBass = audioBands.bass.get();

    // Calculate line items for wheel
    const lineItems = useMemo(() => {
        return calculatePendoloWheelLayout(
            lines,
            targetLineIndex,
            escapementAngleOffsetRad,
            viewportSize.width,
            viewportSize.height,
            pendoloTuning,
        );
    }, [lines, targetLineIndex, escapementAngleOffsetRad, viewportSize, pendoloTuning]);

    const primaryTextColor = theme.primaryColor || '#FFFFFF';
    const accentTextColor = theme.accentColor || '#3B82F6';
    const secondaryTextColor = theme.secondaryColor || '#9CA3AF';

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
                    escapementAngleRad={gearRotationAngleRad}
                    audioBassMotionValue={audioBands.bass}
                    primaryTextColor={primaryTextColor}
                    accentTextColor={accentTextColor}
                    showGearDecor={pendoloTuning.showGearDecor}
                />

                {/* Lyric Wheel Arc Items */}
                {showText && (
                    <div className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 2 }}>
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
                                        transform: `translate(0, -50%) rotate(${item.angleDeg * 0.35}deg) scale(${item.scale})`,
                                        transformOrigin: 'left center',
                                        opacity: item.alpha,
                                        fontFamily,
                                        fontWeight,
                                    }}
                                    onClick={() => onLyricLineSeek?.(item.line.startTime)}
                                >
                                    {/* Main Lyric Text */}
                                    <div
                                        className="whitespace-nowrap transition-all duration-200"
                                        style={{
                                            fontSize: isFocal ? '28px' : '22px',
                                            color: isFocal ? primaryTextColor : colorWithAlpha(primaryTextColor, 0.75),
                                            textShadow: isFocal
                                                ? `0 0 20px ${colorWithAlpha(accentTextColor, 0.45)}`
                                                : 'none',
                                            letterSpacing: isFocal ? '0.02em' : '0.01em',
                                        }}
                                    >
                                        {item.line.fullText}
                                    </div>

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
                            );
                        })}
                    </div>
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

export default VisualizerPendolo;
