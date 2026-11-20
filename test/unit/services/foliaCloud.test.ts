// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/foliaCloud.test.ts
// 云服务地址与开关。
//
// 这块的契约改过两次，现在钉的是第三次的结论：
//
//   · H34 之前：写死一个官方域名、默认开，README 却声称「源码不含内置第三方后端地址」；
//   · H34：地址留空、默认关。承诺兑现了，但云缓存是个**公开服务**（读不需要任何凭据），
//     留空只是让所有人用不了 —— 用户反馈「云缓存现在拉取不了」；
//   · 现在：地址内置成项目自己的公共实例、**不允许用户修改**、默认开启，只保留开关。
//     README 同步改成如实说明。
//
// 这里钉住四件事：
//
//  1. 不配置任何东西就能用（地址内置、开关默认开）；
//  2. 地址**改不动** —— 调用方传进来的 baseUrl 一律被忽略；
//  3. 开关仍然有效：关掉之后一个请求都不发；
//  4. v3 键里存着的空地址不会盖掉新默认值（升到 v4 的理由）。

const STORAGE_KEY = 'foliaCloudSettings.v4';
const PREVIOUS_KEY = 'foliaCloudSettings.v3';
const LEGACY_KEY = 'foliaCloudSettings.v2';
const BUILTIN = ['https://apif', 'tangbot', 'xyz'].join('.');

/**
 * 每个用例都要重新载入模块：设置缓存在模块作用域里（`cachedSettings`），
 * 复用一个实例会让第二个用例看到上一个留下的值。
 */
const loadModule = async () => {
    vi.resetModules();
    return import('@/services/foliaCloud');
};

beforeEach(() => {
    localStorage.clear();
});

describe('默认值：内置地址、默认开启', () => {
    it('什么都不配就能用', async () => {
        const cloud = await loadModule();
        expect(cloud.DEFAULT_CLOUD_BASE_URL).toBe(BUILTIN);
        expect(cloud.readFoliaCloudSettings()).toEqual({ enabled: true, baseUrl: BUILTIN, writeToken: '' });
        expect(cloud.isFoliaCloudCacheEnabled()).toBe(true);
    });

    it('URL 拼在内置地址的 /api 下', async () => {
        const cloud = await loadModule();
        expect(cloud.resolveCloudApiUrl('ai-cache/songs')).toBe(`${BUILTIN}/api/ai-cache/songs`);
        expect(cloud.resolveCloudApiUrl('/ai-cache/songs')).toBe(`${BUILTIN}/api/ai-cache/songs`);
    });
});

describe('地址固定：改不动', () => {
    /* 用户不能把请求引到别的主机上 —— 设置页只展示文本，服务层也不认这个入参。 */
    it('传进来的 baseUrl 被忽略', async () => {
        const cloud = await loadModule();
        cloud.updateFoliaCloudSettings({ baseUrl: 'https://evil.example' });
        expect(cloud.readFoliaCloudSettings().baseUrl).toBe(BUILTIN);
        expect(cloud.resolveCloudApiUrl('ai-cache/songs')).toBe(`${BUILTIN}/api/ai-cache/songs`);
    });

    it('想把地址清空也清不掉', async () => {
        const cloud = await loadModule();
        cloud.updateFoliaCloudSettings({ baseUrl: '   ' });
        expect(cloud.readFoliaCloudSettings().baseUrl).toBe(BUILTIN);
    });

    /* localStorage 里被人改过（旧版本、手动编辑、导入配置）也以内置值为准。 */
    it('存储里写着别的地址时仍用内置值', async () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: true, baseUrl: 'https://old.example', writeToken: 'x' }));
        const cloud = await loadModule();
        expect(cloud.readFoliaCloudSettings().baseUrl).toBe(BUILTIN);
        expect(cloud.readFoliaCloudSettings().writeToken).toBe('');
    });
});

describe('开关仍然有效', () => {
    it('关掉之后云能力不可用', async () => {
        const cloud = await loadModule();
        cloud.updateFoliaCloudSettings({ enabled: false });
        expect(cloud.isFoliaCloudCacheEnabled()).toBe(false);
        // 地址还在（它本来就是固定的），只是不发请求 —— 判断只看开关。
        expect(cloud.readFoliaCloudSettings().baseUrl).toBe(BUILTIN);
    });

    it('关掉再打开能恢复', async () => {
        const cloud = await loadModule();
        cloud.updateFoliaCloudSettings({ enabled: false });
        cloud.updateFoliaCloudSettings({ enabled: true });
        expect(cloud.isFoliaCloudCacheEnabled()).toBe(true);
    });

    it('改开关会通知订阅者，并递增版本号', async () => {
        const cloud = await loadModule();
        const seen = vi.fn();
        const unsubscribe = cloud.subscribeFoliaCloudSettings(seen);
        const before = cloud.getFoliaCloudSettingsVersion();
        cloud.updateFoliaCloudSettings({ enabled: false });
        expect(seen).toHaveBeenCalledTimes(1);
        expect(cloud.getFoliaCloudSettingsVersion()).toBe(before + 1);
        unsubscribe();
        cloud.updateFoliaCloudSettings({ enabled: true });
        expect(seen).toHaveBeenCalledTimes(1);
    });

    it('配置落在 v4 键上', async () => {
        const cloud = await loadModule();
        cloud.updateFoliaCloudSettings({ enabled: false });
        expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).enabled).toBe(false);
    });
});

describe('从旧版本升级', () => {
    /*
     * 这是这次升 v4 的**核心理由**：v3 那版把空地址存进了用户的 localStorage，
     * 如果继续读 v3，那个空串会盖住新的内置默认值 —— 改动对老用户完全不生效，
     * 「云缓存拉取不了」照旧。
     */
    it('v3 里存的空地址不会盖掉新的内置默认值', async () => {
        localStorage.setItem(PREVIOUS_KEY, JSON.stringify({ enabled: false, baseUrl: '', writeToken: '' }));
        const cloud = await loadModule();
        expect(cloud.readFoliaCloudSettings().baseUrl).toBe(BUILTIN);
        // 开关是用户自己的选择，读不到 v4 就等于没配过 -> 默认开。
        expect(cloud.isFoliaCloudCacheEnabled()).toBe(true);
    });

    it('v3 里存的别的地址也不会采用', async () => {
        localStorage.setItem(PREVIOUS_KEY, JSON.stringify({ enabled: true, baseUrl: 'https://self.hosted.example', writeToken: 't' }));
        const cloud = await loadModule();
        expect(cloud.readFoliaCloudSettings().baseUrl).toBe(BUILTIN);
    });

    it('v2 的自建地址不再搬过来（地址已固定）', async () => {
        localStorage.setItem(LEGACY_KEY, JSON.stringify({ enabled: true, baseUrl: 'https://self.hosted.example' }));
        const cloud = await loadModule();
        expect(cloud.readFoliaCloudSettings()).toEqual({ enabled: true, baseUrl: BUILTIN, writeToken: '' });
    });

    it('老配置是坏 JSON 时不炸，按默认值走', async () => {
        localStorage.setItem(PREVIOUS_KEY, '{not json');
        const cloud = await loadModule();
        expect(cloud.readFoliaCloudSettings()).toEqual({ enabled: true, baseUrl: BUILTIN, writeToken: '' });
    });

    it('用户关掉开关后，重载模块仍然是关的', async () => {
        const cloud = await loadModule();
        cloud.updateFoliaCloudSettings({ enabled: false });
        const reloaded = await loadModule();
        expect(reloaded.isFoliaCloudCacheEnabled()).toBe(false);
    });
});
