import type { VisualizerMode } from '../../types';

// src/services/beatFx/beatFxModePolicy.ts
// 智能动感的分组接线：哪个歌词样式做什么、不做什么，集中在这里声明，是唯一事实来源。
// 渲染信号层（effectTracks）、时钟路由（beatClockTargets）、设置面板都读它，避免三处各写一份
// 名单、改一处漏两处。
//
// 分组定稿：
//
//   ① 完全不做智能动感 —— 提示词 / B站MB / 文字PV / 静止 / 跳一跳 / 黑胶唱片（模组）。
//      纯文字 / 纯文字动画 / 纯静态画面，加任何音轨驱动的效果都是画蛇添足。
//
//   ② 原生推镜震动 —— 商籁 / 花火 / 镜台。
//      这三套本来就读 beatImpact / downbeatImpact 做整页推镜、摆动、裂光，是「最开始
//      没改」的最佳效果，退回上游原始实现即可。它们**不接**新的语义轨脉冲系统，也不该
//      再往里加效果：整页鼓点震动只属于这三套。
//
//   ③ 其余样式 —— 有智能动感，但**一律不接鼓点振动**。
//      每个效果只读自己登记的那条语义轨（人声 / 和声 / 氛围 / 亮度）的乐句起伏，
//      不跟着鼓点一顿一顿。没有整页震动、没有鼓点频闪、没有歌词左右抖。
//
// 「背景效果」（latent.pulse 等）不属于任何歌词样式、本来就有自己的驱动，不能被
// 「不在名单里就关」误伤 —— 所以做不做只用①禁做名单判定，模组样式用 mod: 前缀判定。

/** ① 完全不做智能动感的样式。模组样式（`mod:` 前缀）一律用前缀判定，不逐个列举。 */
export const NO_SMART_BEAT_MODES: ReadonlySet<string> = new Set<VisualizerMode>([
    'prompt',     // 提示词
    'bilibili',   // B站MB
    'kinetic',    // 文字PV
    'still',      // 静止
]);

/** ② 走原生 beatImpact 推镜震动、不接语义轨脉冲系统的三套样式。 */
export const NATIVE_BEAT_MODES: ReadonlySet<string> = new Set<VisualizerMode>([
    'sonnet',     // 商籁：裂光推镜
    'hanabi',     // 花火：整页推镜与轻摆
    'diorama',    // 镜台：拍点涟漪
]);

/** 恒 0 的样式：①纯文字/静态 + ②原生三套（它们走自己的 beatImpact 路径）+ 全部模组样式。 */
export const modeIsForbidden = (mode: string): boolean =>
    NO_SMART_BEAT_MODES.has(mode) || NATIVE_BEAT_MODES.has(mode) || mode.startsWith('mod:');

/** 这个样式接不接语义轨脉冲智能动感（①②为 false，③为 true；背景效果恒 true）。 */
export const modeHasSmartBeat = (mode: string): boolean => !modeIsForbidden(mode);

/** 从 `<mode>.<name>` 的效果 id 取出 mode；没有点号时原样返回（自定义 id 兜底）。 */
export const effectMode = (id: string): string => {
    const dot = id.indexOf('.');
    return dot < 0 ? id : id.slice(0, dot);
};
