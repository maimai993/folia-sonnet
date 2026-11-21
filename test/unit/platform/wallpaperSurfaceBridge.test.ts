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

/*
 * 非法 payload 以前是直接 return —— 叠层停在上一首，日志里什么都没有（issue C4 的验收标准
 * 「非法 payload 会记录日志而不是静默丢弃」）。这几条把四个通道的丢弃行为钉住。
 */
describe('wallpaperSurfaceBridge malformed payloads', () => {
    const channels = [
        '__foliaWallpaperPush',
        '__foliaWallpaperPushCover',
        '__foliaWallpaperPushCappellaImages',
    ] as const;

    it.each(channels)('%s 收到非对象时记一条 warn 并丢掉', (name) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            for (const bad of [undefined, null, 42, 'text', true]) {
                (window as unknown as Record<string, (payload: unknown) => void>)[name](bad);
            }
            expect(warn).toHaveBeenCalledTimes(5);
            expect(String(warn.mock.calls[0]?.[0])).toContain('[wallpaper]');
        } finally {
            warn.mockRestore();
        }
    });

    it('封面推送里既没有 url 也没有 data 时也记一条', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            (window as unknown as { __foliaWallpaperPushCover: (payload: unknown) => void })
                .__foliaWallpaperPushCover({});
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain('empty cover payload');
        } finally {
            warn.mockRestore();
        }
    });

    it('正常 payload 不记 warn（别把日志刷满）', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            push({ title: 'ok', positionMs: 0, playing: true });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});