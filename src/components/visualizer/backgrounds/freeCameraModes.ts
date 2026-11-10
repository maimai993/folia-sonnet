import type { VisualizerBackgroundMode } from '../../../types';

// src/components/visualizer/backgrounds/freeCameraModes.ts
//
// 哪些背景是「3D 舞台」。
//
// 这几个背景是从 Mineradio 搬来的，那边整个场景有自由相机（freeCamera）：
// 拖动旋转视角、滚轮改 FOV、双击回正。我们把相机一起搬过来了，
// 于是播放页的横滑切歌和双击暂停必须让位 —— 同一个拖动/双击动作不能有两个意思。
//
// 这份清单是**唯一**的判定来源：渲染层用它决定要不要挂拖动监听，
// 手势层用它决定要不要关掉横滑切歌和双击暂停。两边各写一份迟早对不上，
// 对不上的表现就是「背景能转但同时在切歌」，非常难查。

const FREE_CAMERA_MODES: ReadonlySet<string> = new Set<VisualizerBackgroundMode>([
    // 封面粒子（3D 网格 + 涟漪 + 景深）
    'particles',
    // 音域回响（柱状地形，从上方俯视，能转视角看侧面）
    'sonic',
]);

/** 这个背景自己处理拖动旋转视角吗。 */
export const hasFreeCamera = (mode: string | null | undefined): boolean => (
    typeof mode === 'string' && FREE_CAMERA_MODES.has(mode)
);
