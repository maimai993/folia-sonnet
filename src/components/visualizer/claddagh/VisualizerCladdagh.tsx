// Only for the you who has yet to exist in this world.
// DO NOT REMOVE THE LINE ABOVE.
import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useMotionValue, animate, useSpring, motion, useTransform } from 'framer-motion';
import { DEFAULT_CLADDAGH_TUNING } from '../../../types';
import { buildLineGraphemeTimeline } from '../../../utils/lyrics/graphemeTiming';
import { resolveThemeFontStack, resolveThemeFontWeight, resolveThemeTranslationFontStack } from '../../../utils/fontStacks';
import { type VisualizerSharedProps } from '../definition';
import { useVisualizerRuntime } from '../runtime';
import { colorWithAlpha, mixColors } from '../../../utils/visualizer/colorMix';
import VisualizerShell from '../VisualizerShell';
import VisualizerSubtitleOverlay from '../VisualizerSubtitleOverlay';
import { adjustCladdaghTimeline } from './claddaghTimeline';
import { buildMeasuredSpacingInfo } from './claddaghLayout';
import { RingLine } from './CladdaghRingLine';
import { isLyricFlat } from '../../../utils/lyricFlat';
import { musicSway } from '../../../stores/motionSignals';
import { useEffectTrack } from '../../../services/beatFx/effectTracks';
import { getBeatEffectStrength } from '../../../services/beatFx/beatFxLive';
import { BEAT_EFFECT_IDS } from '../../../services/beatFx/beatEffects';

// src/components/visualizer/claddagh/VisualizerCladdagh.tsx

const VisualizerCladdagh: React.FC<VisualizerSharedProps> = (props) => {
    const {
        currentTime,
        currentLineIndex,
        lines,
        theme,
        subtitleTheme,
        showText = true,
        lyricsFontScale = 1.0,
        subtitleFontScale = 1,
        subtitleOverlayOpacity,
        subtitleOverlayBackground,
        subtitleUpcomingLyricsBlur,
        hideTranslationSubtitle,
        subtitleOverlayLayout,
        audioPower,
        audioBands,
        claddaghTuning = DEFAULT_CLADDAGH_TUNING,
        paused = false,
    } = props;

    // 圆环的位置（#1124）：画面宽、高的百分比，0 在正中。轴线和歌词一起挪。
    const positionX = claddaghTuning.positionX ?? 0;
    const positionY = claddaghTuning.positionY ?? 0;
    // 沿圆环的翻译（#1124）：只在开关打开时画，字体跟副字幕的主题。
    const showRingTranslation = claddaghTuning.showTranslation === true;
    const translationFontStack = resolveThemeTranslationFontStack(subtitleTheme ?? theme);
    const translationFontWeight = resolveThemeFontWeight(subtitleTheme ?? theme, 600);

    const centerNormalTiltDeg = 90 - claddaghTuning.ellipseTiltDeg;

    const isRawScaleRef = useRef(false);
    const glowIntensityRef = useRef(0);
    const normalizePower = useCallback((power: number) => {
        if (!Number.isFinite(power)) return 0;
        if (power > 1.0) {
            isRawScaleRef.current = true;
        }
        return Math.max(0, Math.min(1, isRawScaleRef.current ? power / 255 : power));
    }, []);

    const { activeLine, upcomingLine, recentCompletedLine, nextLines } = useVisualizerRuntime({
        currentTime,
        currentLineIndex,
        lines,
    });

    const isChorus = activeLine?.isChorus ?? false;

    const smoothedBass = useSpring(audioBands.bass, {
        stiffness: 150,
        damping: 25,
    });
    const smoothedVocal = useSpring(audioBands.vocal, {
        stiffness: 120,
        damping: 24,
    });
    const fontStack = resolveThemeFontStack(theme);
    const baseFontSize = 72 * lyricsFontScale;
    const fontWeight = resolveThemeFontWeight(theme, 700);
    const fontSpec = `${fontWeight} ${baseFontSize}px ${fontStack}`;

    const containerRef = useRef<HTMLDivElement>(null);
    const axisLineRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

    // Smoothly animate axis line color and scale in response to audio power
    useEffect(() => {
        const lineEl = axisLineRef.current;
        if (!lineEl) return;

        let frameId = 0;

        const updateColors = () => {
            const bassPower = paused ? 0 : normalizePower(smoothedBass.get());
            const vocalPower = paused ? 0 : normalizePower(smoothedVocal.get());
            const fromColor = theme.primaryColor || '#ffffff';
            let toColor = theme.accentColor || '#ffffff';
            // If primary and accent are the same, try secondary
            if (toColor === fromColor && theme.secondaryColor) {
                toColor = theme.secondaryColor;
            }
            // If still the same, mix with white to guarantee visual color change on beats
            if (toColor === fromColor) {
                toColor = '#ffffff';
            }

            // Color response (using maximum of bass and vocal energy for high responsiveness)
            const colorPower = Math.max(bassPower, vocalPower);
            const colorDelta = Math.max(0, colorPower - 0.02);
            const colorRatio = Math.min(1.0, colorDelta / 0.58);

            // Mix between fromColor and toColor, pulsing alpha from 0.2 to 0.95 (vivid color beat)
            const mixed = mixColors(fromColor, toColor, colorRatio, 0.2 + 0.75 * colorRatio);

            // Linear-gradient fades out the line at its top-left and bottom-right endpoints (20% and 80%)
            // so that the endpoints of the short segment are smoothly blurred/faded.
            const gradientString = `linear-gradient(90deg, transparent, ${mixed} 20%, ${mixed} 80%, transparent)`;
            lineEl.style.background = gradientString;
            lineEl.style.backgroundImage = gradientString;

            // Square the bass power value to expand the dynamic range and prevent easy saturation for length scaling
            const bassSqr = bassPower * bassPower;

            // Apply dynamic length scaling using scaleX and subtle thickness scaling using scaleY
            const scaleX = 1.0 + bassSqr * 1.5;
            const scaleY = 1.0 + bassSqr * 0.5;
            lineEl.style.transform = `translate(-50%, -50%) rotate(${centerNormalTiltDeg}deg) scale(${scaleX}, ${scaleY})`;

            // Smoothly transition glow intensity (transition duration ~330ms at 60fps)
            const targetIntensity = isChorus ? 1.0 : 0.0;
            const diff = targetIntensity - glowIntensityRef.current;
            if (Math.abs(diff) > 0.01) {
                glowIntensityRef.current += Math.sign(diff) * 0.05;
                glowIntensityRef.current = Math.max(0, Math.min(1, glowIntensityRef.current));
            } else {
                glowIntensityRef.current = targetIntensity;
            }

            const glowIntensity = glowIntensityRef.current;
            // 扁平化时不给光（这里每帧都在重写内联 filter，靠 CSS 抢优先级不如源头不给）。
            if (glowIntensity > 0.001 && !isLyricFlat()) {
                const glowSize = (4 + bassPower * 12) * glowIntensity;
                const glowColor = colorWithAlpha(mixed, glowIntensity);
                lineEl.style.filter = `drop-shadow(0 0 ${glowSize.toFixed(1)}px ${glowColor})`;
            } else {
                lineEl.style.filter = 'none';
            }

            frameId = requestAnimationFrame(updateColors);
        };

        frameId = requestAnimationFrame(updateColors);

        return () => {
            cancelAnimationFrame(frameId);
        };
    }, [smoothedBass, smoothedVocal, theme.primaryColor, theme.accentColor, theme.secondaryColor, centerNormalTiltDeg, paused, isChorus, claddaghTuning.showAxisLine]);

    // Initialize dimensions on mount to avoid zero size on first render
    useEffect(() => {
        const container = containerRef.current;
        if (container) {
            const rect = container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                setDimensions({ width: rect.width, height: rect.height });
            }
        }
        // Track container dimensions responsively using ResizeObserver
        const observer = new ResizeObserver(entries => {
            const entry = entries[0];
            if (entry) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    setDimensions({ width, height });
                }
            }
        });
        if (container) observer.observe(container);
        return () => observer.disconnect();
    }, []);

    // Radial configuration (increased to prevent long sentence overlaps)
    const Rx = (dimensions.width > 0 ? Math.min(dimensions.width * 0.44, 560) : 360) * claddaghTuning.radiusScale;
    const Ry = Rx > 0 ? Rx * 0.707 : 254; // 45-degree angle projection ratio
    const focusSpacingScale = (1 + claddaghTuning.focusScaleRatio) / (1 + DEFAULT_CLADDAGH_TUNING.focusScaleRatio);
    const activeTextSpacingScale = focusSpacingScale;

    if (typeof window !== 'undefined') {
        (window as any).visualizerDimensions = dimensions;
        (window as any).visualizerRx = Rx;
        (window as any).visualizerRy = Ry;
    }

    // Determine the focus line index
    const focusIndex = currentLineIndex !== -1
        ? currentLineIndex
        : (recentCompletedLine
            ? lines.indexOf(recentCompletedLine)
            : -1);
    const centerLineIndex = Math.max(-1, focusIndex);
    const [renderBaseIndex, setRenderBaseIndex] = useState(centerLineIndex);

    const activeSpacingInfo = useMemo(() => {
        const line = lines[renderBaseIndex];
        if (!line) return [];
        const timeline = adjustCladdaghTimeline(buildLineGraphemeTimeline(line), line);
        return buildMeasuredSpacingInfo(timeline, fontSpec, baseFontSize, Rx, activeTextSpacingScale, claddaghTuning.letterSpacingOffset);
    }, [lines, renderBaseIndex, fontSpec, baseFontSize, Rx, activeTextSpacingScale, claddaghTuning.letterSpacingOffset]);

    // Coordinate rotation offsets using MotionValue for line transition自转 animations
    const lineOffset = useMotionValue(centerLineIndex * Math.PI);
    const lastIndexRef = useRef(centerLineIndex);

    useEffect(() => {
        const prev = lastIndexRef.current;
        const curr = centerLineIndex;
        lastIndexRef.current = curr;

        if (Math.abs(curr - prev) > 1) {
            lineOffset.set(curr * Math.PI);
            setRenderBaseIndex(curr);
        } else {
            // Update renderBaseIndex immediately so activeSpacingInfo tracks
            // the new active line from the start. This prevents the wordOffset
            // discontinuity that occurred when onComplete switched it later.
            setRenderBaseIndex(curr);
            const controls = animate(lineOffset, curr * Math.PI, {
                type: 'spring',
                stiffness: 55,
                damping: 14,
                mass: 0.9,
            });
            return () => controls.stop();
        }
    }, [centerLineIndex, lineOffset]);

    // Keep the transition pair + one preceding line rendered so the outgoing
    // line remains visible during the spring rotation.
    const lineIndicesToRender = useMemo(() => {
        const indices = [];
        if (lines.length === 0) return [];
        for (let i = renderBaseIndex - 1; i <= renderBaseIndex + 2; i++) {
            if (i >= 0 && i < lines.length) {
                indices.push(i);
            }
        }
        if (indices.length === 0) {
            indices.push(Math.max(0, Math.min(centerLineIndex, lines.length - 1)));
        }
        return indices;
    }, [centerLineIndex, lines.length, renderBaseIndex]);

    /*
     * 智能动感（结环）：这一套整个画面就是一枚斜着的环，「环倾」当然是倾角本身 ——
     * 低频一下整个环绕中心晃一点，乐句推过来时珠串再往下沉一点，都是它本来就有的语义。
     *
     * 珠串这一条原来读 kick：底鼓每敲一下，环上的字连同珠串一起往下弹 —— 真机上就是
     * 「歌词在抖」。环上挂的是字，字该跟着乐句走。现在两条都走 `effectTracks` 的表：
     * 环倾登记的是伴奏（harmony / pad），珠串登记的是人声 —— 两条都不含鼓。
     */
    const ringTiltStrength = getBeatEffectStrength(BEAT_EFFECT_IDS.claddaghRingTilt);
    const beadHopStrength = getBeatEffectStrength(BEAT_EFFECT_IDS.claddaghBeadHop);
    const ringTiltLevel = useEffectTrack(BEAT_EFFECT_IDS.claddaghRingTilt);
    const beadHopLevel = useEffectTrack(BEAT_EFFECT_IDS.claddaghBeadHop);
    const ringTilt = useTransform(ringTiltLevel,
        value => Math.min(1, value * 1.6) * 2.6 * ringTiltStrength);
    /*
     * 珠串下沉也过一道段落门槛：结环这套整个画面只有这枚环，安静段里它还在一下一下
     * 往下沉，看起来就是「字在抖」。前奏 / 间奏几乎不动，副歌才跟着乐句沉。
     */
    const beadHop = useTransform(
        [beadHopLevel, musicSway],
        ([body, sway]: number[]) => -Math.min(1, body * 1.5) * 7 * beadHopStrength * (0.12 + sway * 0.88),
    );

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={props}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.96, filter: 'blur(4px)' }}
                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, scale: 1.04, filter: 'blur(4px)' }}
                transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                ref={containerRef}
                className="relative flex flex-col items-center justify-center w-full h-full overflow-hidden select-none"
            >
                {/* Background Dedicated Visuals */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none z-[1]">
                    {/* Center Axis Line with blurred/faded endpoints */}
                    {claddaghTuning.showAxisLine && (
                        <div
                            ref={axisLineRef}
                            style={{
                                position: 'absolute',
                                left: `${50 + positionX}%`,
                                top: `${50 + positionY}%`,
                                width: '300px',
                                height: '4px',
                                transform: `translate(-50%, -50%) rotate(${centerNormalTiltDeg}deg) scale(1, 1)`,
                                transformOrigin: 'center center',
                                willChange: 'background, transform, filter',
                            }}
                        />
                    )}
                </div>

                <motion.div
                    style={(ringTiltStrength > 0 || beadHopStrength > 0)
                        ? { rotate: ringTilt, y: beadHop, transformOrigin: '50% 50%' }
                        : undefined}
                >
                    <div
                        style={{
                            width: '100%',
                            height: '100%',
                            position: 'relative',
                            zIndex: 10,
                            // Percentages of this box, which is the whole stage: the ring's centre moves by the tuning's share of it.
                            transform: positionX !== 0 || positionY !== 0 ? `translate(${positionX}%, ${positionY}%)` : undefined,
                        }}
                    >
                        {showText && Rx > 0 && Ry > 0 && lineIndicesToRender.map(idx => (
                            <RingLine
                                key={idx}
                                line={lines[idx]}
                                lineIndex={idx}
                                centerLineIndex={centerLineIndex}
                                currentTime={currentTime}
                                lineOffset={lineOffset}
                                theme={theme}
                                lyricsFontScale={lyricsFontScale}
                                Rx={Rx}
                                Ry={Ry}
                                audioPower={smoothedBass}
                                containerWidth={dimensions.width}
                                containerHeight={dimensions.height}
                                activeSpacingInfo={activeSpacingInfo}
                                renderBaseIndex={renderBaseIndex}
                                lines={lines}
                                focusScaleRatio={claddaghTuning.focusScaleRatio}
                                ellipseTiltDeg={claddaghTuning.ellipseTiltDeg}
                                textSpacingScale={activeTextSpacingScale}
                                letterSpacingOffset={claddaghTuning.letterSpacingOffset}
                                translation={showRingTranslation ? lines[idx].translation : undefined}
                                translationFontStack={translationFontStack}
                                translationFontWeight={translationFontWeight}
                                translationScale={claddaghTuning.translationScale ?? 1}
                                translationLetterSpacingOffset={claddaghTuning.translationLetterSpacingOffset ?? 0}
                            />
                        ))}
                    </div>
                </motion.div>
            </motion.div>

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
                    subtitleUpcomingLyricsBlur={subtitleUpcomingLyricsBlur}
                    subtitleFontScale={subtitleFontScale}
                    hideTranslationSubtitle={hideTranslationSubtitle}
                    subtitleOverlayLayout={subtitleOverlayLayout}
                />
            )}
        </VisualizerShell>
    );
};

export default VisualizerCladdagh;
