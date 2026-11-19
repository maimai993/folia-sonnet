// src/components/visualizer/backgrounds/particles/coverLayout.ts
// 封面粒子背景里「封面怎么摆」的那一小块状态：#435。
//
// 封面框、采样系数、网格铺多大、转到哪个世界坐标，这四件事总是同时变
// （封面解码出真实比例、转屏、分屏），所以收在一处，谁也不会漏改一个。
// 这里不碰 React，只拿一个 uniform 表往里写；纯计算仍在 coverMapping.ts。

import {
    coverUvCoefficients,
    resolveCoverFrame,
    resolveGridColumns,
    resolveGridSpan,
    type CoverFrame,
} from './coverMapping';
import { buildParticleGrid, type ParticleGrid } from './geometry';

/** 要写进去的 uniform。只声明用得到的两个，避免把 three 的类型拖进来。 */
export interface CoverUvUniforms {
    uCoverUvScale: { value: { set: (x: number, y: number) => void } };
    uCoverUvOffset: { value: { set: (x: number, y: number) => void } };
}

/**
 * 一块「封面布局」：封面框 + 网格铺在哪 + 采样系数。
 *
 * `layoutByCover`（丝绸）时网格本身只铺封面框，所以粒子就是封面那么大、那么扁；
 * 其余形态网格铺满可视区，封面框只用来算采样坐标。
 */
export interface CoverLayout {
    frame: CoverFrame;
    /** 网格实际铺的区域（世界空间）。 */
    span: { width: number; height: number };
    /** 该形态的粒子是否按封面框排布。 */
    layoutByCover: boolean;
    /** 用当前可视区与封面比例重算，并把采样系数写进 uniform。 */
    refresh: (viewWidth: number, viewHeight: number, coverAspect: number) => void;
    /** 横向格数：按网格实际铺的那块区域取，每格才是正方形。 */
    columns: (grid: number, screenAspect: number) => number;
    /** 按当前布局生成粒子网格。 */
    build: (cols: number, rows: number) => ParticleGrid;
    /** 顶点数不变时按当前布局重写位置。 */
    relayout: (positions: Float32Array, cols: number, rows: number) => number;
}

/**
 * 建一块封面布局。
 *
 * @param planeWidth 可视区宽（世界空间）
 * @param planeHeight 可视区高（世界空间）
 * @param layoutByCover 该形态是否让粒子按封面框排布（丝绸是）
 * @param uniforms 采样系数要写的两个 uniform
 */
export const createCoverLayout = (
    planeWidth: number,
    planeHeight: number,
    layoutByCover: boolean,
    uniforms: CoverUvUniforms,
): CoverLayout => {
    const layout: CoverLayout = {
        // 封面比例还不知道时按正方形估；封面解码后 refresh 会换成真实比例。
        frame: { width: planeWidth, height: planeHeight, centerX: 0, centerY: 0 },
        span: { width: planeWidth, height: planeHeight },
        layoutByCover,
        refresh: (viewWidth, viewHeight, coverAspect) => {
            layout.frame = resolveCoverFrame({ viewWidth, viewHeight, coverAspect });
            layout.span = resolveGridSpan(layoutByCover, viewWidth, viewHeight, layout.frame);
            const coefficients = coverUvCoefficients(viewWidth, viewHeight, layout.frame);
            uniforms.uCoverUvScale.value.set(coefficients.scaleU, coefficients.scaleV);
            uniforms.uCoverUvOffset.value.set(coefficients.offsetU, coefficients.offsetV);
        },
        columns: (grid, screenAspect) => resolveGridColumns(grid, layoutByCover, screenAspect, layout.frame),
        build: (cols, rows) => buildParticleGrid(cols, rows, layout.span.width, layout.span.height, {
            frame: layout.frame,
            layoutByCover,
        }),
        relayout: (positions, cols, rows) => {
            /*
             * 只动位置、不动 aGrid：aGrid 是「粒子在封面框里的位置」，
             * 世界坐标挪了它不该跟着变 —— 凸起（aDepth 按 aGrid 取封面像素）
             * 才会始终和粒子自己的采样坐标对齐。
             */
            const count = Math.min(Math.floor(positions.length / 3), cols * rows);
            for (let i = 0; i < count; i += 1) {
                const gx = i % cols;
                const gy = Math.floor(i / cols);
                positions[i * 3] = ((cols > 1 ? gx / (cols - 1) : 0) - 0.5) * layout.span.width
                    + (layoutByCover ? layout.frame.centerX : 0);
                positions[i * 3 + 1] = ((rows > 1 ? gy / (rows - 1) : 0) - 0.5) * layout.span.height
                    + (layoutByCover ? layout.frame.centerY : 0);
                positions[i * 3 + 2] = 0;
            }
            return count;
        },
    };
    return layout;
};
