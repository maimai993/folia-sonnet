import type { Theme } from '../../../types';
import type { SonnetSemanticSegment } from './types';
import { hashSonnetSeed, sonnetHash01 } from './sonnetRandom';
import { isSonnetEmphasisRole, type SonnetTypographyPlacement } from './sonnetTypographyLayout';

// src/components/visualizer/sonnet/sonnetGuides.ts
// Creates short-lived semantic lead-in curves and locator marks before text arrival.
type PixiModule = typeof import('pixi.js');

export interface SonnetGuideView {
    container: import('pixi.js').Container;
    startTime: number;
    endTime: number;
    maxAlpha: number;
}

/**
 * How much randomness one guide is built with (issue M9): inside this salt, element index and the
 * kind of draw decide one value, so the same segment lays out the same guide on every rebuild and
 * the same moment of the song looks the same after a seek. These are the draws the build made with
 * `Math.random` before; the ranges are unchanged.
 */
const GUIDE_SEED_SALT = 0x5eed;
const SHAPE_TYPE = 0;
const SHAPE_SIZE = 1;
const SHAPE_ANGLE = 2;
const SHAPE_SPEED = 3;
const SHAPE_SPIN = 4;
/** The chance of each optional thread, then the element that draws it. */
const TRAIL_ONE_SHOWN = 5;
const TRAIL_ONE_DIRECTION = 6;
const TRAIL_ONE_OFFSET = 7;
const TRAIL_ONE_DELAY = 8;
const TRAIL_TWO_SHOWN = 9;
const TRAIL_TWO_DIRECTION = 10;
const TRAIL_TWO_DELAY = 11;
const SPLINE_SHOWN = 12;
const SPLINE_LENGTH = 13;
const SPLINE_THICKNESS = 14;
const SPLINE_ANGLE = 15;
const SPLINE_X = 16;
const SPLINE_Y = 17;
const SPLINE_DELAY = 18;
const SPLINE_DURATION = 19;

const colorNumber = (pixi: PixiModule, color: string) => pixi.Color.shared.setValue(color).toNumber();

export const resolveSonnetGuideCue = (
    segment: SonnetSemanticSegment,
    textStartTime = segment.startTime,
) => {
    const leadDuration = Math.min(
        0.38,
        Math.max(0.2, 0.18 + (segment.endTime - segment.startTime) * 0.1),
    );
    return {
        startTime: textStartTime - leadDuration,
        endTime: textStartTime + 0.65, // Extended duration to let decorations burst and curve fade
    };
};

export const createSonnetGuide = (
    pixi: PixiModule,
    segment: SonnetSemanticSegment,
    placement: SonnetTypographyPlacement,
    theme: Theme,
    fontSize: number,
    textStartTime = segment.startTime,
): SonnetGuideView & { update?: (progress: number) => void; } => {
    const container = new pixi.Container();
    const graphics = new pixi.Graphics();
    // A guide follows one semantic segment, so its text is what has to stay stable across a
    // rebuild of the same paragraph; the placement's x/y is jittered per scene and is not.
    const guideSeed = hashSonnetSeed(`${segment.text}:${segment.startOffset}:${segment.endOffset}`);
    const guideRandom = (element: number) => sonnetHash01(guideSeed, element, GUIDE_SEED_SALT);

    // Container for geometric decorations
    const shapesContainer = new pixi.Container();

    const isHero = isSonnetEmphasisRole(placement.role);
    const fallbackDirection = placement.timingPhase < 0.5 ? -1 : 1;
    const startX = placement.enterX || fallbackDirection * fontSize * 1.8;
    const startY = placement.enterY || -fontSize * 0.9;

    const color = colorNumber(
        pixi,
        isHero ? theme.accentColor : theme.secondaryColor,
    );

    const strokeProps = {
        color,
        width: isHero ? 1.8 : 1,
        alpha: isHero ? 0.82 : 0.55,
    };

    // Cubic bezier control points
    const p0 = { x: startX, y: startY };
    const p1 = { x: startX * 0.6, y: startY * 0.4 };
    const p2 = { x: startX * 0.2, y: startY * 0.1 };
    const p3 = { x: 0, y: 0 };

    const getBezier = (p_0: { x: number, y: number; }, p_1: { x: number, y: number; }, p_2: { x: number, y: number; }, p_3: { x: number, y: number; }, t: number) => {
        const mt = 1 - t;
        return {
            x: mt * mt * mt * p_0.x + 3 * mt * mt * t * p_1.x + 3 * mt * t * t * p_2.x + t * t * t * p_3.x,
            y: mt * mt * mt * p_0.y + 3 * mt * mt * t * p_1.y + 3 * mt * t * t * p_2.y + t * t * t * p_3.y
        };
    };

    // Create random small geometric shapes
    const numShapes = isHero ? 6 : 3;
    const shapeData: any[] = [];

    for (let i = 0; i < numShapes; i++) {
        const shape = new pixi.Graphics();
        const type = Math.floor(guideRandom(SHAPE_TYPE + i) * 4);
        const size = (isHero ? 3 : 1.5) + guideRandom(SHAPE_SIZE + i) * 3.5;
        const sAlpha = isHero ? 0.8 : 0.6;

        if (type === 0) {
            shape.circle(0, 0, size).fill({ color, alpha: sAlpha });
        } else if (type === 1) {
            shape.rect(-size, -size, size * 2, size * 2).fill({ color, alpha: sAlpha });
        } else if (type === 2) {
            shape.moveTo(-size, 0).lineTo(size, 0).moveTo(0, -size).lineTo(0, size).stroke({ color, width: 2, alpha: sAlpha });
        } else {
            shape.moveTo(0, -size).lineTo(size, 0).lineTo(0, size).lineTo(-size, 0).fill({ color, alpha: sAlpha });
        }

        shapesContainer.addChild(shape);
        shapeData.push({
            obj: shape,
            angle: guideRandom(SHAPE_ANGLE + i) * Math.PI * 2,
            speed: (15 + guideRandom(SHAPE_SPEED + i) * 45) * (isHero ? 1 : 0.7),
            rotSpeed: (guideRandom(SHAPE_SPIN + i) - 0.5) * 8,
        });
    }

    // Create elegant close-range silk threads weaving around the text
    const trackingTrails: any[] = [];
    if (isHero || guideRandom(TRAIL_ONE_SHOWN) > 0.4) {
        // Thread 1: Tight S-Curve weaving through the text
        const d = guideRandom(TRAIL_ONE_DIRECTION) > 0.5 ? 1 : -1;
        const yOffset = (guideRandom(TRAIL_ONE_OFFSET) - 0.5) * fontSize * 0.8;
        trackingTrails.push({
            p0: { x: -d * fontSize * 2.5, y: yOffset + fontSize * 1.5 },
            p1: { x: -d * fontSize * 0.8, y: yOffset - fontSize * 2.0 },
            p2: { x: d * fontSize * 0.8, y: yOffset + fontSize * 2.0 },
            p3: { x: d * fontSize * 2.5, y: yOffset - fontSize * 1.5 },
            delay: guideRandom(TRAIL_ONE_DELAY) * 0.15
        });
    }
    if (isHero || guideRandom(TRAIL_TWO_SHOWN) > 0.6) {
        // Thread 2: Tight Intersecting Loop (Ribbon) wrapping the text
        const d = guideRandom(TRAIL_TWO_DIRECTION) > 0.5 ? 1 : -1;
        trackingTrails.push({
            p0: { x: -fontSize * 2.0, y: -d * fontSize * 1.8 },
            p1: { x: fontSize * 2.0, y: d * fontSize * 1.8 },
            p2: { x: -fontSize * 2.0, y: d * fontSize * 1.8 },
            p3: { x: fontSize * 2.0, y: -d * fontSize * 1.8 },
            delay: guideRandom(TRAIL_TWO_DELAY) * 0.1
        });
    }
    // Create growing rectangular spline (modern HUD style)
    let rectSpline: any = null;
    if (guideRandom(SPLINE_SHOWN) > 0.4) {
        const length = fontSize * (1.2 + guideRandom(SPLINE_LENGTH) * 1.5);
        const thickness = (isHero ? 6 : 3) + guideRandom(SPLINE_THICKNESS) * 8;
        const angle = (guideRandom(SPLINE_ANGLE) - 0.5) * Math.PI; // Random angle
        // Start somewhere near the text
        const rx = (guideRandom(SPLINE_X) - 0.5) * fontSize * 1.2;
        const ry = (guideRandom(SPLINE_Y) - 0.5) * fontSize * 1.2;
        rectSpline = {
            p0: { x: rx, y: ry },
            p1: { x: rx + Math.cos(angle) * length, y: ry + Math.sin(angle) * length },
            thickness,
            delay: guideRandom(SPLINE_DELAY) * 0.15,
            duration: 0.25 + guideRandom(SPLINE_DURATION) * 0.2
        };
    }

    container.addChild(graphics, shapesContainer);
    container.position.set(placement.x, placement.y);
    container.alpha = 0;

    const cue = resolveSonnetGuideCue(segment, textStartTime);

    const update = (progress: number) => {
        // Curve draws in quickly from 0 to 0.35, then fades out from 0.4 to 0.7
        const drawProgress = Math.min(1, Math.max(0, progress / 0.35));
        const fadeOut = 1 - Math.min(1, Math.max(0, (progress - 0.4) / 0.3));

        // Empty already (the guide has faded out, or has not begun): clearing an empty Graphics
        // still dirties its context and re-batches.
        if (graphics.context.instructions.length > 0) graphics.clear();
        if (drawProgress > 0 && fadeOut > 0) {
            const steps = 20;
            let prevP = p0;
            for (let i = 1; i <= steps; i++) {
                // To make it look like a star trail, we draw a fading, tapered tail
                const t = (i / steps) * drawProgress;
                const p = getBezier(p0, p1, p2, p3, t);
                const intensity = Math.pow(i / steps, 2); // Quadratic curve: 0 at tail, 1 at head

                // Enhanced thickness and brightness
                const segmentAlpha = Math.min(1, intensity * strokeProps.alpha * fadeOut * 1.6);
                const segmentWidth = (isHero ? 2.5 : 1.5) + intensity * (isHero ? 5.0 : 3.0);

                graphics.moveTo(prevP.x, prevP.y);
                graphics.lineTo(p.x, p.y);
                graphics.stroke({ color, width: segmentWidth, alpha: segmentAlpha });
                prevP = p;
            }

            // Star Head (Core + Glow) - Made more prominent
            const head = getBezier(p0, p1, p2, p3, drawProgress);
            graphics.circle(head.x, head.y, isHero ? 14 : 9).fill({ color, alpha: 0.5 * fadeOut });
            graphics.circle(head.x, head.y, isHero ? 4.5 : 3).fill({ color: 0xffffff, alpha: 1 * fadeOut });
        }

        // Rhythm Game Style Silk Thread Tracks
        trackingTrails.forEach(trail => {
            const localProg = (progress - trail.delay) / 0.55;
            if (localProg > -0.15 && fadeOut > 0) {
                // Head and tail sweep without drawing the full trajectory in advance.
                if (localProg > 0 && localProg < 1.3) {
                    const headT = Math.min(1, localProg);
                    const tailT = Math.max(0, localProg - 0.35); // The comet tail length

                    if (headT > tailT) {
                        const steps = 25;
                        let prevP = getBezier(trail.p0, trail.p1, trail.p2, trail.p3, tailT);

                        for (let i = 1; i <= steps; i++) {
                            const stepT = tailT + (i / steps) * (headT - tailT);
                            const pos = getBezier(trail.p0, trail.p1, trail.p2, trail.p3, stepT);
                            const intensity = Math.pow(i / steps, 2);
                            const alpha = intensity * strokeProps.alpha * fadeOut * 0.9;
                            const width = (isHero ? 2 : 1) + intensity * (isHero ? 5 : 2.5);

                            graphics.moveTo(prevP.x, prevP.y);
                            graphics.lineTo(pos.x, pos.y);
                            graphics.stroke({ color, width, alpha });
                            prevP = pos;
                        }
                    }

                    // Glowing head and follow circle
                    if (headT > 0 && headT < 1) {
                        const headPos = getBezier(trail.p0, trail.p1, trail.p2, trail.p3, headT);
                        graphics.circle(headPos.x, headPos.y, isHero ? 7 : 4).fill({ color, alpha: 0.9 * fadeOut });
                        graphics.circle(headPos.x, headPos.y, isHero ? 2.5 : 1.5).fill({ color: 0xffffff, alpha: 1 * fadeOut });

                        // Outer "follow circle" glow for rhythm game vibe
                        graphics.circle(headPos.x, headPos.y, isHero ? 20 : 12).stroke({ color, width: isHero ? 2 : 1, alpha: 0.4 * fadeOut });
                    }
                }
            }
        });

        // Rectangular Spline (Modern HUD style)
        if (rectSpline) {
            const localProg = (progress - rectSpline.delay) / rectSpline.duration;
            if (localProg > 0 && localProg < 1.3 && fadeOut > 0) {
                // Growth phase: head moves from p0 to p1
                const headT = Math.min(1, Math.max(0, localProg * 1.5));
                // Shrink phase: tail moves from p0 to p1, trailing behind head
                const tailT = Math.min(1, Math.max(0, (localProg - 0.3) * 1.5));

                if (headT > tailT) {
                    const hx = rectSpline.p0.x + (rectSpline.p1.x - rectSpline.p0.x) * headT;
                    const hy = rectSpline.p0.y + (rectSpline.p1.y - rectSpline.p0.y) * headT;
                    const tx = rectSpline.p0.x + (rectSpline.p1.x - rectSpline.p0.x) * tailT;
                    const ty = rectSpline.p0.y + (rectSpline.p1.y - rectSpline.p0.y) * tailT;

                    graphics.moveTo(tx, ty);
                    graphics.lineTo(hx, hy);
                    graphics.stroke({ color, width: rectSpline.thickness, alpha: strokeProps.alpha * fadeOut * 0.7 });

                    // Also draw a bright core
                    graphics.moveTo(tx, ty);
                    graphics.lineTo(hx, hy);
                    graphics.stroke({ color: 0xffffff, width: rectSpline.thickness * 0.3, alpha: strokeProps.alpha * fadeOut * 0.9 });
                }
            }
        }

        // Shapes burst outwards when text starts to settle (progress ~ 0.3)
        const burstProgress = Math.min(1, Math.max(0, (progress - 0.3) / 0.7));
        shapeData.forEach(s => {
            const ease = 1 - Math.pow(1 - burstProgress, 3); // Expo out
            s.obj.x = p3.x + Math.cos(s.angle) * s.speed * ease;
            s.obj.y = p3.y + Math.sin(s.angle) * s.speed * ease;
            s.obj.rotation = s.rotSpeed * burstProgress;
            s.obj.alpha = (1 - burstProgress) * (isHero ? 1 : 0.8);
            s.obj.scale.set(1 - burstProgress * 0.4);
        });
    };

    return {
        container,
        ...cue,
        maxAlpha: isHero ? 0.95 : 0.7,
        update,
    };
};
