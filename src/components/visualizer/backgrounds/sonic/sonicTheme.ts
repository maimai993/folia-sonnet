// src/components/visualizer/backgrounds/sonic/sonicTheme.ts
//
// 音域回响的配色与布局推导。
//
// 从 Mineradio 的 sonic-topography-preset.js 搬来的是「怎么从主题色 + 滑条值
// 算出地形颜色和高低」这一套映射 —— 它决定了画面像不像原版，
// 比着色器本身更影响观感，所以单独拆出来写清楚。
//
// 那边的所有旋钮都是 0..100 的整数（sonicGround*），这里保持同样的取值域，
// 这样默认值可以直接照抄，不用换算。

import * as THREE from 'three';

/** 地形默认值。数字来自 Mineradio 的 DEFAULT_GROUND_* 常量。 */
export const SONIC_DEFAULT_RANGE = 82;
export const SONIC_DEFAULT_LOWER = 68;
export const SONIC_DEFAULT_DEPTH = 62;
export const SONIC_DEFAULT_DENSITY = 46;
export const SONIC_DEFAULT_AMPLITUDE = 50;
export const SONIC_DEFAULT_GLOW = 68;
export const SONIC_DEFAULT_SMOOTHNESS = 50;
export const SONIC_DEFAULT_SHARPNESS = 50;

export const SONIC_DEFAULT_BASE_COLOR = '#05070c';
export const SONIC_DEFAULT_COOL_COLOR = '#0066ff';
export const SONIC_DEFAULT_WARM_COLOR = '#ff3c19';
export const SONIC_DEFAULT_ACCENT_COLOR = '#33e6ff';

/** 地形网格：基础边长与格数上下限。 */
const TERRAIN_BASE_SIZE = 168;
const TERRAIN_MIN_GRID_SIZE = 96;
const TERRAIN_MAX_GRID_SIZE = 224;

/**
 * 格数上限按「性能挡位」压。
 *
 * 格数是平方增长：224×224 = 50176 根柱子，每根都是一个实例。
 * 手机上按 balanced 的 160 走（25600 根）已经够密，再往上只是掉帧。
 */
const QUALITY_GRID_CAP: Record<string, number> = {
    eco: 112,
    balanced: 160,
    high: 192,
    ultra: 224,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export interface SonicTerrainSettings {
    gridSize: number;
    spacing: number;
    boxWidth: number;
    instanceCount: number;
}

/** 每边格数 → 实际网格参数。 */
export const deriveTerrainSettings = (
    density: number,
    quality: string | undefined,
): SonicTerrainSettings => {
    const raw = TERRAIN_MIN_GRID_SIZE + ((TERRAIN_MAX_GRID_SIZE - TERRAIN_MIN_GRID_SIZE) * density) / 100;
    const cap = QUALITY_GRID_CAP[quality ?? 'balanced'] ?? QUALITY_GRID_CAP.balanced;
    /* 取 4 的倍数，避免 spacing 出现除不尽的小数让柱子之间出现缝。 */
    const gridSize = clamp(Math.round(raw / 4) * 4, TERRAIN_MIN_GRID_SIZE, cap);
    const spacing = TERRAIN_BASE_SIZE / gridSize;
    return {
        gridSize,
        spacing,
        /* 0.9/1.05 ≈ 0.857：柱子留一点缝，读得出是一根根独立的柱。 */
        boxWidth: spacing * (0.9 / 1.05),
        instanceCount: gridSize * gridSize,
    };
};

export interface SonicLayout {
    scale: number;
    y: number;
    z: number;
}

/** 范围 / 高低 / 远近三个滑条 → 整个地形组的摆放。 */
export const deriveLayout = (range: number, lower: number, depth: number): SonicLayout => ({
    scale: 0.096 + range * 0.00072,
    y: -4.05 - lower * 0.034,
    z: -4.2 - depth * 0.055,
});

export interface SonicTheme {
    base1: THREE.Color;
    base2: THREE.Color;
    fog: THREE.Color;
    coolCore: THREE.Color;
    coolEdge: THREE.Color;
    warmCore: THREE.Color;
    warmEdge: THREE.Color;
    ripple: THREE.Color;
}

/**
 * 主题色 → 地形配色。
 *
 * 冷色取主题的 primary，暖色取 secondary（不够饱和时退回 accent）。
 * 基础色压得很暗 —— 地形的立体感全靠「柱子侧面是近黑的、顶面才发光」，
 * 基础色一亮，整块地形就糊成一片。
 */
export const deriveTheme = (
    primaryColor: string,
    secondaryColor: string,
    accentColor: string,
): SonicTheme => {
    const base1 = new THREE.Color(SONIC_DEFAULT_BASE_COLOR);
    const base2 = new THREE.Color(SONIC_DEFAULT_BASE_COLOR).multiplyScalar(1.9);

    const coolCore = new THREE.Color(primaryColor || SONIC_DEFAULT_COOL_COLOR);
    /* 冷色边缘往基色压一点，纯高饱和会让边缘比顶面还亮。 */
    const coolEdge = coolCore.clone().lerp(base1, 0.34);

    const warmSource = secondaryColor || accentColor || SONIC_DEFAULT_WARM_COLOR;
    const warmCore = new THREE.Color(warmSource);
    const warmEdge = new THREE.Color(warmSource).lerp(new THREE.Color('#ffb300'), 0.45);

    return {
        base1,
        base2,
        fog: base1.clone(),
        coolCore,
        coolEdge,
        warmCore,
        warmEdge,
        /* 涟漪色用 accent：和封面粒子的强调色语言一致。 */
        ripple: new THREE.Color(accentColor || SONIC_DEFAULT_ACCENT_COLOR),
    };
};
