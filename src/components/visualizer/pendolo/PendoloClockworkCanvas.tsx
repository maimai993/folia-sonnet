import React, { useEffect, useRef } from 'react';
import type { MotionValue } from 'framer-motion';
import { colorWithAlpha } from '../colorMix';

// src/components/visualizer/pendolo/PendoloClockworkCanvas.tsx

export interface PendoloClockworkCanvasProps {
    centerX: number;
    centerY: number;
    baseRadius: number;
    escapementAngleRad: number;
    audioBassMotionValue?: MotionValue<number>;
    audioBass?: number;
    primaryTextColor: string;
    accentTextColor: string;
    showGearDecor: 'none' | 'subtle' | 'full';
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
 * Draws Swiss lever escapement pallet fork with red ruby pallet jewels (擒纵叉与红宝石瓦).
 */
function drawPalletFork(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    escapementRadius: number,
    forkAngleRad: number,
    accentColor: string,
    decorOpacityMultiplier: number,
) {
    ctx.save();
    // Position pallet fork at top-right rim of main escapement gear (~ -68 deg)
    const palletR = escapementRadius + 4;
    const palletAngle = -Math.PI * 0.38;
    const forkCx = cx + palletR * Math.cos(palletAngle);
    const forkCy = cy + palletR * Math.sin(palletAngle);

    ctx.translate(forkCx, forkCy);
    ctx.rotate(palletAngle + Math.PI * 0.5 + forkAngleRad);

    const strokeColor = colorWithAlpha(accentColor, 0.7 * decorOpacityMultiplier);
    const rubyColor = 'rgba(239, 68, 68, 0.9)'; // Red ruby jewel pallets

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.5;

    // Fork lever body & arbor
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -15);
    ctx.stroke();

    // Entry & Exit Pallet Arms
    const armW = 9;
    const armH = 6;
    ctx.beginPath();
    ctx.moveTo(-armW, armH);
    ctx.lineTo(0, 0);
    ctx.lineTo(armW, armH);
    ctx.stroke();

    // Entry Ruby Pallet Jewel (Left)
    ctx.fillStyle = rubyColor;
    ctx.beginPath();
    ctx.rect(-armW - 3, armH - 2, 4, 5);
    ctx.fill();

    // Exit Ruby Pallet Jewel (Right)
    ctx.fillStyle = rubyColor;
    ctx.beginPath();
    ctx.rect(armW - 1, armH - 2, 4, 5);
    ctx.fill();

    ctx.restore();
}

/**
 * PendoloClockworkCanvas: Renders dynamic wireframe clockwork gear train background.
 */
const PendoloClockworkCanvas: React.FC<PendoloClockworkCanvasProps> = ({
    centerX,
    centerY,
    baseRadius,
    escapementAngleRad,
    audioBassMotionValue,
    audioBass = 0.18,
    primaryTextColor,
    accentTextColor,
    showGearDecor,
}) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const phaseRef = useRef(0);
    const smoothedBassRef = useRef(0.15);
    const lastTimestampRef = useRef<number | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || showGearDecor === 'none') return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;

        const render = (timestamp: number) => {
            if (lastTimestampRef.current === null) {
                lastTimestampRef.current = timestamp;
            }
            const dt = Math.min((timestamp - lastTimestampRef.current) / 1000, 0.05);
            lastTimestampRef.current = timestamp;

            // Fetch real-time audio bass value directly from MotionValue (handling 0..255 byte scale)
            const val = audioBassMotionValue ? audioBassMotionValue.get() : audioBass;
            const normBass = val > 1.0 ? val / 255 : val;
            const clampedBass = Math.max(0, Math.min(1, normBass));
            smoothedBassRef.current += (clampedBass - smoothedBassRef.current) * 0.12;
            const bass = smoothedBassRef.current;

            // 1. Balance wheel phase accumulation & harmonic swing (Audio Bass regulator)
            phaseRef.current += dt * (2.8 + bass * 3.5);
            const bassOscillation = Math.sin(phaseRef.current) * (0.15 + bass * 0.70);

            // 2. Main gear wheel angle is strictly tied to lyric line ratchet steps
            // Gears remain stationary while a line is being sung, and ratchet ONLY when lyrics switch
            const currentGearAngle = escapementAngleRad;

            // 3. Pallet fork rocks dynamically during lyric line spring ratchet step
            const stepDiff = Math.abs(escapementAngleRad - Math.round(escapementAngleRad));
            const forkTrip = Math.sin((escapementAngleRad) * 16);
            const forkAngleRad = forkTrip * Math.min(0.28, stepDiff * 3.0);

            const width = canvas.offsetWidth;
            const height = canvas.offsetHeight;
            const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

            if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
                canvas.width = Math.floor(width * dpr);
                canvas.height = Math.floor(height * dpr);
            }

            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, width, height);

            const isFull = showGearDecor === 'full';
            const decorOpacityMultiplier = isFull ? 1.0 : 0.6;

            const primaryAlpha15 = colorWithAlpha(primaryTextColor, 0.15 * decorOpacityMultiplier);
            const primaryAlpha25 = colorWithAlpha(primaryTextColor, 0.25 * decorOpacityMultiplier);
            const accentAlpha20 = colorWithAlpha(accentTextColor, 0.20 * decorOpacityMultiplier);
            const accentAlpha35 = colorWithAlpha(accentTextColor, 0.35 * decorOpacityMultiplier);
            const accentAlpha50 = colorWithAlpha(accentTextColor, 0.50 * decorOpacityMultiplier);

            // 1. Technical Radial Ticks & Concentric Guide Rings
            ctx.strokeStyle = primaryAlpha15;
            ctx.lineWidth = 1;

            // Concentric guide rings
            const ringRadii = [baseRadius * 0.3, baseRadius * 0.6, baseRadius * 0.85, baseRadius * 1.15, baseRadius * 1.4];
            ringRadii.forEach((r) => {
                ctx.beginPath();
                ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
                ctx.stroke();
            });

            // Outer Technical Radial Ticks around main wheel (every 6 deg)
            const tickCount = 60;
            const outerTickR = baseRadius * 1.15;
            for (let i = 0; i < tickCount; i++) {
                const angle = (i * Math.PI * 2) / tickCount + currentGearAngle * 0.2;
                const isMajor = i % 5 === 0;
                const tickLen = isMajor ? 12 : 6;
                const x1 = centerX + outerTickR * Math.cos(angle);
                const y1 = centerY + outerTickR * Math.sin(angle);
                const x2 = centerX + (outerTickR + tickLen) * Math.cos(angle);
                const y2 = centerY + (outerTickR + tickLen) * Math.sin(angle);

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
                centerX,
                centerY,
                baseRadius + 8,
                36,
                10,
                currentGearAngle,
                accentAlpha35,
                1.5,
                colorWithAlpha(accentTextColor, 0.03 * decorOpacityMultiplier),
            );

            // Inner Escapement Spoked Ring
            drawSpokedWheel(
                ctx,
                centerX,
                centerY,
                baseRadius * 0.2,
                baseRadius * 0.85,
                6,
                currentGearAngle,
                primaryAlpha25,
                1.2,
            );

            // 3. Center Hub & Sun Gear Pinion
            drawGearTeeth(
                ctx,
                centerX,
                centerY,
                baseRadius * 0.22,
                12,
                6,
                -currentGearAngle * 2.5,
                accentAlpha50,
                1.5,
            );

            // 4. Orbiting Planetary Gear Set (Full mode only or subtle reduced)
            const planetCount = 3;
            const orbitR = baseRadius * 0.52;
            const planetR = baseRadius * 0.16;
            const orbitAngleBase = currentGearAngle * 0.4;

            for (let p = 0; p < planetCount; p++) {
                const planetAngle = orbitAngleBase + (p * Math.PI * 2) / planetCount;
                const px = centerX + orbitR * Math.cos(planetAngle);
                const py = centerY + orbitR * Math.sin(planetAngle);

                // Planet gear body
                drawGearTeeth(
                    ctx,
                    px,
                    py,
                    planetR,
                    14,
                    5,
                    -currentGearAngle * 3 + p * 0.5,
                    primaryAlpha25,
                    1.2,
                );

                // Planet axle pivot point
                ctx.fillStyle = accentAlpha50;
                ctx.beginPath();
                ctx.arc(px, py, 3, 0, Math.PI * 2);
                ctx.fill();
            }

            // 5. Balance Wheel & Oscillating Hairspring (Upper-Left Offset Clockwork)
            const balanceCx = centerX + baseRadius * 0.2;
            const balanceCy = centerY - baseRadius * 0.75;
            // Dynamic wheel radius pulse & high-contrast glow responding to audio bass kicks
            const balanceR = baseRadius * 0.28 * (1.0 + bass * 0.18);
            const balanceAccentColor = colorWithAlpha(accentTextColor, (0.35 + bass * 0.55) * decorOpacityMultiplier);

            // Balance Wheel Rim with adjustment weights
            drawSpokedWheel(
                ctx,
                balanceCx,
                balanceCy,
                balanceR * 0.25,
                balanceR,
                4,
                bassOscillation,
                balanceAccentColor,
                1.5 + bass * 1.0,
            );

            // Oscillating Hairspring (Coils tighten & expand dynamically under bass pressure)
            drawHairspring(
                ctx,
                balanceCx,
                balanceCy,
                4,
                balanceR * 0.7,
                4.5 + bass * 1.5,
                bassOscillation * 1.5,
                balanceAccentColor,
                1.2 + bass * 0.8,
            );

            // Meshing Intermediate Transmission Gear (Lower-Left Offset)
            const transCx = centerX + baseRadius * 0.32;
            const transCy = centerY + baseRadius * 0.78;
            const transR = baseRadius * 0.34;
            drawGearTeeth(
                ctx,
                transCx,
                transCy,
                transR,
                24,
                7,
                -currentGearAngle * 1.4,
                primaryAlpha25,
                1.2,
            );
            drawSpokedWheel(
                ctx,
                transCx,
                transCy,
                transR * 0.25,
                transR * 0.85,
                5,
                -currentGearAngle * 1.4,
                primaryAlpha15,
                1,
            );

            // 6. Swiss Lever Escapement Pallet Fork (擒纵叉与红宝石瓦)
            drawPalletFork(
                ctx,
                centerX,
                centerY,
                baseRadius + 8,
                forkAngleRad,
                accentTextColor,
                decorOpacityMultiplier,
            );

            // 7. Escapement Focal Axis Alignment Line (Horizontal 0 deg)
            ctx.strokeStyle = accentAlpha50;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(centerX + baseRadius * 0.8, centerY);
            ctx.lineTo(centerX + baseRadius * 1.15, centerY);
            ctx.stroke();

            // Focal Arrowhead Indicator
            const arrowX = centerX + baseRadius * 1.15;
            ctx.fillStyle = accentAlpha50;
            ctx.beginPath();
            ctx.moveTo(arrowX, centerY - 4);
            ctx.lineTo(arrowX + 8, centerY);
            ctx.lineTo(arrowX, centerY + 4);
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
    }, [centerX, centerY, baseRadius, escapementAngleRad, audioBass, primaryTextColor, accentTextColor, showGearDecor]);

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
