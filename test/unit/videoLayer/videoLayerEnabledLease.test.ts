import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/videoLayer/videoLayerEnabledLease.test.ts
// issue #432 的回归点：视频层开关只能由借用它的那一段回滚，而且只回滚自己开的那一次。
// 以前注入一处直接把开关硬开并落盘，播放页背景预览里看一眼「MV」，这一层就永久打开了。

const storage = new Map<string, string>();

const loadModules = async () => {
    vi.resetModules();
    // store 在模块加载时从 localStorage 读初值，所以先把存储装好再 import。
    const storageApi = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
    };
    vi.stubGlobal('localStorage', storageApi);
    vi.stubGlobal('window', { localStorage: storageApi });
    const store = await import('@/stores/useVideoLayerSettingsStore');
    const lease = await import('@/services/videoLayerEnabledLease');
    return { store, lease };
};

describe('video layer enabled lease', () => {
    beforeEach(() => {
        storage.clear();
    });

    afterEach(() => {
        storage.clear();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('turns the layer off again after a preview that opened it', async () => {
        const { store, lease } = await loadModules();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);

        const release = lease.acquireVideoLayerEnabled();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
        expect(lease.isVideoLayerEnabledByLease()).toBe(true);

        release();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
        expect(lease.isVideoLayerEnabledByLease()).toBe(false);
    });

    it('leaves a layer the user switched on themselves alone', async () => {
        const { store, lease } = await loadModules();
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);

        const release = lease.acquireVideoLayerEnabled();
        release();

        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
        expect(storage.get('video_layer_enabled')).toBe('true');
    });

    it('does not write storage when the layer is already on', async () => {
        const { store, lease } = await loadModules();
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);
        storage.set('video_layer_enabled', 'sentinel');

        const release = lease.acquireVideoLayerEnabled();
        expect(storage.get('video_layer_enabled')).toBe('sentinel');

        release();
        expect(storage.get('video_layer_enabled')).toBe('sentinel');
    });

    it('keeps the layer on while any holder still needs it, and off once all are gone', async () => {
        const { store, lease } = await loadModules();

        const first = lease.acquireVideoLayerEnabled();
        const second = lease.acquireVideoLayerEnabled();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);

        // 两个注入方（歌本身就是投稿 / 匹配来的 MV）轮流收手，开关不能跟着抖。
        first();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);

        second();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
    });

    it('ignores a second release of the same lease', async () => {
        const { store, lease } = await loadModules();
        const other = lease.acquireVideoLayerEnabled();
        const release = lease.acquireVideoLayerEnabled();

        release();
        release();
        // 多还一次不能把别人的那份也还掉。
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
        other();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
    });

    it('does not turn the layer back on when the user switched it off mid-preview', async () => {
        const { store, lease } = await loadModules();
        const release = lease.acquireVideoLayerEnabled();

        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(false);
        release();

        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
        expect(storage.get('video_layer_enabled')).toBe('false');
    });

    it('starts a fresh rollback window after the previous one has settled', async () => {
        const { store, lease } = await loadModules();

        // 第一次借用把开关打开又关回去。
        lease.acquireVideoLayerEnabled()();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);

        // 用户这时自己打开了视频层，第二次借用就不该再关掉它。
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);
        lease.acquireVideoLayerEnabled()();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
    });
});

describe('setInjectedUrl no longer touches the persistent switch', () => {
    beforeEach(() => {
        storage.clear();
    });

    afterEach(() => {
        storage.clear();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('stores the injected URL without enabling the layer', async () => {
        const { store } = await loadModules();
        const injected = store.withInjectPrefix('https://example.invalid/mv.mp4');

        store.useVideoLayerSettingsStore.getState().setInjectedUrl(injected);

        const state = store.useVideoLayerSettingsStore.getState();
        expect(state.injectedUrl).toBe(injected);
        expect(state.videoLayerEnabled).toBe(false);
        // 也不该替用户往盘上写一次「开」。
        expect(storage.get('video_layer_enabled')).toBeUndefined();
    });
});
