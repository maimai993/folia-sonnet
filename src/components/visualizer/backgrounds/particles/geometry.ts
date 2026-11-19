// src/components/visualizer/backgrounds/particles/geometry.ts
//
// 粒子网格的几何构建与「景深」计算。
//
// 从 ParticlesBackground 里拆出来，纯粹是为了控制那个文件的行数（仓库上限 800 行）。
// 这里没有任何 React 依赖，都是纯函数，读起来也更清楚：
//   buildParticleGrid —— 把屏幕铺成 cols×rows 的粒子网格
//   applyCoverDepth   —— 从封面图算一张低频「景深」写进 aDepth

import * as THREE from 'three';
import { coverUvFromGrid, type CoverFrame } from './coverMapping';

export interface ParticleGrid {
    total: number;
    pos: Float32Array;
    grid: Float32Array;
    rand: Float32Array;
    depth: Float32Array;
}

/**
 * 网格里的一个粒子沿「封面那一格」排布所需的映射。
 *
 * `grid` 是屏幕上的均匀格（决定位置和涟漪），`coverGrid` 是同一颗粒子
 * 在**封面框**里的归一化位置（决定凸起的取样点与盖住封面时的落点）。
 * 两者分开，是因为封面不再铺满屏幕：直接把屏幕网格当封面 UV 用，
 * 就是 #435 里「粒子被拉伸铺满全屏」的那条路。
 */
export interface ParticleGridOptions {
    /** 网格铺满的那块区域（世界空间宽高），就是可视区。 */
    planeWidth: number;
    planeHeight: number;
    /** 封面框（世界空间），由 resolveCoverFrame 算好。 */
    frame: CoverFrame;
    /** 该形态是否让粒子本身按封面框排布（silk），默认 false（保留满屏网格）。 */
    layoutByCover?: boolean;
}

/**
 * 把一块平面铺成 cols×rows 的粒子网格。
 *
 * 三个 buffer 的语义：
 *   pos   —— 粒子的世界坐标（z 恒为 0，深浅由着色器算）
 *   grid  —— 归一化的网格坐标（0..1），片元着色器拿它去封面取样
 *   rand  —— 每粒子的固定随机数，给着色器的抖动用
 *   depth —— 景深占位。真正填值在封面解码之后（applyCoverDepth）；
 *            没有封面时保持 0，画面就该是平的而不是随机起伏。
 *
 * 为什么景深要走 attribute 而不是在顶点着色器里采样封面：
 * 顶点着色器在 WebGL1 里不能 texture2D（只有片元能），所以「这个点离镜头多远」
 * 必须在 JS 侧算好传进来。Mineradio 那边用的是 WebGL2 + R=depth 纹理，我们没有。
 */
export const buildParticleGrid = (
    cols: number,
    rows: number,
    planeWidth: number,
    planeHeight: number,
    options?: Partial<ParticleGridOptions>,
): ParticleGrid => {
    const total = cols * rows;
    const pos = new Float32Array(total * 3);
    const grid = new Float32Array(total * 2);
    const rand = new Float32Array(total);
    const depth = new Float32Array(total);

    const frame = options?.frame;
    const layoutByCover = options?.layoutByCover === true && frame !== undefined;
    /*
     * 按封面框排布时的尺寸：粒子只铺在封面的那一块里（等比、居中），
     * 屏幕其余部分留给真空 —— 这正是 #435 要的「按封面真实比例摆放」。
     * 网格位置仍然写满 0..1 的 uv，只是把世界坐标换算到封面框上。
     */
    const spanWidth = layoutByCover ? frame.width : planeWidth;
    const spanHeight = layoutByCover ? frame.height : planeHeight;

    for (let i = 0; i < total; i += 1) {
        const gx = i % cols;
        const gy = Math.floor(i / cols);
        const u = cols > 1 ? gx / (cols - 1) : 0;
        const v = rows > 1 ? gy / (rows - 1) : 0;
        pos[i * 3] = (u - 0.5) * spanWidth + (layoutByCover ? frame.centerX : 0);
        pos[i * 3 + 1] = (v - 0.5) * spanHeight + (layoutByCover ? frame.centerY : 0);
        pos[i * 3 + 2] = 0;
        /*
         * aGrid 存的是「粒子在封面框里的位置」，不是屏幕位置。
         * 片元按它采样封面；景深也按它取像素 —— 两边用同一份坐标，
         * 凸起才会正好落在它对应那块封面上（#435 的第三条现象）。
         */
        grid[i * 2] = u;
        grid[i * 2 + 1] = v;
        rand[i] = Math.random();
    }

    return { total, pos, grid, rand, depth };
};

/** 景深图的分辨率。低频就够了，关键是快。 */
const DEPTH_SAMPLE = 64;

/**
 * 从封面算一张低频「景深」写进 aDepth（越亮越靠镜头）。
 *
 * Mineradio 那边用的是 AI 深度估计出来的 256×256 R=depth 纹理，缓存在 coverDepthCache。
 * 我们没有那个估计器，就用亮度当深度。为什么这样够用：
 *   · 粒子背景要的是「有层次」，不是「物理正确的深度」。亮度正好提供了有意义的层次 ——
 *     封面里的脸、光、天空本来就比暗部更靠前；
 *   · 它是低频的，所以先缩到 64×64 再读，既快又不会被噪声干扰；
 *   · 不需要联网，也不占额外内存。
 *
 * 失败时静默保留 0（平面）：一个算不出来的景深不该让整个背景不显示。
 * 返回 true 表示成功写入了景深（调用方据此决定要不要打开 uHasDepth）。
 *
 * ★ 怎么把「布局坐标」换算成「封面像素」（#435）：
 *
 * 布局有两种（见 buildParticleGrid），这里按传进来的 planeWidth / planeHeight 与 frame 区分：
 *   · layoutByCover（丝绸）—— aGrid 就是封面框里的 0..1，直接乘到像素；
 *   · 满屏网格（滚筒 / 星球 / 唱片）—— aGrid 是屏幕上的 0..1，要先经
 *     coverUvFromGrid 的同一套「屏幕世界坐标 → 封面框」映射，才知道该读封面哪一个像素。
 *     以前这里直接把屏幕网格当封面像素坐标读，正方形封面被拉伸铺满屏幕，
 *     凸起于是和画面对不上。
 */
export const applyCoverDepthToGeometry = (
    source: CanvasImageSource | undefined,
    geometry: THREE.BufferGeometry,
    layout?: { planeWidth: number; planeHeight: number; frame: CoverFrame; layoutByCover?: boolean },
): boolean => {
    if (!source) return false;
    try {
        const size = DEPTH_SAMPLE;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return false;
        ctx.drawImage(source, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        const depthAttr = geometry.getAttribute('aDepth') as THREE.BufferAttribute | undefined;
        const gridAttr = geometry.getAttribute('aGrid') as THREE.BufferAttribute | undefined;
        if (!depthAttr || !gridAttr) return false;
        const count = depthAttr.count;
        const out = depthAttr.array as Float32Array;
        for (let i = 0; i < count; i += 1) {
            const u = gridAttr.getX(i);
            const v = gridAttr.getY(i);
            let cu = u;
            let cv = v;
            if (layout && !layout.layoutByCover) {
                /*
                 * 满屏网格：先把网格坐标换算到封面坐标，再读像素。
                 *
                 * 用 coverUvFromGrid 而不是自己内联一套，是因为纵向那一次翻转只该有一处 ——
                 * 复制一份就会有一份翻、一份不翻，正好又是「凸起方向反了」。
                 * 这里和片元采样封面用的是同一个 coverUvFromGrid。
                 */
                const uv = coverUvFromGrid(u, v, layout.planeWidth, layout.planeHeight, layout.frame);
                cu = uv.u;
                cv = uv.v;
            }
            /* 换算到「封面自己的 0..1」，再夹到边缘（和采样器取边缘色的行为一致）。 */
            cu = Math.min(1, Math.max(0, cu));
            cv = Math.min(1, Math.max(0, cv));
            /*
             * 0..1 的封面坐标 → 像素。
             *
             * 像素行 py 从图片顶部数，而 cv 是翻转纹理的采样坐标（cv=0 是图片底部），
             * 所以 `1 - cv` 才是那一行。这一步和 gridFromCoverPixel 里的翻转互逆 ——
             * 「把封面第 0 行交给网格 v=1」和「网格 v=1 读第 0 行」对得上，
             * 凸起才会和封面同向。
             */
            const px = Math.min(size - 1, Math.max(0, Math.round(cu * (size - 1))));
            const py = Math.min(size - 1, Math.max(0, Math.round((1 - cv) * (size - 1))));
            const at = (py * size + px) * 4;
            const r = data[at] / 255;
            const g = data[at + 1] / 255;
            const b = data[at + 2] / 255;
            /* Rec.709 亮度 */
            out[i] = Math.min(1, Math.max(0, r * 0.2126 + g * 0.7152 + b * 0.0722));
        }
        depthAttr.needsUpdate = true;
        return true;
    } catch {
        /*
         * 跨域封面没有 CORS 头时 getImageData 会抛 SecurityError。
         * 那种情况下封面本身也贴不上（uCover 采样同样受限），
         * 这里保持平面即可，不额外报错打扰用户。
         */
        return false;
    }
};
