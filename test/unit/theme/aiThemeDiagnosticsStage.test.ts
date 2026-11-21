// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateThemeFromLyrics, isMissingAiApiKeyError } from '@/services/gemini';
import { generateThemeFromLyrics as generateLegacyThemeFromLyrics } from '@/services/aiText';
import { clearAiThemeDiagnostics, readLastAiThemeAttempt } from '@/utils/aiThemeDiagnostics';

// 验证 #353：主链路 services/gemini、兼容链路 services/aiText 与安卓冷启动桥未就绪时的阶段诊断与降级判定。

const runtimeState = vi.hoisted(() => ({
    androidShell: false,
}));

vi.mock('@/platform/runtime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/platform/runtime')>(),
    isAndroidAppShell: () => runtimeState.androidShell,
}));

vi.mock('@/services/aiNativeFetch', () => ({
    createAiFetch: () => async () => ({
        ok: true,
        status: 200,
        json: async () => ({ hit: false }),
    }) as unknown as Response,
}));

const TIMEOUT_MS = 20000;

beforeEach(async () => {
    const { useAiInferenceSettingsStore } = await import('@/stores/useAiInferenceSettingsStore');
    useAiInferenceSettingsStore.getState().setAiInferenceDisabled(false);
    runtimeState.androidShell = false;
    clearAiThemeDiagnostics();
    localStorage.clear();
    localStorage.setItem('foliaAiProviderSettings', JSON.stringify({ provider: 'gemini', geminiApiKey: '' }));
    localStorage.setItem('foliaCloudSettings.v2', JSON.stringify({
        enabled: true,
        baseUrl: 'https://cloud.test',
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('AI 主题诊断阶段记录与安卓冷启动降级 (#353)', () => {
    it('Electron 桥抛错时记录 stage=electron-bridge 而不是 unknown', async () => {
        (window as unknown as { electron: { generateTheme: () => Promise<never> } }).electron = {
            generateTheme: vi.fn().mockRejectedValue(new Error('IPC bridge timeout')),
        };

        await expect(generateThemeFromLyrics('测试歌词', {
            songTitle: '测试曲',
            trigger: 'auto',
        })).rejects.toThrow('IPC bridge timeout');

        const attempt = readLastAiThemeAttempt();
        expect(attempt).toMatchObject({
            ok: false,
            stage: 'electron-bridge',
            trigger: 'auto',
            error: 'IPC bridge timeout',
        });
    }, TIMEOUT_MS);

    it('部署端点网络失败时记录 stage=web-endpoint 而不是 unknown', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));

        await expect(generateThemeFromLyrics('测试歌词', {
            songTitle: '测试曲',
            trigger: 'auto',
        })).rejects.toThrow('Network down');

        const attempt = readLastAiThemeAttempt();
        expect(attempt).toMatchObject({
            ok: false,
            stage: 'web-endpoint',
            trigger: 'auto',
            error: 'Network down',
        });
    }, TIMEOUT_MS);

    it('安卓冷启动桥未就绪且无 Key 时，不误打同源 /api 而转为可降级的 missing-key', async () => {
        runtimeState.androidShell = true;
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        let caught: unknown = null;
        try {
            await generateThemeFromLyrics('测试歌词', {
                songTitle: '测试曲',
                trigger: 'auto',
            });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(Error);
        expect(isMissingAiApiKeyError(caught)).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(readLastAiThemeAttempt()).toMatchObject({
            ok: false,
            stage: 'missing-key',
            trigger: 'auto',
        });
    }, TIMEOUT_MS);

    it('兼容链路 aiText 在安卓壳缺 Key 时日志阶段为 android-missing-key', async () => {
        runtimeState.androidShell = true;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(generateLegacyThemeFromLyrics('测试歌词')).rejects.toThrow('Server configuration error');

        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining('stage=android-missing-key'),
            expect.any(Error),
        );
    }, TIMEOUT_MS);
});
