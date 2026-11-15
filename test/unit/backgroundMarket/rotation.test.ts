// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 当前文件：背景随机轮换的设置与「应用后真的能显示」这条约束。
//
// 这个功能最容易出的错不是「没下载」，而是**下载了但没切换模式** ——
// 文件在磁盘上，画面上还是上一张，用户只会觉得功能坏了。
// 所以这里的重点是：应用之后，那个决定画什么的开关必须跟着动。

describe('useMarketRotationStore', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.resetModules();
    });

    const loadStore = async () => {
        const module = await import('@/stores/useMarketRotationStore');
        return module;
    };

    it('默认关闭，且默认两者都要', async () => {
        const { useMarketRotationStore } = await loadStore();
        const state = useMarketRotationStore.getState();
        expect(state.enabled).toBe(false);
        expect(state.mediaKind).toBe('both');
        expect(state.targets).toEqual(['visualizer']);
    });

    it('「用到哪」至少留一个，不允许清空', async () => {
        const { useMarketRotationStore } = await loadStore();
        const store = useMarketRotationStore.getState();
        // 默认只有 visualizer，再点一次等于想关掉它 —— 必须被拦住。
        store.toggleTarget('visualizer');
        expect(useMarketRotationStore.getState().targets).toEqual(['visualizer']);
    });

    it('「用到哪」可以多选', async () => {
        const { useMarketRotationStore } = await loadStore();
        useMarketRotationStore.getState().toggleTarget('wallpaper');
        expect(useMarketRotationStore.getState().targets).toEqual(['visualizer', 'wallpaper']);
    });

    it('设置会落盘，冷启动能读回来', async () => {
        const { useMarketRotationStore } = await loadStore();
        const store = useMarketRotationStore.getState();
        store.setEnabled(true);
        store.setMediaKind('image');
        store.setIntervalSeconds(1800);

        vi.resetModules();
        const reloaded = (await loadStore()).useMarketRotationStore.getState();
        expect(reloaded.enabled).toBe(true);
        expect(reloaded.mediaKind).toBe('image');
        expect(reloaded.intervalSeconds).toBe(1800);
    });

    it('间隔小于 60 秒的脏值会被丢掉', async () => {
        localStorage.setItem('foliaMarketRotation', JSON.stringify({ intervalSeconds: 5 }));
        const { useMarketRotationStore } = await loadStore();
        expect(useMarketRotationStore.getState().intervalSeconds).toBe(600);
    });

    it('未知的 mediaKind 回落到 both', async () => {
        localStorage.setItem('foliaMarketRotation', JSON.stringify({ mediaKind: 'gif' }));
        const { useMarketRotationStore } = await loadStore();
        expect(useMarketRotationStore.getState().mediaKind).toBe('both');
    });
});

describe('rotationAllows', () => {
    it('只看视频时不放行图片', async () => {
        const { rotationAllows } = await import('@/stores/useMarketRotationStore');
        expect(rotationAllows('video', 'video')).toBe(true);
        expect(rotationAllows('video', 'image')).toBe(false);
    });

    it('只看图片时不放行视频', async () => {
        const { rotationAllows } = await import('@/stores/useMarketRotationStore');
        expect(rotationAllows('image', 'image')).toBe(true);
        expect(rotationAllows('image', 'video')).toBe(false);
    });

    it('两者都要时都放行', async () => {
        const { rotationAllows } = await import('@/stores/useMarketRotationStore');
        expect(rotationAllows('both', 'video')).toBe(true);
        expect(rotationAllows('both', 'image')).toBe(true);
    });
});
