import type { WallpaperPayload } from './wallpaperSurfaceTypes';

// 原生 JSON 每次解码都是新对象；只复用内容完全相同的主题和歌词，不合并播放状态。

/** 比较完整 JSON 内容，忽略对象键顺序，但保留数组顺序及全部嵌套字段的差异。 */
const sameJsonContent = (left: unknown, right: unknown): boolean => {
    if (left === right) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    if (Array.isArray(left)) {
        if (!Array.isArray(right) || left.length !== right.length) return false;
        return left.every((value, index) => sameJsonContent(value, right[index]));
    }
    if (Array.isArray(right)) return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    if (keys.length !== Object.keys(rightRecord).length) return false;
    return keys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key)
        && sameJsonContent(leftRecord[key], rightRecord[key]));
};

export const reuseWallpaperContent = (
    incoming: WallpaperPayload,
    previous: WallpaperPayload,
): WallpaperPayload => {
    const theme = sameJsonContent(incoming.theme, previous.theme) ? previous.theme : incoming.theme;
    const lines = sameJsonContent(incoming.lines, previous.lines) ? previous.lines : incoming.lines;
    if (theme === incoming.theme && lines === incoming.lines) return incoming;
    return { ...incoming, theme, lines };
};
