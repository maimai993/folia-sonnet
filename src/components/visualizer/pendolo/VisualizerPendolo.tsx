import React, { useMemo, useState, useEffect } from 'react';
import { motion, useSpring, useMotionValueEvent } from 'framer-motion';
import {
    DEFAULT_PENDOLO_TUNING,
    type Line,
} from '../../../types';
import { colorWithAlpha } from '../colorMix';
import { type VisualizerSharedProps } from '../definition';
import { useVisualizerRuntime } from '../runtime';
import { resolveThemeFontStack, resolveThemeFontWeight } from '../../../utils/fontStacks';
import { calculatePendoloWheelLayout, measurePendoloLineWidth } from './pendoloGeometry';

// src/components/visualizer/pendolo/VisualizerPendolo.tsx

/**
 * VisualizerPendolo: Escapement wheel & pendulum clockwork lyric visualizer.
 * Renders lyrics arranged in an adjustable circular arc on the left side of the screen.
 * Advance of song lines triggers a springy mechanical escapement ratchet step and subtle balance wheel oscillation.
 */
const VisualizerPendolo: React.FC<VisualizerSharedProps> = ({
    currentTime,
    currentLineIndex,
    lines,
    theme,
    audioBands,
    subtitleContentMode = 'translation',
    showSubtitleTranslation = true,
    pendoloTuning = DEFAULT_PENDOLO_TUNING,
    onLyricLineSeek,
}) => {

    const { activeLine } = useVisualizerRuntime({
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

    // Escapement spring motion for line transition tick
    const springSnappiness = pendoloTuning.tickSnappiness;
    const tickSpring = useSpring(0, {
        stiffness: 180 * springSnappiness,
        damping: 18 + 4 / Math.max(0.5, springSnappiness),
        mass: 0.8,
    });

    const [audioTickOffset, setAudioTickOffset] = useState(0);

    // Dynamic pendulum oscillation from audio bass band
    useMotionValueEvent(audioBands.bass, 'change', (latest) => {
        if (pendoloTuning.pendulumOscillation > 0) {
            const oscillationAmount = (latest - 0.2) * 0.035 * pendoloTuning.pendulumOscillation;
            setAudioTickOffset(Math.max(-0.05, Math.min(0.05, oscillationAmount)));
        }
    });

    // Update target escapement spring when currentLineIndex updates
    useEffect(() => {
        tickSpring.set(currentLineIndex);
    }, [currentLineIndex, tickSpring]);

    const [springLineVal, setSpringLineVal] = useState(currentLineIndex);
    useMotionValueEvent(tickSpring, 'change', (val) => {
        setSpringLineVal(val);
    });

    // Font stack & weight setup
    const fontFamily = useMemo(() => resolveThemeFontStack(theme), [theme]);
    const fontWeight = useMemo(() => resolveThemeFontWeight(theme, 400), [theme]);
    const fontSpec = `${fontWeight} 24px ${fontFamily}`;

    // Center and radius coordinates
    const centerX = viewportSize.width * (0.5 + pendoloTuning.wheelCenterX);
    const centerY = viewportSize.height * pendoloTuning.wheelCenterY;
    const baseRadius = Math.min(viewportSize.width, viewportSize.height) * pendoloTuning.arcRadius;

    // Escapement angular shift calculation
    const totalArcRad = (pendoloTuning.arcAngleDeg * Math.PI) / 180;
    const visibleWindowCount = 9;
    const angleStepRad = totalArcRad / Math.max(1, visibleWindowCount - 1);
    const escapementAngleOffsetRad = (springLineVal - currentLineIndex) * angleStepRad + audioTickOffset;

    // Calculate line items for wheel
    const lineItems = useMemo(() => {
        return calculatePendoloWheelLayout(
            lines,
            currentLineIndex,
            escapementAngleOffsetRad,
            viewportSize.width,
            viewportSize.height,
            pendoloTuning,
        );
    }, [lines, currentLineIndex, escapementAngleOffsetRad, viewportSize, pendoloTuning]);

    const primaryTextColor = theme.primaryColor || '#FFFFFF';
    const accentTextColor = theme.accentColor || '#3B82F6';
    const secondaryTextColor = theme.secondaryColor || '#9CA3AF';

    return (
        <div className="relative w-full h-full overflow-hidden select-none pointer-events-none">
            {/* Clockwork Gear & Escapement Scale Accents */}
            {pendoloTuning.showGearDecor !== 'none' && (
                <svg
                    className="absolute inset-0 w-full h-full pointer-events-none opacity-40"
                    style={{ zIndex: 1 }}
                >
                    <g transform={`translate(${centerX}, ${centerY})`}>
                        {/* Escapement Main Rim Circle */}
                        <circle
                            r={baseRadius}
                            fill="none"
                            stroke={colorWithAlpha(accentTextColor, 0.2)}
                            strokeWidth={pendoloTuning.showGearDecor === 'full' ? 2 : 1}
                            strokeDasharray={pendoloTuning.showGearDecor === 'full' ? '4 6' : '1 0'}
                        />

                        {/* Escapement Outer Gear Teeth Ring */}
                        <circle
                            r={baseRadius + 14}
                            fill="none"
                            stroke={colorWithAlpha(primaryTextColor, 0.12)}
                            strokeWidth="1.5"
                            strokeDasharray="2 12"
                        />

                        {/* Pivot Center Hub Markings */}
                        <circle
                            r={18}
                            fill="none"
                            stroke={colorWithAlpha(accentTextColor, 0.3)}
                            strokeWidth="1.5"
                        />
                        <circle
                            r={4}
                            fill={colorWithAlpha(accentTextColor, 0.4)}
                        />

                        {/* Focal Axis Indicator Line (Horizontal 0 deg) */}
                        <line
                            x1={baseRadius - 24}
                            y1={0}
                            x2={baseRadius + 32}
                            y2={0}
                            stroke={colorWithAlpha(accentTextColor, 0.4)}
                            strokeWidth="2"
                        />
                    </g>
                </svg>
            )}

            {/* Lyric Wheel Items */}
            <div className="relative w-full h-full z-10">
                {lineItems.map((item) => {
                    const isFocal = item.isActive;
                    const displayTranslation =
                        showSubtitleTranslation &&
                        subtitleContentMode === 'translation' &&
                        item.line.translation;

                    const displayRomanization =
                        showSubtitleTranslation &&
                        subtitleContentMode === 'romanization' &&
                        item.line.romanization;

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
                                className="whitespace-nowrap transition-colors duration-200"
                                style={{
                                    fontSize: isFocal ? '32px' : '20px',
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
        </div>
    );
};

export default VisualizerPendolo;
