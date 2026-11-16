import { beforeAll, describe, expect, it, vi } from 'vitest';

// 叠层桥：内容不变的主题沿用旧引用，避免每次位置推送都重建可视化（#320）。

vi.mock('../../../src/services/phoneInsets', () => ({ applyPushedPhoneInsets: () => undefined }));

type Push = (payload: Record<string, unknown>) => void;
let getSnapshot: () => Record<string, unknown>;

beforeAll(async () => {
    (globalThis as { window?: unknown }).window ??= globalThis;
    const bridge = await import('../../../src/entries/wallpaperSurfaceBridge');
    getSnapshot = bridge.getWallpaperSnapshot as unknown as () => Record<string, unknown>;
});

const push = (payload: Record<string, unknown>) => {
    (window as unknown as { __foliaWallpaperPush: Push }).__foliaWallpaperPush(payload);
};

describe('wallpaperSurfaceBridge theme reuse', () => {
    it('同内容的主题沿用上一份引用，位置照常更新', () => {
        push({ title: 'a', positionMs: 1000, playing: true, theme: { name: 'x', wordColors: [{ word: 'w', color: '#fff' }] } });
        const first = getSnapshot().theme;
        push({ title: 'a', positionMs: 4000, playing: true, theme: { name: 'x', wordColors: [{ word: 'w', color: '#fff' }] } });
        expect(getSnapshot().theme).toBe(first);
        expect(getSnapshot().positionMs).toBe(4000);
    });

    it('主题内容变了就换成新的', () => {
        push({ title: 'a', positionMs: 1000, playing: true, theme: { name: 'x' } });
        const first = getSnapshot().theme;
        const next = { name: 'y' };
        push({ title: 'a', positionMs: 1200, playing: true, theme: next });
        expect(getSnapshot().theme).not.toBe(first);
        expect(getSnapshot().theme).toEqual(next);
    });
});
