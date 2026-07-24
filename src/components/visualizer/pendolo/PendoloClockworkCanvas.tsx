import React, { useEffect, useRef } from 'react';
import type { MotionValue } from 'framer-motion';
import { colorWithAlpha } from '../colorMix';

// src/components/visualizer/pendolo/PendoloClockworkCanvas.tsx

export interface PendoloClockworkCanvasProps {
    centerX: number;
    centerY: number;
    baseRadius: number;
    lyricRingRadius: number;
    escapementAngleMotionValue: MotionValue<number>;
    audioBassMotionValue?: MotionValue<number>;
    audioBass?: number;
    primaryTextColor: string;
    accentTextColor: string;
    showGearDecor: 'none' | 'subtle' | 'full';
    paused?: boolean;
}

/**
 * Draws wireframe gear with N trapezoidal gear teeth.
 */
function drawGearTeeth(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    teethCount: number,
    toothDepth: number,
    rotationRad: number,
    strokeColor: string,
    lineWidth: number,
    fillColor?: string,
) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotationRad);

    const innerR = radius - toothDepth;
    const outerR = radius;
    const anglePerTooth = (Math.PI * 2) / teethCount;

    ctx.beginPath();
    for (let i = 0; i < teethCount; i++) {
        const baseAngle = i * anglePerTooth;
        const a0 = baseAngle - anglePerTooth * 0.22;
        const a1 = baseAngle - anglePerTooth * 0.12;
        const a2 = baseAngle + anglePerTooth * 0.12;
        const a3 = baseAngle + anglePerTooth * 0.22;

        const x0 = innerR * Math.cos(a0);
        const y0 = innerR * Math.sin(a0);
        const x1 = outerR * Math.cos(a1);
        const y1 = outerR * Math.sin(a1);
        const x2 = outerR * Math.cos(a2);
        const y2 = outerR * Math.sin(a2);
        const x3 = innerR * Math.cos(a3);
        const y3 = innerR * Math.sin(a3);

        if (i === 0) {
            ctx.moveTo(x0, y0);
        } else {
            ctx.lineTo(x0, y0);
        }
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x3, y3);
    }
    ctx.closePath();

    if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fill();
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    ctx.restore();
}

/**
 * Draws a spoked wheel with circular weight reduction windows.
 */
function drawSpokedWheel(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    hubR: number,
    rimR: number,
    spokeCount: number,
    rotationRad: number,
    strokeColor: string,
    lineWidth: number,
) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotationRad);

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;

    // Hub & Rim circles
    ctx.beginPath();
    ctx.arc(0, 0, hubR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, rimR, 0, Math.PI * 2);
    ctx.stroke();

    // Radial Spokes
    const angleStep = (Math.PI * 2) / spokeCount;
    for (let i = 0; i < spokeCount; i++) {
        const a = i * angleStep;
        ctx.beginPath();
        ctx.moveTo(hubR * Math.cos(a), hubR * Math.sin(a));
        ctx.lineTo(rimR * Math.cos(a), rimR * Math.sin(a));
        ctx.stroke();
    }

    // Weight reduction cutout holes along mid-radius
    const midR = (hubR + rimR) * 0.5;
    const holeR = (rimR - hubR) * 0.22;
    for (let i = 0; i < spokeCount; i++) {
        const a = i * angleStep + angleStep * 0.5;
        ctx.beginPath();
        ctx.arc(midR * Math.cos(a), midR * Math.sin(a), holeR, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Draws wireframe spiral hairspring (游丝).
 */
function drawHairspring(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    startR: number,
    endR: number,
    coils: number,
    oscillationRad: number,
    strokeColor: string,
    lineWidth: number,
) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(oscillationRad);

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;

    const totalAngle = coils * Math.PI * 2;
    const steps = coils * 60;

    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const angle = t * totalAngle;
        const r = startR + (endR - startR) * Math.pow(t, 0.9);
        const x = r * Math.cos(angle);
        const y = r * Math.sin(angle);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.restore();
}

/**
 * PendoloClockworkCanvas: Renders dynamic wireframe clockwork gear train background.
 */
const PendoloClockworkCanvas: React.FC<PendoloClockworkCanvasProps> = ({
    centerX,
    centerY,
    baseRadius,
    lyricRingRadius,
    escapementAngleMotionValue,
    audioBassMotionValue,
    audioBass = 0.18,
    primaryTextColor,
    accentTextColor,
    showGearDecor,
    paused = false,
}) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const phaseRef = useRef(0);
    const smoothedBassRef = useRef(0.15);
    const lastTimestampRef = useRef<number | null>(null);
    const secondGearElapsedRef = useRef(0);
    const secondGearStepRef = useRef(0);
    const secondGearAngleRef = useRef(0);
    const secondGearVelocityRef = useRef(0);

    const propsRef = useRef({
        centerX,
        centerY,
        baseRadius,
        lyricRingRadius,
        audioBass,
        primaryTextColor,
        accentTextColor,
        showGearDecor,
        paused,
    });

    useEffect(() => {
        propsRef.current = {
            centerX,
            centerY,
            baseRadius,
            lyricRingRadius,
            audioBass,
            primaryTextColor,
            accentTextColor,
            showGearDecor,
            paused,
        };
    }, [centerX, centerY, baseRadius, lyricRingRadius, audioBass, primaryTextColor, accentTextColor, showGearDecor, paused]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || showGearDecor === 'none') return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;

        const render = (timestamp: number) => {
            const p = propsRef.current;
            if (p.showGearDecor === 'none') return;

            if (lastTimestampRef.current === null) {
                lastTimestampRef.current = timestamp;
            }
            const dt = Math.min((timestamp - lastTimestampRef.current) / 1000, 0.05);
            lastTimestampRef.current = timestamp;

            // Fetch real-time audio bass value directly from MotionValue (handling 0..255 byte scale)
            const val = audioBassMotionValue ? audioBassMotionValue.get() : p.audioBass;
            const normBass = val > 1.0 ? val / 255 : val;
            const clampedBass = Math.max(0, Math.min(1, normBass));
            smoothedBassRef.current += (clampedBass - smoothedBassRef.current) * 0.12;
            const bass = smoothedBassRef.current;

            // 1. Balance wheel phase accumulation & harmonic swing (Audio Bass regulator)
            if (!p.paused) {
                phaseRef.current += dt * (2.8 + bass * 3.5);
                secondGearElapsedRef.current += dt;
                const completedSteps = Math.floor(secondGearElapsedRef.current);
                if (completedSteps > 0) {
                    secondGearStepRef.current += completedSteps;
                    secondGearElapsedRef.current -= completedSteps;
                }
                const secondGearTarget = secondGearStepRef.current * (Math.PI * 2 / 15);
                const displacement = secondGearTarget - secondGearAngleRef.current;
                secondGearVelocityRef.current += displacement * 92 * dt;
                secondGearVelocityRef.current *= Math.exp(-13 * dt);
                secondGearAngleRef.current += secondGearVelocityRef.current * dt;
            }
            const bassOscillation = Math.sin(phaseRef.current) * (0.15 + bass * 0.70);

            // 2. Main gear wheel angle is strictly tied to lyric line ratchet steps
            // Gears remain stationary while a line is being sung, and ratchet ONLY when lyrics switch
            const currentGearAngle = escapementAngleMotionValue.get();

            const width = canvas.offsetWidth;
            const height = canvas.offsetHeight;
            const dpr = window.devicePixelRatio || 1;

            if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
                canvas.width = width * dpr;
                canvas.height = height * dpr;
            }

            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, width, height);

            const isFull = p.showGearDecor === 'full';
            const decorOpacityMultiplier = isFull ? 1.0 : 0.6;

            const primaryAlpha15 = colorWithAlpha(p.primaryTextColor, 0.15 * decorOpacityMultiplier);
            const primaryAlpha25 = colorWithAlpha(p.primaryTextColor, 0.25 * decorOpacityMultiplier);
            const accentAlpha20 = colorWithAlpha(p.accentTextColor, 0.20 * decorOpacityMultiplier);
            const accentAlpha35 = colorWithAlpha(p.accentTextColor, 0.35 * decorOpacityMultiplier);
            const accentAlpha50 = colorWithAlpha(p.accentTextColor, 0.50 * decorOpacityMultiplier);
            // Keep lyric guide rings/ticks subtle; lift only the mechanical assembly above them.
            const gearPrimaryAlpha = colorWithAlpha(p.primaryTextColor, 0.42 * decorOpacityMultiplier);
            const gearPrimarySubtleAlpha = colorWithAlpha(p.primaryTextColor, 0.32 * decorOpacityMultiplier);
            const gearAccentAlpha = colorWithAlpha(p.accentTextColor, 0.58 * decorOpacityMultiplier);
            const gearAccentStrongAlpha = colorWithAlpha(p.accentTextColor, 0.72 * decorOpacityMultiplier);
            const planetGearAlpha = colorWithAlpha(p.primaryTextColor, 0.24 * decorOpacityMultiplier);

            // 1. Technical Radial Ticks & Concentric Guide Rings
            ctx.strokeStyle = primaryAlpha15;
            ctx.lineWidth = 1;

            const ringRadii = [p.baseRadius * 0.3, p.baseRadius * 0.6, p.baseRadius * 0.85, p.baseRadius * 1.15, p.baseRadius * 1.4];
            ringRadii.forEach((r) => {
                ctx.beginPath();
                ctx.arc(p.centerX, p.centerY, r, 0, Math.PI * 2);
                ctx.stroke();
            });

            // Outer Technical Radial Ticks around main wheel (every 6 deg)
            const tickCount = 60;
            const outerTickR = p.baseRadius * 1.15;
            for (let i = 0; i < tickCount; i++) {
                const angle = (i * Math.PI * 2) / tickCount + currentGearAngle * 0.2;
                const isMajor = i % 5 === 0;
                const tickLen = isMajor ? 12 : 6;
                const x1 = p.centerX + outerTickR * Math.cos(angle);
                const y1 = p.centerY + outerTickR * Math.sin(angle);
                const x2 = p.centerX + (outerTickR + tickLen) * Math.cos(angle);
                const y2 = p.centerY + (outerTickR + tickLen) * Math.sin(angle);

                ctx.strokeStyle = isMajor ? accentAlpha35 : primaryAlpha15;
                ctx.lineWidth = isMajor ? 1.5 : 1;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }

            // 2. Main Escapement Gear Wheel (Outer Rim)
            drawGearTeeth(
                ctx,
                p.centerX,
                p.centerY,
                p.baseRadius + 8,
                36,
                10,
                currentGearAngle,
                gearAccentAlpha,
                2.2,
                colorWithAlpha(p.accentTextColor, 0.08 * decorOpacityMultiplier),
            );

            // Inner Escapement Spoked Ring
            drawSpokedWheel(
                ctx,
                p.centerX,
                p.centerY,
                p.baseRadius * 0.2,
                p.baseRadius * 0.85,
                6,
                currentGearAngle,
                gearPrimaryAlpha,
                1.8,
            );

            // 3. Center Hub & Sun Gear Pinion
            drawGearTeeth(
                ctx,
                p.centerX,
                p.centerY,
                p.baseRadius * 0.22,
                12,
                6,
                -currentGearAngle * 2.5,
                gearAccentStrongAlpha,
                2.1,
            );

            // 4. Orbiting Planetary Gear Set (Full mode only or subtle reduced)
            const planetCount = 3;
            const orbitR = p.baseRadius * 0.52;
            const planetR = p.baseRadius * 0.16;
            const orbitAngleBase = currentGearAngle * 0.4;

            for (let planetIdx = 0; planetIdx < planetCount; planetIdx++) {
                const planetAngle = orbitAngleBase + (planetIdx * Math.PI * 2) / planetCount;
                const px = p.centerX + orbitR * Math.cos(planetAngle);
                const py = p.centerY + orbitR * Math.sin(planetAngle);

                // Planet gear body
                drawGearTeeth(
                    ctx,
                    px,
                    py,
                    planetR,
                    14,
                    5,
                    -currentGearAngle * 3 + planetIdx * 0.5,
                    planetGearAlpha,
                    1.7,
                );

                // Planet axle pivot point
                ctx.fillStyle = gearAccentStrongAlpha;
                ctx.beginPath();
                ctx.arc(px, py, 3, 0, Math.PI * 2);
                ctx.fill();
            }

            // 5. Upper-left decorative gear
            const balanceCx = p.centerX + p.baseRadius * 0.2;
            const balanceCy = p.centerY - p.baseRadius * 0.75;
            const balanceR = p.baseRadius * 0.28;
            const balanceGearAngle = phaseRef.current * 0.1;
            drawGearTeeth(
                ctx,
                balanceCx,
                balanceCy,
                balanceR,
                20,
                7,
                balanceGearAngle,
                gearAccentStrongAlpha,
                2.1,
                colorWithAlpha(p.accentTextColor, 0.10 * decorOpacityMultiplier),
            );
            // The inner ring reserves a quiet circular seat for the non-rotating icon overlay.
            ctx.strokeStyle = gearPrimarySubtleAlpha;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.arc(balanceCx, balanceCy, balanceR * 0.52, 0, Math.PI * 2);
            ctx.stroke();

            // Meshing Intermediate Transmission Gear (Lower-Left Offset)
            const transCx = p.centerX + p.baseRadius * 0.32;
            const transCy = p.centerY + p.baseRadius * 0.78;
            const transR = p.baseRadius * 0.34;
            drawGearTeeth(
                ctx,
                transCx,
                transCy,
                transR,
                24,
                7,
                -currentGearAngle * 1.4,
                gearPrimaryAlpha,
                1.8,
            );
            drawSpokedWheel(
                ctx,
                transCx,
                transCy,
                transR * 0.25,
                transR * 0.85,
                5,
                -currentGearAngle * 1.4,
                gearPrimarySubtleAlpha,
                1.5,
            );

            // Seconds gear: advances one tooth at a time on each active playback second.
            const secondGearTeeth = 15;
            const secondGearCx = p.centerX + p.baseRadius * 0.68;
            const secondGearCy = p.centerY + p.baseRadius * 0.76;
            const secondGearR = p.baseRadius * 0.16;
            const secondGearAngle = secondGearAngleRef.current;
            drawGearTeeth(
                ctx,
                secondGearCx,
                secondGearCy,
                secondGearR,
                secondGearTeeth,
                5,
                secondGearAngle,
                gearAccentAlpha,
                1.8,
                colorWithAlpha(p.accentTextColor, 0.06 * decorOpacityMultiplier),
            );
            drawSpokedWheel(
                ctx,
                secondGearCx,
                secondGearCy,
                secondGearR * 0.28,
                secondGearR * 0.76,
                4,
                -secondGearAngle,
                gearPrimarySubtleAlpha,
                1.3,
            );

            // 6. Escapement Focal Axis Alignment Line (Horizontal 0 deg)
            const focalAxisEndRadius = Math.min(
                p.lyricRingRadius - Math.max(14, p.baseRadius * 0.025),
            );
            ctx.strokeStyle = gearAccentStrongAlpha;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p.centerX + p.baseRadius * 0.8, p.centerY);
            ctx.lineTo(p.centerX + focalAxisEndRadius, p.centerY);
            ctx.stroke();

            // Focal Arrowhead Indicator
            const arrowX = p.centerX + focalAxisEndRadius;
            ctx.fillStyle = gearAccentStrongAlpha;
            ctx.beginPath();
            ctx.moveTo(arrowX, p.centerY - 4);
            ctx.lineTo(arrowX + 8, p.centerY);
            ctx.lineTo(arrowX, p.centerY + 4);
            ctx.closePath();
            ctx.fill();

            ctx.restore();

            animationFrameId = window.requestAnimationFrame(render);
        };

        animationFrameId = window.requestAnimationFrame(render);

        return () => {
            if (animationFrameId) {
                window.cancelAnimationFrame(animationFrameId);
            }
        };
    }, [showGearDecor, audioBassMotionValue, escapementAngleMotionValue]);

    if (showGearDecor === 'none') {
        return null;
    }

    return (
        <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 1 }}
        />
    );
};

export default PendoloClockworkCanvas;
