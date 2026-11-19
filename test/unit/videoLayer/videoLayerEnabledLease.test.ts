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

        release();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
        expect(storage.get('video_layer_enabled')).toBe('false');
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

    it('gives up the rollback once the user switches it off and on again mid-preview', async () => {
        const { store, lease } = await loadModules();
        const release = lease.acquireVideoLayerEnabled();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);

        // 用户先关掉，再自己打开 —— 他认为是自己开的。
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(false);
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);

        release();
        // 租约已经没有回滚资格：不能替他关，也不能把「关」写进盘里。
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
        expect(storage.get('video_layer_enabled')).toBe('true');
    });

    it('gives up the rollback when the user merely toggles it inside a long preview', async () => {
        const { store, lease } = await loadModules();
        const first = lease.acquireVideoLayerEnabled();
        const second = lease.acquireVideoLayerEnabled();

        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(false);
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);

        // 用户动过一次以后，后面谁还都关不掉它，直到下一次重新借。
        first();
        second();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
        expect(storage.get('video_layer_enabled')).toBe('true');
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

    it('settles back to zero and leaves the layer on across a StrictMode replay', async () => {
        const { store, lease } = await loadModules();

        // StrictMode 对同一个 effect 跑的是「装 → 卸 → 装」（见 src/bootstrap.tsx 外面那层包法）。
        const first = lease.acquireVideoLayerEnabled();
        first();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);

        // 重放的第二段：装上了就不该再关，计数要能回到 0 才说明没有漏还的份数。
        const second = lease.acquireVideoLayerEnabled();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
        second();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);

        // 真回到 0 了：再借一次还是从「原本关着」开始，行为没有被上一次搞坏。
        lease.acquireVideoLayerEnabled()();
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
        expect(storage.get('video_layer_enabled')).toBe('false');
    });

    it('leaves the layer on when a StrictMode replay happens while it is already on', async () => {
        const { store, lease } = await loadModules();
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);

        const first = lease.acquireVideoLayerEnabled();
        first();
        const second = lease.acquireVideoLayerEnabled();
        second();

        // 用户开着的层，重放几次都不该被顺手关掉，也不该多写一次盘。
        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
        expect(storage.get('video_layer_enabled')).toBe('true');
    });

    it('keeps a layer the user switched on from rolled back by a stale file pick', async () => {
        const { store, lease } = await loadModules();

        // 选文件那条路调的是不带来源的 setVideoLayerEnabled，算用户写的。
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);
        const release = lease.acquireVideoLayerEnabled();
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(false);
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true);
        release();

        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(true);
        expect(storage.get('video_layer_enabled')).toBe('true');
    });

    it('lets a service-side write take the rollback away as well', async () => {
        const { store, lease } = await loadModules();
        const release = lease.acquireVideoLayerEnabled();

        // 市场背景是服务层的自动写入，来源记成 lease：它不能替用户认领这次开关。
        store.useVideoLayerSettingsStore.getState().setVideoLayerEnabled(true, 'lease');
        release();

        expect(store.useVideoLayerSettingsStore.getState().videoLayerEnabled).toBe(false);
        expect(storage.get('video_layer_enabled')).toBe('false');
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
