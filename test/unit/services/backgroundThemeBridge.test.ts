import { beforeEach, describe, expect, it, vi } from 'vitest';

// 原生后台主题只认当前歌曲/歌词/policy，禁用或非当前曲目不读取，不触碰音频控制。
const h = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn(), song: { id: 'A', name: 'Song', sourceRef: { kind: 'online', providerId: 'test', mediaId: 'A' } } }));
vi.mock('@/platform/runtime', () => ({ isCapacitorAndroid: () => true }));
vi.mock('@/services/nativeSettingsBridge', () => ({ writeNativeSettings: h.write }));
vi.mock('@/stores/usePlaybackStore', () => ({ usePlaybackStore: { getState: () => ({ currentSong: h.song }) } }));
const {
    configureBackgroundTheme,
    isSameBackgroundThemeConfig,
    mergeBackgroundThemeConfig,
    readActiveBackgroundThemeConfig,
    readBackgroundTheme,
} = await import('@/services/backgroundThemeBridge');
const config = { enabled: true, cloudEnabled: true, cloudBaseUrl: 'https://example.test', system: 's', promptTemplate: 'p', policy: 'policy' };
beforeEach(() => {
    vi.clearAllMocks();
    h.write.mockResolvedValue({});
    vi.stubGlobal('window', { Capacitor: { Plugins: { FoliaNative: { getBackgroundThemeResult: h.read } } } });
});
describe('background theme result bridge', () => {
    it('sends only matching song identity and current lyric text to native', async () => {
        await configureBackgroundTheme(config);
        h.read.mockResolvedValue({ payload: { theme: {} }, source: 'cloud' });
        expect(await readBackgroundTheme('Song', 'lyrics')).toMatchObject({ source: 'cloud' });
        expect(h.read).toHaveBeenCalledWith({ songKey: 'online:test:A', policy: 'policy', lyricText: 'lyrics' });
        expect(h.write).toHaveBeenCalledWith({ 'backgroundTheme.config': JSON.stringify(config) });
    });
    it('does not read disabled tasks or other songs', async () => {
        await configureBackgroundTheme({ ...config, enabled: false });
        expect(await readBackgroundTheme('Song', 'lyrics')).toBeNull();
        await configureBackgroundTheme(config);
        expect(await readBackgroundTheme('Other', 'lyrics')).toBeNull();
        expect(h.read).not.toHaveBeenCalled();
    });
});

/*
 * issue #209 第三条：回前台按当前设置重算配置时，不能把原生已经算好的主题结果顶掉。
 * 原生结果的 identity 里带「设置指纹」，所以「重写配置」本身就是一种破坏 —— 这里守住两条：
 * 重算一致就不写盘；算不出内容的字段不覆盖已下发的值。
 */
describe('background theme config push', () => {
    it('重算出一模一样的配置时不再写原生设置', async () => {
        const unique = { ...config, system: 'dedupe-system', promptTemplate: 'dedupe-prompt', policy: 'dedupe-policy' };
        await configureBackgroundTheme(unique);
        expect(h.write).toHaveBeenCalledTimes(1);

        const previous = readActiveBackgroundThemeConfig();
        const recomputed = mergeBackgroundThemeConfig(previous, { ...unique });
        expect(isSameBackgroundThemeConfig(previous, recomputed)).toBe(true);
        await configureBackgroundTheme(recomputed);
        // 一个字节都没多写：回前台重算不该有副作用。
        expect(h.write).toHaveBeenCalledTimes(1);
    });

    it('算不出内容的字段保留已下发的值，配置因此等价、不重写', async () => {
        const known = {
            ...config,
            cloudBaseUrl: 'https://known.test',
            system: 'known-system',
            promptTemplate: 'known-prompt',
            policy: 'known-policy',
        };
        await configureBackgroundTheme(known);
        const written = h.write.mock.calls.length;

        // 刚回前台那一拍：导演设置 / 云设置 / i18n 还没水合完，拼出来是空串。
        const merged = mergeBackgroundThemeConfig(readActiveBackgroundThemeConfig(), {
            ...known, cloudBaseUrl: '', system: '', promptTemplate: '', policy: '',
        });

        expect(merged).toMatchObject({
            cloudBaseUrl: 'https://known.test',
            system: 'known-system',
            promptTemplate: 'known-prompt',
            policy: 'known-policy',
        });
        expect(isSameBackgroundThemeConfig(readActiveBackgroundThemeConfig(), merged)).toBe(true);

        await configureBackgroundTheme(merged);
        expect(h.write).toHaveBeenCalledTimes(written);
    });

    it('真的改了配置才下发整份 JSON', async () => {
        await configureBackgroundTheme({ ...config, system: 'first-system', promptTemplate: 'p1', policy: 'policy-1' });
        const written = h.write.mock.calls.length;
        await configureBackgroundTheme({ ...config, system: 'second-system', promptTemplate: 'p2', policy: 'policy-2' });
        expect(h.write).toHaveBeenCalledTimes(written + 1);
        expect(h.write).toHaveBeenLastCalledWith({
            'backgroundTheme.config': JSON.stringify({ ...config, system: 'second-system', promptTemplate: 'p2', policy: 'policy-2' }),
        });
    });

    it('下发失败不记签名，下次还会重试', async () => {
        h.write.mockResolvedValueOnce(null);
        const flaky = { ...config, system: 'flaky-system', promptTemplate: 'flaky-prompt', policy: 'flaky-policy' };
        await configureBackgroundTheme(flaky);
        expect(h.write).toHaveBeenCalledTimes(1);
        await configureBackgroundTheme(flaky);
        expect(h.write).toHaveBeenCalledTimes(2);
    });

    it('没有已下发配置时按原样合并', () => {
        expect(mergeBackgroundThemeConfig(null, config)).toEqual(config);
    });
});
