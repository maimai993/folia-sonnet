import { fillPolygon, strokePolygon, type SonnetPoint, type SonnetThemedShotMgOptions } from './sonnetThemedShotMgPrimitives';

// src/components/visualizer/sonnet/sonnetShotMgLandscape.ts
// Draws layered landscapes with contour-like outlines and atmospheric fill depths.
export const drawSonnetTerracesMg = ({ target, radius, seed, primary, secondary }: SonnetThemedShotMgOptions) => {
    const direction = seed % 2 === 0 ? 1 : -1;
    for (let band = 0; band < 7; band += 1) {
        const y = radius * (-0.5 + band * 0.16);
        const amplitude = radius * (0.09 + band * 0.012);
        target.moveTo(-radius * 0.82, y)
            .bezierCurveTo(-radius * 0.35, y + amplitude * direction, radius * 0.08, y - amplitude * direction, radius * 0.82, y + amplitude * 0.35)
            .lineTo(radius * 0.82, y + radius * 0.12)
            .bezierCurveTo(radius * 0.12, y + radius * 0.04, -radius * 0.3, y + radius * 0.2, -radius * 0.82, y + radius * 0.12)
            .fill({ color: band % 2 ? secondary : primary, alpha: 0.025 + band * 0.018 });
        target.moveTo(-radius * 0.82, y)
            .bezierCurveTo(-radius * 0.35, y + amplitude * direction, radius * 0.08, y - amplitude * direction, radius * 0.82, y + amplitude * 0.35)
            .stroke({ color: band % 2 ? secondary : primary, width: band % 3 === 0 ? 2.5 : 1, alpha: 0.34 + band * 0.04 });
    }
};

export const drawSonnetMountainLakeMg = ({ target, radius, seed, primary, secondary }: SonnetThemedShotMgOptions) => {
    const shift = (((seed % 7) - 3) / 3) * radius * 0.04;
    const back: SonnetPoint[] = [
        [-radius * 0.82, radius * 0.1], [-radius * 0.42, -radius * 0.46],
        [-radius * 0.14, -radius * 0.16], [radius * 0.22, -radius * 0.62],
        [radius * 0.82, radius * 0.1],
    ];
    const front: SonnetPoint[] = [
        [-radius * 0.82, radius * 0.22], [-radius * 0.28 + shift, -radius * 0.2],
        [radius * 0.06, radius * 0.05], [radius * 0.48 + shift, -radius * 0.28], [radius * 0.82, radius * 0.22],
    ];
    fillPolygon(target, back, secondary, 0.07);
    strokePolygon(target, back, secondary, 0.46, 1.5);
    fillPolygon(target, front, primary, 0.12);
    strokePolygon(target, front, primary, 0.66, 2.5);
    for (let line = 0; line < 7; line += 1) {
        const y = radius * (0.28 + line * 0.07);
        const inset = radius * (0.08 + (line % 3) * 0.08);
        target.moveTo(-radius * 0.7 + inset, y).lineTo(radius * 0.7 - inset, y)
            .stroke({ color: line % 2 ? secondary : primary, width: 1, alpha: 0.2 + line * 0.035 });
    }
    target.circle(-radius * 0.48, -radius * 0.48, radius * 0.1).fill({ color: secondary, alpha: 0.14 });
    target.circle(-radius * 0.48, -radius * 0.48, radius * 0.13).stroke({ color: secondary, width: 2, alpha: 0.5 });
};

export const drawSonnetCoastalCliffMg = ({ target, radius, seed, primary, secondary }: SonnetThemedShotMgOptions) => {
    const direction = seed % 2 === 0 ? 1 : -1;
    const cliff: SonnetPoint[] = [
        [-radius * 0.82 * direction, radius * 0.58], [-radius * 0.78 * direction, -radius * 0.1],
        [-radius * 0.5 * direction, -radius * 0.34], [-radius * 0.18 * direction, radius * 0.08],
        [radius * 0.08 * direction, radius * 0.58],
    ];
    fillPolygon(target, cliff, primary, 0.11);
    strokePolygon(target, cliff, primary, 0.62, 2.5);
    const towerX = -radius * 0.5 * direction;
    target.rect(towerX - radius * 0.09, -radius * 0.42, radius * 0.18, radius * 0.45)
        .fill({ color: secondary, alpha: 0.12 });
    target.rect(towerX - radius * 0.09, -radius * 0.42, radius * 0.18, radius * 0.45)
        .stroke({ color: secondary, width: 2, alpha: 0.7 });
    target.moveTo(towerX - radius * 0.14, -radius * 0.42).lineTo(towerX, -radius * 0.56).lineTo(towerX + radius * 0.14, -radius * 0.42)
        .fill({ color: secondary, alpha: 0.2 });
    target.moveTo(towerX - radius * 0.14, -radius * 0.42).lineTo(towerX, -radius * 0.56).lineTo(towerX + radius * 0.14, -radius * 0.42)
        .lineTo(towerX - radius * 0.14, -radius * 0.42)
        .stroke({ color: secondary, width: 2, alpha: 0.72 });
    for (let wave = 0; wave < 6; wave += 1) {
        const y = radius * (0.14 + wave * 0.1);
        target.moveTo(-radius * 0.05 * direction, y)
            .quadraticCurveTo(radius * 0.35 * direction, y - radius * 0.08, radius * 0.8 * direction, y)
            .stroke({ color: wave % 2 ? secondary : primary, width: wave % 3 === 0 ? 2 : 1, alpha: 0.26 + wave * 0.045 });
    }
};
