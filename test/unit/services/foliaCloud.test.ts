// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/foliaCloud.test.ts
// 云服务地址与开关（issue H34 / C6）。
//
// H34 要解的是一句**对外承诺与代码相反**：README 说「源码本身不含任何内置的第三方后端地址」，
// 而代码里写死了一个官方域名，出厂就用它。这里钉住三件事：
//
//  1. 没有任何配置时，**一个地址都没有** —— 云能力关闭，任何调用方都拼不出 URL；
//  2. 用户从老版本升上来：自己填过的地址要搬过来（自建用户不该被打回空配置），
//     而当年那个内置域名那一条要**被丢掉**（它正是 H34 要清掉的东西）；
//  3. 清空地址就是真的没有地址，不回退到任何内置值。

const STORAGE_KEY = 'foliaCloudSettings.v3';
const LEGACY_KEY = 'foliaCloudSettings.v2';
/* 当年那个内置域名：只在这里用来构造「老配置」样本，生产代码里它只用于辨认并丢弃。 */
const LEGACY_BUILTIN = ['https://apif', 'tangbot', 'xyz'].join('.');

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

describe('默认值：没有内置地址', () => {
  it('什么都没配时地址为空，云能力关闭', async () => {
    const cloud = await loadModule();
    expect(cloud.DEFAULT_CLOUD_BASE_URL).toBe('');
    expect(cloud.readFoliaCloudSettings()).toEqual({ enabled: false, baseUrl: '', writeToken: '' });
    expect(cloud.isFoliaCloudCacheEnabled()).toBe(false);
  });

  it('没有地址时拼不出任何 URL —— 这是「不发请求」的落点', async () => {
    const cloud = await loadModule();
    expect(cloud.resolveCloudBaseUrl()).toBe('');
    expect(cloud.resolveCloudApiUrl('ai-cache/stage/abc')).toBe('');
  });

  /* 打开开关但没填地址，仍然等于关闭：开关不能替用户决定往哪发。 */
  it('只打开开关、不填地址，云能力依然是关的', async () => {
    const cloud = await loadModule();
    cloud.updateFoliaCloudSettings({ enabled: true });
    expect(cloud.readFoliaCloudSettings().baseUrl).toBe('');
    expect(cloud.isFoliaCloudCacheEnabled()).toBe(false);
  });
});

describe('配置读写', () => {
  it('填了地址并打开开关才算可用，URL 拼在 /api 下', async () => {
    const cloud = await loadModule();
    cloud.updateFoliaCloudSettings({ enabled: true, baseUrl: 'https://my.example.com' });
    expect(cloud.isFoliaCloudCacheEnabled()).toBe(true);
    expect(cloud.resolveCloudApiUrl('ai-cache/songs')).toBe('https://my.example.com/api/ai-cache/songs');
  });

  /* 手输地址时最常见的就是只打域名，或者粘了个带尾斜杠的。 */
  it('补协议、去尾斜杠，并容忍路径前导斜杠', async () => {
    const cloud = await loadModule();
    cloud.updateFoliaCloudSettings({ enabled: true, baseUrl: '  my.example.com/  ' });
    expect(cloud.readFoliaCloudSettings().baseUrl).toBe('https://my.example.com');
    expect(cloud.resolveCloudApiUrl('/ai-cache/songs')).toBe('https://my.example.com/api/ai-cache/songs');
  });

  it('清空地址就是真的没有地址，不回退到任何内置值', async () => {
    const cloud = await loadModule();
    cloud.updateFoliaCloudSettings({ enabled: true, baseUrl: 'https://my.example.com' });
    cloud.updateFoliaCloudSettings({ baseUrl: '' });
    expect(cloud.readFoliaCloudSettings().baseUrl).toBe('');
    expect(cloud.isFoliaCloudCacheEnabled()).toBe(false);
  });

  it('写入令牌留空表示只读，写进去之后按原样取回', async () => {
    const cloud = await loadModule();
    expect(cloud.resolveCloudWriteToken()).toBe('');
    cloud.updateFoliaCloudSettings({ enabled: true, baseUrl: 'https://my.example.com', writeToken: '  secret-token  ' });
    expect(cloud.resolveCloudWriteToken()).toBe('secret-token');
  });

  it('改动会通知订阅者，并递增版本号', async () => {
    const cloud = await loadModule();
    const seen = vi.fn();
    const unsubscribe = cloud.subscribeFoliaCloudSettings(seen);
    const before = cloud.getFoliaCloudSettingsVersion();
    cloud.updateFoliaCloudSettings({ enabled: true, baseUrl: 'https://my.example.com' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(cloud.getFoliaCloudSettingsVersion()).toBe(before + 1);
    unsubscribe();
    cloud.updateFoliaCloudSettings({ enabled: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('配置落在 v3 键上', async () => {
    const cloud = await loadModule();
    cloud.updateFoliaCloudSettings({ enabled: true, baseUrl: 'https://my.example.com' });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).baseUrl).toBe('https://my.example.com');
  });
});

describe('从 v2 升级（issue H34 的迁移）', () => {
  /*
   * 自建用户：他自己填的地址必须搬过来。不搬的话，升级等于把他的服务「弄丢」了 ——
   * 他看到的会是「云缓存莫名其妙关了」。
   */
  it('搬来自建用户自己填的地址', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ enabled: true, baseUrl: 'https://self.hosted.example' }));
    const cloud = await loadModule();
    expect(cloud.readFoliaCloudSettings()).toEqual({
      enabled: true,
      baseUrl: 'https://self.hosted.example',
      writeToken: '',
    });
    expect(cloud.isFoliaCloudCacheEnabled()).toBe(true);
  });

  /*
   * 出厂默认那一条：`enabled: true` + 内置域名，用户从来没动过。
   * 这正是 H34 要清掉的东西 —— 搬过来的话，升级就等于「悄悄继续发往那个域名」。
   */
  it('丢掉当年那个内置域名，回落成关闭', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ enabled: true, baseUrl: LEGACY_BUILTIN }));
    const cloud = await loadModule();
    expect(cloud.readFoliaCloudSettings().baseUrl).toBe('');
    expect(cloud.isFoliaCloudCacheEnabled()).toBe(false);
    expect(cloud.resolveCloudApiUrl('ai-cache/songs')).toBe('');
  });

  it('老配置没有地址时也不搬', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ enabled: true, baseUrl: '' }));
    const cloud = await loadModule();
    expect(cloud.readFoliaCloudSettings()).toEqual({ enabled: false, baseUrl: '', writeToken: '' });
  });

  it('老配置是坏 JSON 时不炸，按默认值走', async () => {
    localStorage.setItem(LEGACY_KEY, '{not json');
    const cloud = await loadModule();
    expect(cloud.readFoliaCloudSettings()).toEqual({ enabled: false, baseUrl: '', writeToken: '' });
  });

  /* 搬过一次就落盘：否则用户清空地址之后，下一次读又会把老的搬回来。 */
  it('搬迁结果落盘，清空之后不会再搬回来', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ enabled: true, baseUrl: 'https://self.hosted.example' }));
    const cloud = await loadModule();
    expect(cloud.readFoliaCloudSettings().baseUrl).toBe('https://self.hosted.example');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).baseUrl).toBe('https://self.hosted.example');

    cloud.updateFoliaCloudSettings({ baseUrl: '' });
    const reloaded = await loadModule();
    expect(reloaded.readFoliaCloudSettings().baseUrl).toBe('');
  });

  /* v3 已经有了自己的配置时，不再看 v2。 */
  it('v3 有配置时忽略 v2', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ enabled: true, baseUrl: 'https://old.example' }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: false, baseUrl: 'https://new.example', writeToken: '' }));
    const cloud = await loadModule();
    expect(cloud.readFoliaCloudSettings().baseUrl).toBe('https://new.example');
    expect(cloud.isFoliaCloudCacheEnabled()).toBe(false);
  });
});
