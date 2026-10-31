import { afterEach, describe, expect, it } from 'vitest';
import {
    buildAiEnv,
    readAiSettings,
    resolveAiApiKey,
    resolveAiBaseUrl,
    resolveAiChatCompletionsUrl,
    resolveAiModel,
    writeAiSettings,
} from '@/services/aiSettings';

// test/unit/services/aiSettingsLegacyCompatMigration.test.ts
// 旧版「其他兼容接口」凭据的迁移语义：只归 custom、partial map 合并、空值与 stream:false 保留、读不写盘。
// 这里的 key 全是合成值，不对应任何真实凭据。

const STORAGE_KEY = 'foliaAiProviderSettings';
const LEGACY_KEY = 'sk-synthetic-compat-0001';
const LEGACY_URL = 'https://compat-relay.example.invalid/v1';
const LEGACY_MODEL = 'synthetic-model-compat';

const installStorage = (seed?: unknown) => {
    const store = new Map<string, string>();
    let writes = 0;
    const storage: Storage = {
        get length() {
            return store.size;
        },
        getItem: key => store.get(key) ?? null,
        key: index => Array.from(store.keys())[index] ?? null,
        setItem: (key, value) => {
            writes += 1;
            store.set(key, String(value));
        },
        removeItem: key => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
    };
    if (seed !== undefined) store.set(STORAGE_KEY, JSON.stringify(seed));
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    return {
        raw: () => store.get(STORAGE_KEY) ?? null,
        writes: () => writes,
    };
};

const legacyShape = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    provider: 'openai',
    geminiApiKey: '',
    geminiApiUrl: '',
    openaiApiUrl: LEGACY_URL,
    openaiApiKey: LEGACY_KEY,
    openaiApiModel: LEGACY_MODEL,
    openaiApiTemperature: '0.3',
    openaiApiStream: false,
    ...extra,
});

afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('旧版「其他兼容接口」凭据的迁移', () => {
    it('迁到 custom，Key 不再顺手复制给官方 openai', () => {
        installStorage(legacyShape());
        const settings = readAiSettings();

        expect(settings.provider).toBe('custom');
        expect(settings.customApiUrl).toBe(LEGACY_URL);
        expect(settings.apiKeys).toEqual({ custom: LEGACY_KEY });
        expect(settings.apiModels).toEqual({ custom: LEGACY_MODEL, deepseek: LEGACY_MODEL });
        expect(settings.apiStream).toBe(false);
        expect(resolveAiApiKey(settings)).toBe(LEGACY_KEY);
        expect(resolveAiBaseUrl(settings)).toBe(LEGACY_URL);
        expect(resolveAiModel(settings)).toBe(LEGACY_MODEL);
    });

    it('与已存 partial map 合并，新形状里的值优先', () => {
        installStorage(legacyShape({
            apiKeys: { glm: 'sk-synthetic-glm-0002' },
            apiModels: { kimi: 'synthetic-model-kimi' },
            apiBaseUrls: { glm: 'https://glm-relay.example.invalid/v4' },
        }));
        const settings = readAiSettings();

        expect(settings.provider).toBe('custom');
        expect(settings.apiKeys).toEqual({ custom: LEGACY_KEY, glm: 'sk-synthetic-glm-0002' });
        expect(settings.apiModels).toEqual({ custom: LEGACY_MODEL, deepseek: LEGACY_MODEL, kimi: 'synthetic-model-kimi' });
        expect(settings.apiBaseUrls).toEqual({ glm: 'https://glm-relay.example.invalid/v4' });
    });

    it('已存的 custom 地址与 Key 优先于旧字段', () => {
        installStorage(legacyShape({
            apiKeys: { custom: 'sk-synthetic-compat-newer-0003' },
            customApiUrl: 'https://newer-relay.example.invalid/v1',
        }));
        const settings = readAiSettings();

        expect(settings.customApiUrl).toBe('https://newer-relay.example.invalid/v1');
        expect(settings.apiKeys.custom).toBe('sk-synthetic-compat-newer-0003');
    });

    it('保留明确的空值与 stream:false', () => {
        installStorage({
            provider: 'custom',
            customApiUrl: '',
            apiKeys: { custom: '' },
            apiModels: { custom: '' },
            apiTemperature: '',
            apiStream: false,
        });
        const settings = readAiSettings();

        expect(Object.prototype.hasOwnProperty.call(settings.apiKeys, 'custom')).toBe(true);
        expect(settings.apiKeys.custom).toBe('');
        expect(settings.apiModels.custom).toBe('');
        expect(settings.apiTemperature).toBe('');
        expect(settings.apiStream).toBe(false);
    });

    it('重复迁移幂等，写回后也不再长出 openai 副本', () => {
        const bag = installStorage(legacyShape());
        const first = readAiSettings();
        const written = writeAiSettings(first);
        const second = readAiSettings();

        expect(written).toEqual(first);
        expect(second).toEqual(first);
        expect(second.provider).toBe('custom');
        expect(Object.keys(JSON.parse(bag.raw() ?? '{}').apiKeys)).toEqual(['custom']);
    });

    it('请求快照指向旧 custom 站点，不是官方 openai', () => {
        installStorage(legacyShape());
        const settings = readAiSettings();

        expect(buildAiEnv(settings)).toEqual({
            AI_PROVIDER: 'openai',
            GEMINI_API_KEY: undefined,
            GEMINI_API_URL: undefined,
            OPENAI_API_URL: 'https://compat-relay.example.invalid/v1/chat/completions',
            OPENAI_API_KEY: LEGACY_KEY,
            OPENAI_API_MODEL: LEGACY_MODEL,
            OPENAI_API_TEMPERATURE: '0.3',
        });
        expect(new URL(resolveAiChatCompletionsUrl(settings)).host).toBe('compat-relay.example.invalid');
    });

    it('读设置不写盘', () => {
        const bag = installStorage(legacyShape());
        const before = bag.raw();
        readAiSettings();
        readAiSettings();

        expect(bag.writes()).toBe(0);
        expect(bag.raw()).toBe(before);
    });

    // 已升级的安装可能同时留着旧 openai* 字段与官方 openai 条目；本例使用不同的官方 Key，保留该选择。
    // 与旧兼容 Key 相同的未确认副本会暂停使用，完整写回/确认回归见 aiSettingsPersistedMigration.test.ts。
    it('新形状明确写过官方 openai 时保留该选择', () => {
        installStorage(legacyShape({ apiKeys: { openai: 'sk-synthetic-official-0004' } }));
        const settings = readAiSettings();

        expect(settings.provider).toBe('openai');
        expect(settings.apiKeys).toEqual({ custom: LEGACY_KEY, openai: 'sk-synthetic-official-0004' });
        expect(new URL(resolveAiChatCompletionsUrl(settings)).host).toBe('api.openai.com');
    });
});
