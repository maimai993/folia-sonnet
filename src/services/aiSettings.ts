// src/services/aiSettings.ts
// 移动端（Capacitor）没有 Electron 主进程，AI 凭据只能存在渲染层。
// 桌面版走的是主进程 store；这里用 localStorage 提供同一组字段，
// 让共享的请求逻辑（shared/lyricSegmentationService.mjs 等）可以照常复用。
//
// 服务商清单与上游桌面版同一份（shared/ai/providerRegistry.mjs）：Gemini、DeepSeek、
// 小米 MiMo、阿里云 Qwen、腾讯云 TokenHub、OpenAI、Anthropic、Kimi、智谱 GLM，
// 以及自定义兼容接口。除 Gemini 与 Anthropic 外都是 OpenAI 兼容端点 ——
// 区别只是预设的地址与推荐模型，所以一份通用的「Key + 模型 + 站点」就能接下九家。

import { AI_PROVIDER_PRESETS as SHARED_AI_PROVIDER_PRESETS } from '../../shared/ai/providerRegistry.mjs';
import { normalizeChatCompletionsUrl, resolveOpenAICompatibleModel } from '../../shared/openAICompatibleRequest.mjs';
import {
    GEMINI_DEFAULT_MODEL,
    resolveGeminiGenerateContentUrl as resolveGeminiUrl,
} from '../../shared/geminiEndpoint.mjs';

export type AiProviderId =
    | 'gemini' | 'deepseek' | 'mimo' | 'qwen' | 'tencentcloud'
    | 'openai' | 'anthropic' | 'kimi' | 'glm' | 'custom';

/** 三种请求协议；除 Gemini 与 Anthropic 外都是 OpenAI 兼容。 */
export type AiProtocol = 'openai' | 'anthropic' | 'gemini';

export interface AiProviderEndpoint {
    id: string;
    baseUrl: string;
}

export interface AiProviderPreset {
    id: AiProviderId;
    label: string;
    protocol: AiProtocol;
    /** 默认站点的地址（custom 为空串）。 */
    baseUrl: string;
    endpoints: readonly AiProviderEndpoint[];
    /** 留空模型时用的那一个（Anthropic 也有：claude-haiku-5-5）。 */
    recommendedModel: string;
    temperature: { min: number; max: number } | null;
    stream: boolean;
}

const sharedPresetOf = (id: AiProviderId) => (
    SHARED_AI_PROVIDER_PRESETS.find((preset: { id: string }) => preset.id === id)
);

/** 设置里列出的服务商顺序与上游一致（按英文名排，custom 最后）。 */
export const AI_PROVIDER_IDS: readonly AiProviderId[] = Object.freeze(
    SHARED_AI_PROVIDER_PRESETS.map((preset: { id: string }) => preset.id as AiProviderId),
);

const asPreset = (id: AiProviderId, shared: unknown): AiProviderPreset => {
    const preset = shared as {
        label: string; protocol: AiProtocol; baseUrl: string;
        endpoints: AiProviderEndpoint[]; recommendedModel?: string;
        temperature: { min: number; max: number } | null; stream: boolean;
    };
    return {
        id,
        label: preset.label,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl ?? '',
        endpoints: Array.isArray(preset.endpoints) ? preset.endpoints : [],
        recommendedModel: preset.recommendedModel ?? '',
        temperature: preset.temperature ?? null,
        stream: preset.stream === true,
    };
};

/** 每家一份预设；顺序即设置下拉里的顺序。 */
export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = Object.freeze(
    SHARED_AI_PROVIDER_PRESETS.map((preset: { id: string }) => asPreset(preset.id as AiProviderId, preset)),
);

export const aiPresetOf = (id: AiProviderId): AiProviderPreset | null => (
    AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null
);

/** 这家说什么协议：OpenAI 兼容（多数）、Anthropic Messages、Gemini generateContent。 */
export const aiProtocolOf = (id: AiProviderId): AiProtocol => aiPresetOf(id)?.protocol ?? 'openai';

/** 这家是不是 OpenAI 兼容端点（决定能不能共用 chat/completions 那条路）。 */
export const isOpenAiCompatibleProvider = (id: AiProviderId): boolean => aiProtocolOf(id) === 'openai';

export interface AiSettings {
    provider: AiProviderId;
    geminiApiKey: string;
    /**
     * Gemini 的 API 请求地址，留空走默认（官方域名的反向代理）。
     *
     * 官方域名在不少网络里连不上，所以这个地址是可改的；模型不跟着变 ——
     * 设置里没有 Gemini 的模型字段，端点里的模型名由宿主决定（见 GEMINI_DEFAULT_MODEL）。
     */
    geminiApiUrl: string;
    /** 各家预设服务商的凭据，按服务商分开存（切过去再切回来，Key 还在）。 */
    apiKeys: Partial<Record<AiProviderId, string>>;
    /** 每家改过的模型，留空用推荐模型（按服务商分开存）。 */
    apiModels: Partial<Record<AiProviderId, string>>;
    /** 每家选过的站点地址（多站点服务商），空 = 预设默认站点。 */
    apiBaseUrls: Partial<Record<AiProviderId, string>>;
    /** 自定义兼容接口的地址（provider = custom 时是唯一真源）。 */
    customApiUrl: string;
    /** OpenAI 兼容端点的采样温度（Anthropic 不收，Gemini 用自己的默认）。 */
    apiTemperature: string;
    /** OpenAI 兼容端点要不要流式。 */
    apiStream: boolean;
}

const STORAGE_KEY = 'foliaAiProviderSettings';
export const AI_SETTINGS_CHANGED_EVENT = 'folia-ai-settings-changed';

export const DEFAULT_AI_SETTINGS: AiSettings = {
    provider: 'gemini',
    geminiApiKey: '',
    // 留空 = 用默认地址。写成常量反而会让「用户清空输入框」和「用默认」变成两回事。
    geminiApiUrl: '',
    apiKeys: {},
    apiModels: {},
    apiBaseUrls: {},
    customApiUrl: '',
    apiTemperature: '0.7',
    apiStream: false,
};

const normalizeProvider = (value: unknown): AiProviderId => (
    AI_PROVIDER_IDS.includes(value as AiProviderId) ? value as AiProviderId : 'gemini'
);

const owns = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

// 仅显式保存时写入；区分本次修复前的自动复制与用户在修复后主动填写的官方 Key。
const CREDENTIAL_ROUTING_VERSION = 1;

const asText = (value: unknown, fallback = ''): string => (
    typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
);

/** 只认明确的字符串，空串也留着：清空输入框和「没设置过」是两件事；trim 交给用它的地方。 */
const asRecord = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        // 明确清空不能被旧字段补回；trim 留给请求 resolver。
        if (typeof entry === 'string') result[key] = entry;
    }
    return result;
};

/*
 * 旧版（只有 Gemini / DeepSeek / 其他兼容接口三家）的存储形状：
 * provider + deepseekApiKey + openaiApiKey + openaiApiUrl + openaiApiModel + 温度 + 流式。
 * 读到旧形状就把它们搬进新字段：DeepSeek 的 Key 与模型归 DeepSeek，
 * 「其他兼容接口」的地址与 Key 只归 custom，不能复制到官方 openai；旧共享模型仍供 DeepSeek 使用。
 * 这里只计算内存里的设置，不在读取时改写磁盘。
 */
const migrateLegacy = (record: Record<string, unknown>): Partial<AiSettings> => {
    const apiKeys: Partial<Record<AiProviderId, string>> = {};
    if (owns(record, 'deepseekApiKey')) apiKeys.deepseek = typeof record.deepseekApiKey === 'string' ? record.deepseekApiKey : '';
    if (owns(record, 'openaiApiKey')) apiKeys.custom = typeof record.openaiApiKey === 'string' ? record.openaiApiKey : '';
    const apiModels: Partial<Record<AiProviderId, string>> = {};
    if (owns(record, 'openaiApiModel')) {
        apiModels.custom = asText(record.openaiApiModel);
        apiModels.deepseek = asText(record.openaiApiModel);
    }
    return { apiKeys, apiModels };
};

/** 旧形状的 openai* 三项在旧版指的是「其他兼容接口」，不是官方 openai。 */
const hasLegacyCompatibleFields = (record: Record<string, unknown>): boolean => (
    owns(record, 'openaiApiUrl') || owns(record, 'openaiApiKey') || owns(record, 'openaiApiModel')
);

/** 新形状的官方字段只用于保留 provider（含明确空值），不证明 Key 已获确认；疑似副本另行阻断。 */
const hasOfficialFields = (record: Record<string, unknown>): boolean => (
    owns(asRecord(record.apiKeys), 'openai')
    || owns(asRecord(record.apiModels), 'openai')
    || owns(asRecord(record.apiBaseUrls), 'openai')
);

/** 未带确认标记的历史官方副本先停用，不能把凭据跨服务商边界发出；等用户重填确认。 */
const hasUnconfirmedOfficialCopy = (record: Record<string, unknown>, apiKeys: AiSettings['apiKeys']): boolean => {
    if (record.credentialRoutingVersion === CREDENTIAL_ROUTING_VERSION) return false;
    const officialKey = apiKeys.openai?.trim();
    if (!officialKey) return false;
    // 旧版本曾把兼容接口 Key 同时写进 openai/custom；custom 可能已被用户清空，
    // 因而不能只比较两个值，必须把 custom 字段本身视为未确认来源的证据。
    if (owns(asRecord(record.apiKeys), 'custom')) return true;
    return typeof record.openaiApiKey === 'string' && officialKey === record.openaiApiKey.trim();
};

export const readAiSettings = (): AiSettings => {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_AI_SETTINGS, apiKeys: {}, apiModels: {}, apiBaseUrls: {} };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_AI_SETTINGS, apiKeys: {}, apiModels: {}, apiBaseUrls: {} };
        const parsed = JSON.parse(raw) as Partial<AiSettings> | null;
        if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_AI_SETTINGS, apiKeys: {}, apiModels: {}, apiBaseUrls: {} };
        const record = parsed as Record<string, unknown>;
        const legacy = migrateLegacy(record);
        const apiKeys = { ...legacy.apiKeys, ...asRecord(record.apiKeys) };
        if (hasUnconfirmedOfficialCopy(record, apiKeys)) apiKeys.openai = '';
        const provider = normalizeProvider(record.provider);
        return {
            provider: provider === 'openai' && hasLegacyCompatibleFields(record) && !hasOfficialFields(record)
                ? 'custom'
                : provider,
            geminiApiKey: asText(record.geminiApiKey),
            geminiApiUrl: asText(record.geminiApiUrl),
            apiKeys,
            apiModels: { ...legacy.apiModels, ...asRecord(record.apiModels) },
            apiBaseUrls: asRecord(record.apiBaseUrls),
            customApiUrl: asText(owns(record, 'customApiUrl') ? record.customApiUrl : record.openaiApiUrl),
            apiTemperature: asText(owns(record, 'apiTemperature') ? record.apiTemperature : record.openaiApiTemperature, DEFAULT_AI_SETTINGS.apiTemperature),
            apiStream: (owns(record, 'apiStream') ? record.apiStream : record.openaiApiStream) === true,
        };
    } catch {
        return { ...DEFAULT_AI_SETTINGS, apiKeys: {}, apiModels: {}, apiBaseUrls: {} };
    }
};

export const writeAiSettings = (patch: Partial<AiSettings>): AiSettings => {
    const next: AiSettings = { ...readAiSettings(), ...patch };
    if (typeof localStorage !== 'undefined') {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, credentialRoutingVersion: CREDENTIAL_ROUTING_VERSION }));
        } catch {
            // Quota or private mode: keep the in-memory value for this session.
        }
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(AI_SETTINGS_CHANGED_EVENT, { detail: next }));
    }
    return next;
};

/** 选中这家实际要用的地址：custom 用手填的，其余用选过的站点或预设默认站点。 */
export const resolveAiBaseUrl = (settings: AiSettings): string => (
    settings.provider === 'custom'
        ? settings.customApiUrl.trim()
        : settings.apiBaseUrls[settings.provider]?.trim() || aiPresetOf(settings.provider)?.baseUrl || ''
);

/** 当前 provider 对应的密钥（Gemini 单独存，其余按服务商各存一份）。 */
export const resolveAiApiKey = (settings: AiSettings): string => (
    settings.provider === 'gemini'
        ? settings.geminiApiKey.trim()
        : settings.apiKeys[settings.provider]?.trim() ?? ''
);

/**
 * Anthropic 的 Messages 端点：与桌面主进程同一套拼法（electron/ai/anthropicClient.cjs）——
 * 去掉尾部已写的资源段，空路径补 /v1，再接 /messages。
 */
export const normalizeAnthropicMessagesUrl = (rawUrl: string): string => {
    try {
        const url = new URL(rawUrl || 'https://api.anthropic.com/v1');
        const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:messages|chat\/completions|models)$/, '');
        url.pathname = `${path || '/v1'}/messages`;
        return url.toString();
    } catch {
        return 'https://api.anthropic.com/v1/messages';
    }
};

/** Anthropic 这家实际要打的 messages 端点。 */
export const resolveAnthropicMessagesUrl = (settings: AiSettings): string => (
    normalizeAnthropicMessagesUrl(resolveAiBaseUrl(settings))
);

/** 实际要打的那个 chat/completions 地址（只有 OpenAI 兼容端点用它）。 */
export const resolveAiChatCompletionsUrl = (settings: AiSettings): string => {
    const baseUrl = resolveAiBaseUrl(settings);
    // 旧配置迁入 custom 后，空地址不能再触发共享 helper 的官方默认站点，否则仍会误发旧 Key。
    if (settings.provider === 'custom' && !baseUrl) throw new Error('CUSTOM_API_URL is not configured');
    return normalizeChatCompletionsUrl(baseUrl);
};

/** 实际要用的模型：留空用服务商的推荐模型。 */
export const resolveAiModel = (settings: AiSettings): string => {
    const configured = settings.apiModels[settings.provider]?.trim() ?? '';
    if (configured) return configured;
    const preset = aiPresetOf(settings.provider);
    if (preset?.recommendedModel) return preset.recommendedModel;
    if (settings.provider === 'custom' && !resolveAiBaseUrl(settings)) return '';
    const apiUrl = resolveAiChatCompletionsUrl(settings);
    return resolveOpenAICompatibleModel(apiUrl, '');
};

/** 实际要打的那条 generateContent 端点（Gemini 专用）。 */
export const resolveGeminiGenerateContentUrl = (settings: AiSettings): string => (
    resolveGeminiUrl(settings.geminiApiUrl, GEMINI_DEFAULT_MODEL)
);

/** 当前配置能不能真的发请求：选中的 provider 必须有对应凭据（custom 还要有地址）。 */
export const isAiConfigured = (settings: AiSettings = readAiSettings()): boolean => {
    if (!resolveAiApiKey(settings)) return false;
    return settings.provider !== 'custom' || Boolean(settings.customApiUrl.trim());
};

/** 共享的歌词分词服务读的是 env 形状，这里把表单字段映射过去。 */
export const buildAiEnv = (settings: AiSettings = readAiSettings()): Record<string, string | undefined> => {
    // The shared transports only know "gemini" and "openai"; the OpenAI-compatible
    // presets (and a hand-filled endpoint) are all the latter, announced as openai.
    // Anthropic speaks its own protocol, which the shared segmentation service
    // cannot speak, so it is announced as unconfigured there.
    const openaiCompatible = isOpenAiCompatibleProvider(settings.provider);
    return {
        AI_PROVIDER: settings.provider === 'gemini' ? 'gemini' : openaiCompatible ? 'openai' : undefined,
        GEMINI_API_KEY: settings.geminiApiKey.trim() || undefined,
        /*
         * 共享的分词服务（shared/lyricSegmentationService.mjs）读的是 env：它不在渲染层，
         * 拿不到 localStorage。留空它也走默认地址，与这条设置「留空 = 默认」的语义一致。
         */
        GEMINI_API_URL: settings.geminiApiUrl.trim() || undefined,
        OPENAI_API_URL: openaiCompatible ? resolveAiChatCompletionsUrl(settings) : undefined,
        OPENAI_API_KEY: openaiCompatible ? (resolveAiApiKey(settings) || undefined) : undefined,
        OPENAI_API_MODEL: openaiCompatible ? resolveAiModel(settings) : undefined,
        OPENAI_API_TEMPERATURE: openaiCompatible ? settings.apiTemperature : undefined,
    };
};
