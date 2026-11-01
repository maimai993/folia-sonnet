import { beforeEach, describe, expect, it, vi } from 'vitest';

// 原生后台主题只认当前歌曲/歌词/policy，禁用或非当前曲目不读取，不触碰音频控制。
const h = vi.hoisted(() => ({ write: vi.fn(), read: vi.fn(), song: { id: 'A', name: 'Song', sourceRef: { kind: 'online', providerId: 'test', mediaId: 'A' } } }));
vi.mock('@/platform/runtime', () => ({ isCapacitorAndroid: () => true }));
vi.mock('@/services/nativeSettingsBridge', () => ({ writeNativeSettings: h.write }));
vi.mock('@/stores/usePlaybackStore', () => ({ usePlaybackStore: { getState: () => ({ currentSong: h.song }) } }));
const { configureBackgroundTheme, readBackgroundTheme } = await import('@/services/backgroundThemeBridge');
const config = { enabled: true, cloudEnabled: true, cloudBaseUrl: 'https://example.test', system: 's', promptTemplate: 'p', policy: 'policy' };
beforeEach(() => {
    vi.clearAllMocks();
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
