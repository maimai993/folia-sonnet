// src/components/visualizer/backgrounds/particles/geometry.ts
//
// 粒子网格的几何构建与「景深」计算。
//
// 从 ParticlesBackground 里拆出来，纯粹是为了控制那个文件的行数（仓库上限 800 行）。
// 这里没有任何 React 依赖，都是纯函数，读起来也更清楚：
//   buildParticleGrid —— 把屏幕铺成 cols×rows 的粒子网格
//   applyCoverDepth   —— 从封面图算一张低频「景深」写进 aDepth

import * as THREE from 'three';

export interface ParticleGrid {
    total: number;
    pos: Float32Array;
    grid: Float32Array;
    rand: Float32Array;
    depth: Float32Array;
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
): ParticleGrid => {
    const total = cols * rows;
    const pos = new Float32Array(total * 3);
    const grid = new Float32Array(total * 2);
    const rand = new Float32Array(total);
    const depth = new Float32Array(total);

    for (let i = 0; i < total; i += 1) {
        const gx = i % cols;
        const gy = Math.floor(i / cols);
        const u = cols > 1 ? gx / (cols - 1) : 0;
        const v = rows > 1 ? gy / (rows - 1) : 0;
        pos[i * 3] = (u - 0.5) * planeWidth;
        pos[i * 3 + 1] = (v - 0.5) * planeHeight;
        pos[i * 3 + 2] = 0;
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
 */
export const applyCoverDepthToGeometry = (
    source: CanvasImageSource | undefined,
    geometry: THREE.BufferGeometry,
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
            /* 同一套 0..1 → 像素的换算法；v 不翻转，和采样封面的约定保持一致。 */
            const px = Math.min(size - 1, Math.max(0, Math.round(u * (size - 1))));
            const py = Math.min(size - 1, Math.max(0, Math.round(v * (size - 1))));
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
