import { isCapacitorAndroid } from '../../platform/runtime';

// 原生快照认领期间，Web 的恢复 / effect 不得反向覆盖仍在播放的原生状态。
let reconciling = isCapacitorAndroid();
const listeners = new Set<() => void>();
let readGeneration = 0;
export const beginNativePlaybackRead = (): number => ++readGeneration;
export const isLatestNativePlaybackRead = (generation: number): boolean => generation === readGeneration;

export const isNativePlaybackReconciling = (): boolean => reconciling;
export const subscribeNativePlaybackSync = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
export const setNativePlaybackReconciling = (next: boolean): void => {
    if (reconciling === next) return;
    reconciling = next;
    listeners.forEach(listener => listener());
};
