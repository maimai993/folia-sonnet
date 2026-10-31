import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildAiEnv,
    isAiConfigured,
    readAiSettings,
    resolveAiApiKey,
    resolveAiBaseUrl,
    resolveAiChatCompletionsUrl,
    resolveAiModel,
    writeAiSettings,
} from '@/services/aiSettings';

// #54：只用合成凭据验证旧设置迁移、误迁移写回的安全阻断，以及显式保存后的稳定性。
const STORAGE_KEY = 'foliaAiProviderSettings';
const KEY = 'synthetic-compat-key';
const URL_ = 'https://compat.example.invalid/v1';
const MODEL = 'synthetic-model';

const installStorage = (seed: unknown) => {
    const store = new Map([[STORAGE_KEY, JSON.stringify(seed)]]);
    const setItem = vi.fn((key: string, value: string) => { store.set(key, String(value)); });
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem,
    });
    return { raw: () => store.get(STORAGE_KEY)!, setItem };
};
const legacy = (extra: Record<string, unknown> = {}) => ({
    provider: 'openai', openaiApiKey: KEY, openaiApiUrl: URL_, openaiApiModel: MODEL,
    openaiApiTemperature: '0.3', openaiApiStream: true, ...extra,
});
// aa67ffbe 的读设置 + 任意一次写回会删除旧字段、复制 Key，并保留错误的 provider。
const contaminated = (extra: Record<string, unknown> = {}) => ({
    provider: 'openai', geminiApiKey: '', geminiApiUrl: '',
    apiKeys: { openai: KEY, custom: KEY }, apiModels: { custom: MODEL, deepseek: MODEL },
    apiBaseUrls: {}, customApiUrl: URL_, apiTemperature: '0.3', apiStream: false, ...extra,
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('legacy compatible AI settings (#54)', () => {
    it('moves the old compatible provider and credentials to custom only', () => {
        installStorage(legacy());
        const settings = readAiSettings();
        expect(settings.provider).toBe('custom');
        expect(settings.apiKeys).toEqual({ custom: KEY });
        expect(settings.apiModels).toEqual({ custom: MODEL, deepseek: MODEL });
        expect(resolveAiApiKey(settings)).toBe(KEY);
        expect(resolveAiBaseUrl(settings)).toBe(URL_);
        expect(resolveAiModel(settings)).toBe(MODEL);
        expect(buildAiEnv(settings)).toMatchObject({
            AI_PROVIDER: 'openai', OPENAI_API_KEY: KEY,
            OPENAI_API_URL: `${URL_}/chat/completions`, OPENAI_API_MODEL: MODEL,
        });
    });
    it('merges partial maps and preserves newer explicit empty values and stream:false', () => {
        installStorage(legacy({
            apiKeys: { custom: '', glm: 'synthetic-glm' }, apiModels: { custom: '', kimi: 'synthetic-kimi' },
            customApiUrl: '', apiTemperature: '', apiStream: false,
        }));
        const settings = readAiSettings();
        expect(settings.apiKeys).toEqual({ custom: '', glm: 'synthetic-glm' });
        expect(settings.apiModels).toEqual({ custom: '', deepseek: MODEL, kimi: 'synthetic-kimi' });
        expect(settings.customApiUrl).toBe('');
        expect(settings.apiTemperature).toBe('');
        expect(settings.apiStream).toBe(false);
        expect(isAiConfigured(settings)).toBe(false);
    });
    it('keeps an empty old key as an explicit empty custom entry', () => {
        installStorage(legacy({ openaiApiKey: '' }));
        expect(readAiSettings()).toMatchObject({ provider: 'custom', apiKeys: { custom: '' } });
        expect(isAiConfigured()).toBe(false);
    });
    it('never resolves a missing legacy custom URL to the official fallback', () => {
        installStorage(legacy({ openaiApiUrl: '' }));
        const settings = readAiSettings();
        expect(settings.provider).toBe('custom');
        expect(isAiConfigured(settings)).toBe(false);
        expect(() => resolveAiChatCompletionsUrl(settings)).toThrow('CUSTOM_API_URL is not configured');
        expect(() => buildAiEnv(settings)).toThrow('CUSTOM_API_URL is not configured');
    });
    it('keeps DeepSeek selection and its separate key', () => {
        installStorage(legacy({ provider: 'deepseek', deepseekApiKey: 'synthetic-deepseek' }));
        expect(readAiSettings()).toMatchObject({
            provider: 'deepseek', apiKeys: { deepseek: 'synthetic-deepseek', custom: KEY },
        });
    });
    it('preserves a distinct explicitly stored official key', () => {
        installStorage(legacy({ apiKeys: { openai: 'synthetic-official' } }));
        const settings = readAiSettings();
        expect(settings.provider).toBe('openai');
        expect(resolveAiApiKey(settings)).toBe('synthetic-official');
        expect(resolveAiChatCompletionsUrl(settings)).toBe('https://api.openai.com/v1/chat/completions');
        expect(settings.apiKeys.custom).toBe(KEY);
    });
    it('does not treat official model/site selection as permission to copy a legacy key', () => {
        installStorage(legacy({ apiModels: { openai: 'synthetic-official-model' }, apiBaseUrls: { openai: '' } }));
        expect(readAiSettings().provider).toBe('openai');
        expect(isAiConfigured()).toBe(false);
        expect(readAiSettings().apiKeys.openai).toBeUndefined();
    });
    it.each(['openaiApiKey', 'openaiApiUrl', 'openaiApiModel'])('recognizes an empty legacy field %s', field => {
        installStorage({ provider: 'openai', [field]: '' });
        expect(readAiSettings().provider).toBe('custom');
    });
    it('does not write or dispatch events during repeated reads', () => {
        const storage = installStorage(legacy());
        const dispatchEvent = vi.fn();
        vi.stubGlobal('window', { dispatchEvent });
        const before = storage.raw();
        expect(readAiSettings()).toEqual(readAiSettings());
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(dispatchEvent).not.toHaveBeenCalled();
        expect(storage.raw()).toBe(before);
    });
    it('is idempotent after an unrelated explicit save', () => {
        const storage = installStorage(legacy());
        const next = writeAiSettings({ apiTemperature: '0.5' });
        expect(readAiSettings()).toEqual(next);
        const persisted = JSON.parse(storage.raw());
        expect(persisted.provider).toBe('custom');
        expect(persisted.apiKeys).toEqual({ custom: KEY });
        expect(persisted).not.toHaveProperty('openaiApiKey');
    });
});

describe('previously copied credentials need explicit confirmation (#54)', () => {
    it.each([
        contaminated(),
        contaminated({ customApiUrl: '' }),
        contaminated({ apiKeys: { custom: ` ${KEY} `, openai: KEY } }),
        contaminated({ apiModels: { openai: 'synthetic-official-model' } }),
        contaminated({ apiBaseUrls: { openai: 'https://official-relay.example.invalid/v1' } }),
        contaminated({ apiKeys: { openai: KEY, custom: '' } }),
        legacy({ apiKeys: { openai: KEY } }),
        legacy({ apiKeys: { openai: KEY, custom: 'synthetic-newer-custom' } }),
    ])('blocks an ambiguous unversioned official copy without guessing another destination: %j', seed => {
        const storage = installStorage(seed);
        const before = storage.raw();
        const settings = readAiSettings();
        expect(settings.provider).toBe('openai');
        expect(settings.apiKeys.openai).toBe('');
        expect(resolveAiApiKey(settings)).toBe('');
        expect(isAiConfigured(settings)).toBe(false);
        expect(buildAiEnv(settings).OPENAI_API_KEY).toBeUndefined();
        expect(storage.raw()).toBe(before);
        expect(storage.setItem).not.toHaveBeenCalled();
    });
    it('also removes the unconfirmed copy when another provider is selected', () => {
        installStorage(contaminated({ provider: 'gemini' }));
        expect(readAiSettings().provider).toBe('gemini');
        expect(readAiSettings().apiKeys.openai).toBe('');
        writeAiSettings({ provider: 'openai' });
        expect(isAiConfigured()).toBe(false);
    });
    it('does not re-enable a blocked copy on an unrelated save', () => {
        installStorage(contaminated());
        const next = writeAiSettings({ apiTemperature: '0.8' });
        expect(next.apiKeys).toEqual({ openai: '', custom: KEY });
        expect(readAiSettings()).toEqual(next);
        expect(isAiConfigured()).toBe(false);
    });
    it('lets the user select custom without losing the original key or URL', () => {
        installStorage(contaminated());
        writeAiSettings({ provider: 'custom' });
        expect(isAiConfigured()).toBe(true);
        expect(resolveAiApiKey(readAiSettings())).toBe(KEY);
        expect(resolveAiBaseUrl(readAiSettings())).toBe(URL_);
    });
    it('lets the user explicitly confirm an official key, even if intentionally reused', () => {
        installStorage(contaminated());
        const settings = readAiSettings();
        const confirmed = writeAiSettings({ apiKeys: { ...settings.apiKeys, openai: KEY } });
        expect(confirmed.provider).toBe('openai');
        expect(readAiSettings()).toEqual(confirmed);
        expect(isAiConfigured()).toBe(true);
    });
    it('keeps a normal new official-only installation working', () => {
        installStorage({ provider: 'openai', apiKeys: { openai: 'synthetic-official' } });
        expect(isAiConfigured()).toBe(true);
        expect(resolveAiApiKey(readAiSettings())).toBe('synthetic-official');
    });
    it.each([undefined, 0, 2, '1', null])('does not trust an unknown routing marker %j', credentialRoutingVersion => {
        installStorage(contaminated({ credentialRoutingVersion }));
        expect(isAiConfigured()).toBe(false);
    });
    it('only stores the routing marker on an explicit write, not in public settings', () => {
        const storage = installStorage(contaminated());
        const settings = readAiSettings();
        expect(settings).not.toHaveProperty('credentialRoutingVersion');
        expect(JSON.parse(storage.raw())).not.toHaveProperty('credentialRoutingVersion');
        writeAiSettings({ apiKeys: { ...settings.apiKeys, openai: KEY } });
        expect(JSON.parse(storage.raw()).credentialRoutingVersion).toBe(1);
        expect(readAiSettings()).not.toHaveProperty('credentialRoutingVersion');
        expect(resolveAiApiKey(readAiSettings())).toBe(KEY);
    });
    it('supports new users intentionally entering the same key for official and custom', () => {
        installStorage({});
        writeAiSettings({ provider: 'custom', customApiUrl: URL_, apiKeys: { custom: KEY } });
        const settings = readAiSettings();
        writeAiSettings({ provider: 'openai', apiKeys: { ...settings.apiKeys, openai: KEY } });
        expect(readAiSettings().apiKeys).toEqual({ openai: KEY, custom: KEY });
        expect(isAiConfigured()).toBe(true);
    });
    it.each([null, 12, false, { nested: 'synthetic-invalid' }])('does not coerce a malformed legacy key %j into a credential', key => {
        installStorage(legacy({ openaiApiKey: key, deepseekApiKey: key }));
        expect(readAiSettings().apiKeys).toEqual({ custom: '', deepseek: '' });
        expect(isAiConfigured()).toBe(false);
    });
    it('does not coerce malformed map entries into keys', () => {
        installStorage({ provider: 'openai', apiKeys: { openai: { nested: 'synthetic-invalid' } } });
        expect(readAiSettings().apiKeys).toEqual({});
        expect(isAiConfigured()).toBe(false);
    });
    it('keeps distinct modern official and custom keys working', () => {
        installStorage(contaminated({
            apiKeys: { openai: 'synthetic-official', custom: KEY },
            credentialRoutingVersion: 1,
        }));
        expect(isAiConfigured()).toBe(true);
        expect(resolveAiApiKey(readAiSettings())).toBe('synthetic-official');
    });
});
