// src/services/aiThemeClient.ts
// 设备本地直连 AI 服务生成主题：安卓上请求经原生 OkHttp 桥转发（绕开 CORS），
// 其他平台用普通 fetch。提示词与 utils/aiThemePrompts 共用同一份。
//
// 为什么要有它：`generateThemeFromLyrics` 原本只有两条路 —— Electron 主进程、以及
// 部署自带的 /api/generate-theme 端点。安卓两条都没有，于是「AI 主题」在 App 里
// 永远是灰的。这里补第三条：用户自己填 Key，请求直接从设备发出去。

import type { DualTheme } from '../types';
import { sanitizeDualTheme } from './themeSanitizer';
import { applyStoredAnimationIntensityToDualTheme } from './themePreferences';
import { parseAiThemeJsonInput, THEME_GENERATION_PROMPT_PREFIX, buildThemeSourcePrompt } from '../utils/aiThemePrompts';
import { createAiFetch } from './aiNativeFetch';
import {
    aiProtocolOf,
    isAiConfigured,
    readAiSettings,
    resolveAiApiKey,
    resolveAiChatCompletionsUrl,
    resolveAiModel,
    resolveAnthropicMessagesUrl,
    resolveGeminiGenerateContentUrl,
} from './aiSettings';
import { GEMINI_DEFAULT_MODEL } from '../../shared/geminiEndpoint.mjs';
import {
    recordAiThemeAttempt,
    type AiThemeStage,
    type AiThemeTrigger,
} from '../utils/aiThemeDiagnostics';
import { detectOpenAICompatibleProvider, sendOpenAICompatibleRequest } from '../../shared/openAICompatibleRequest.mjs';

/*
 * 端点由设置决定（见 services/aiSettings.ts 的 resolveGeminiGenerateContentUrl）：
 * 官方域名连不上时，填一个反代地址就能救回来。模型名是宿主定的，跟着默认那份走。
 */
export const GEMINI_THEME_MODEL = GEMINI_DEFAULT_MODEL;

const DEFAULT_OPENAI_TEMPERATURE = 0.7;
// 一份双主题 JSON 大约 1–2K token，但推理型模型会先把预算花在推理上（现场报告里 4096 的输出全部
// 落在 stage=parse「Invalid AI theme JSON format」，与截断的表现一致）。放宽到 8192——DeepSeek
// 与 OpenAI 均支持，若端点拒绝会在 400 里明确报出来，不会静默降级。
const THEME_MAX_OUTPUT_TOKENS = 8192;

/*
 * The URL and model for an OpenAI-compatible provider are resolved in one
 * place (services/aiSettings.ts) so DeepSeek — which needs nothing but a key —
 * and a hand-filled endpoint behave the same everywhere.
 */
export { normalizeChatCompletionsUrl } from '../../shared/openAICompatibleRequest.mjs';

const resolveTemperature = (value: string): number => {
    const temperature = Number.parseFloat(String(value ?? '').trim());
    return Number.isFinite(temperature) && temperature >= 0 && temperature <= 2
        ? temperature
        : DEFAULT_OPENAI_TEMPERATURE;
};

/**
 * 一次模型调用的原文与形态。
 *
 * 解析失败时最难判断的是「被 max_tokens 截断」还是「模型没按要求输出」——`finishReason` 与长度
 * 一起记进错误，下一次报告就能直接看出来（`finish=length` 就是截断）。
 */
type AiThemeRawResponse = {
    text: string;
    finishReason: string;
    status: number;
    textLength: number;
    /**
     * 已经结构化的答案。只有免费渠道（foliawork）会填：那边交过来的就是
     * `{ theme, decision? }`，不必再拿文本去 parse 一遍。
     */
    theme?: unknown;
};

const readErrorDetail = async (response: Response): Promise<string> => {
    const rawText = await response.text().catch(() => '');
    try {
        const parsed = JSON.parse(rawText);
        const error = parsed?.error;
        if (typeof error === 'string') return error;
        if (typeof error?.message === 'string') return error.message;
        if (typeof parsed?.message === 'string') return parsed.message;
    } catch {
        // 非 JSON 响应原样返回。
    }
    return rawText.trim();
};

/**
 * 从 OpenAI 兼容响应里取模型文本。
 *
 * 除了标准的 `message.content`，还要认两种常见的「有响应但 content 为空」：
 *  - 推理型模型 / 部分网关把答案放在 `reasoning_content`（或 `reasoning`）里，content 可能整个为空；
 *  - 老式 completions 形状直接用 `choices[0].text`。
 * 少了这两条，用户看到的就只是「Model returned an empty response」，无从判断是端点、模型还是解析问题。
 */
export const extractOpenAiText = (message: unknown, choice?: unknown): string => {
    const messageRecord = (message ?? {}) as { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
    if (typeof messageRecord.content === 'string' && messageRecord.content.trim()) return messageRecord.content;
    if (Array.isArray(messageRecord.content)) {
        const fromParts = messageRecord.content
            .filter((part) => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
            .map((part) => String((part as { text?: unknown }).text ?? ''))
            .join('');
        if (fromParts.trim()) return fromParts;
    }
    for (const key of ['reasoning_content', 'reasoning'] as const) {
        const value = messageRecord[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    const legacyText = (choice as { text?: unknown } | undefined)?.text;
    return typeof legacyText === 'string' ? legacyText : '';
};

/** 空响应最难查：把响应形态写进错误里（只报字段名与 finish_reason，不含任何密钥或正文）。 */
const describeEmptyResponse = (scope: string, response: Response, choice: unknown): string => {
    const choiceRecord = (choice ?? {}) as { finish_reason?: unknown; message?: unknown };
    const messageKeys = choiceRecord.message && typeof choiceRecord.message === 'object'
        ? Object.keys(choiceRecord.message as Record<string, unknown>).join('|')
        : 'none';
    const finish = typeof choiceRecord.finish_reason === 'string' ? choiceRecord.finish_reason : 'none';
    return `Model returned an empty response (${scope}, status ${response.status}, finish=${finish}, message keys: ${messageKeys})`;
};

const anthropicHeaders = (apiKey: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    // 2023-06-01 stays: the later version only removes fields this app never sends.
    'anthropic-version': '2023-06-01',
});

/** Anthropic 的回答是 content 数组里的 text 块；没有就用空串，由调用方报「空响应」。 */
const extractAnthropicText = (data: unknown): string => {
    const blocks = (data as { content?: unknown })?.content;
    return Array.isArray(blocks)
        ? blocks
            .map((block) => (block as { type?: unknown; text?: unknown }))
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('')
        : '';
};

const anthropicThemeRaw = (response: Response, data: unknown): AiThemeRawResponse => {
    const text = extractAnthropicText(data);
    if (!text.trim()) {
        const keys = data && typeof data === 'object' ? Object.keys(data).join('|') : 'none';
        throw new Error(`Model returned an empty response (anthropic, status ${response.status}, keys: ${keys})`);
    }
    const finishReason = typeof (data as { stop_reason?: unknown })?.stop_reason === 'string'
        ? String((data as { stop_reason: string }).stop_reason)
        : 'none';
    return { text, finishReason, status: response.status, textLength: text.length };
};

const requestAnthropicThemeJson = async (systemPrompt: string, sourcePrompt: string): Promise<AiThemeRawResponse> => {
    const settings = readAiSettings();
    const apiKey = resolveAiApiKey(settings);
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

    const response = await createAiFetch()(resolveAnthropicMessagesUrl(settings), {
        method: 'POST',
        headers: anthropicHeaders(apiKey),
        body: JSON.stringify({
            model: resolveAiModel(settings),
            // max_tokens 把推理也算进去，放宽到与 OpenAI 兼容那路同一个量级。
            max_tokens: THEME_MAX_OUTPUT_TOKENS,
            ...(systemPrompt ? { system: systemPrompt } : {}),
            messages: [{ role: 'user', content: sourcePrompt }],
        }),
    });

    if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(`Anthropic API error (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const data = await response.json();
    return anthropicThemeRaw(response, data);
};

const requestGeminiThemeJson = async (systemPrompt: string, sourcePrompt: string): Promise<AiThemeRawResponse> => {
    const settings = readAiSettings();
    const apiKey = settings.geminiApiKey.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

    const response = await createAiFetch()(resolveGeminiGenerateContentUrl(settings), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: sourcePrompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
        }),
    });

    if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(`Gemini API error (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
        ? parts.find((part: unknown) => part && typeof (part as { text?: unknown }).text === 'string')
        : null;
    const jsonText = text ? String((text as { text: string }).text) : '';
    if (!jsonText) {
        const keys = data && typeof data === 'object' ? Object.keys(data).join('|') : 'none';
        throw new Error(`Model returned an empty response (gemini, status ${response.status}, keys: ${keys})`);
    }
    return { text: jsonText, finishReason: 'n/a', status: response.status, textLength: jsonText.length };
};

const requestOpenAiThemeJson = async (systemPrompt: string, sourcePrompt: string): Promise<AiThemeRawResponse> => {
    const settings = readAiSettings();
    const apiKey = resolveAiApiKey(settings);
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

    const apiUrl = resolveAiChatCompletionsUrl(settings);
    const model = resolveAiModel(settings);
    const provider = detectOpenAICompatibleProvider(apiUrl);

    const response = await sendOpenAICompatibleRequest({
        apiUrl,
        provider,
        body: {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: sourcePrompt },
            ],
            temperature: resolveTemperature(settings.apiTemperature),
            max_tokens: THEME_MAX_OUTPUT_TOKENS,
            // 只有 OpenAI 自己接受 json_schema，其余兼容端点统一要普通 JSON 模式。
            response_format: { type: 'json_object' },
        },
        init: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
        },
        fetchImpl: createAiFetch(),
    });

    if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new Error(`OpenAI compatible API error (${response.status})${detail ? `: ${detail}` : ''}`);
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const text = extractOpenAiText(choice?.message, choice);
    if (!text.trim()) throw new Error(describeEmptyResponse('openai-compatible', response, choice));
    return {
        text,
        finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'none',
        status: response.status,
        textLength: text.length,
    };
};

/**
};

/**
 * 用用户自己配置的服务商生成主题。
 * 抛出的错误消息与桌面版一致，`isMissingAiApiKeyError` 才能识别「还没填 Key」。
 */
export const generateThemeWithConfiguredAi = async (
    lyricsText: string,
    options?: { isPureMusic?: boolean; songTitle?: string; trigger?: AiThemeTrigger },
): Promise<DualTheme> => {
    const settings = readAiSettings();
    const snippet = String(lyricsText || '').slice(0, 2000);
    const sourcePrompt = buildThemeSourcePrompt(snippet, options?.isPureMusic === true, options?.songTitle);
    const provider = settings.provider;
    const protocol = aiProtocolOf(provider);
    const model = protocol === 'gemini' ? GEMINI_THEME_MODEL : resolveAiModel(settings);
    const trigger: AiThemeTrigger = options?.trigger ?? 'unknown';
    const startedAt = Date.now();
    let stage: AiThemeStage = 'request';

    try {
        const raw = protocol === 'gemini'
                ? await requestGeminiThemeJson(THEME_GENERATION_PROMPT_PREFIX, sourcePrompt)
                : protocol === 'anthropic'
                    ? await requestAnthropicThemeJson(THEME_GENERATION_PROMPT_PREFIX, sourcePrompt)
                    : await requestOpenAiThemeJson(THEME_GENERATION_PROMPT_PREFIX, sourcePrompt);

        stage = 'parse';
        let parsed: unknown;
        try {
            // 免费渠道已经给过结构化主题；其余三家要给的是「模型吐出来的那段文本」。
            parsed = raw.theme ?? parseAiThemeJsonInput(raw.text);
        } catch (error) {
            // 把响应形态带进错误：finish=length 说明是被输出上限截断（推理模型很常见），
            // 否则就是模型没按双主题 JSON 的格式回答。
            throw new Error(
                `${summarizeError(error)} [finish=${raw.finishReason}, chars=${raw.textLength}, status=${raw.status}]`,
            );
        }
        stage = 'sanitize';
        const theme = sanitizeDualTheme(parsed as DualTheme);
        const result = applyStoredAnimationIntensityToDualTheme(theme);
        recordAiThemeAttempt({
            provider,
            model,
            trigger,
            stage: 'request',
            ok: true,
            durationMs: Date.now() - startedAt,
        });
        return result;
    } catch (error) {
        const message = summarizeError(error);
        const status = /\((\d{3})\)/.exec(message)?.[1];
        recordAiThemeAttempt({
            provider,
            model,
            trigger,
            stage,
            ok: false,
            status: status ? Number(status) : undefined,
            error: message,
            durationMs: Date.now() - startedAt,
        });
        throw error;
    }
};

export interface AiConnectionTestResult {
    ok: boolean;
    durationMs: number;
    status?: number;
    model?: string;
    reply?: string;
    error?: string;
}

const summarizeError = (error: unknown): string => (
    error instanceof Error ? error.message : String(error ?? '')
);

/**
 * 本机已经可以走「设备本地生成」这条路吗。
 *
 * 免费渠道自带凭据，选中它就算可用 —— 否则设置页会把「已经能用了」显示成「还没配置」，
 * 用户就会去别处找一个 Key，而免费那档本来就是给不想找 Key 的人准备的。
 */
export const isLocalAiThemeAvailable = (): boolean => isAiConfigured();

/**
 * 「测试连接」：发一句 hello，回显模型回复或失败原因。
 * 读的是已保存的设置——表单是即改即存的，所以等价于测试当前填的内容。
 */
export const testConfiguredAiConnection = async (): Promise<AiConnectionTestResult> => {
    const startedAt = Date.now();
    const settings = readAiSettings();

    const protocol = aiProtocolOf(settings.provider);
    try {

        if (protocol === 'anthropic') {
            const apiKey = resolveAiApiKey(settings);
            if (!apiKey) {
                return { ok: false, durationMs: 0, error: 'ANTHROPIC_API_KEY is not configured' };
            }
            const model = resolveAiModel(settings);
            const response = await createAiFetch()(resolveAnthropicMessagesUrl(settings), {
                method: 'POST',
                headers: anthropicHeaders(apiKey),
                body: JSON.stringify({
                    model,
                    max_tokens: 256,
                    messages: [{ role: 'user', content: 'hello' }],
                }),
            });
            const durationMs = Date.now() - startedAt;
            if (!response.ok) {
                const detail = await readErrorDetail(response);
                return { ok: false, durationMs, status: response.status, model, error: detail || `HTTP ${response.status}` };
            }
            const data = await response.json();
            return {
                ok: true,
                durationMs,
                status: response.status,
                model,
                reply: extractAnthropicText(data).trim().slice(0, 200),
            };
        }

        if (protocol === 'openai') {
            const apiKey = resolveAiApiKey(settings);
            if (!apiKey) {
                return { ok: false, durationMs: 0, error: 'OPENAI_API_KEY is not configured' };
            }
            const apiUrl = resolveAiChatCompletionsUrl(settings);
            const model = resolveAiModel(settings);
            const response = await sendOpenAICompatibleRequest({
                apiUrl,
                provider: detectOpenAICompatibleProvider(apiUrl),
                body: {
                    model,
                    messages: [{ role: 'user', content: 'hello' }],
                    max_tokens: 256,
                },
                init: {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                    },
                },
                fetchImpl: createAiFetch(),
            });
            const durationMs = Date.now() - startedAt;
            if (!response.ok) {
                const detail = await readErrorDetail(response);
                return {
                    ok: false,
                    durationMs,
                    status: response.status,
                    model,
                    error: detail || `HTTP ${response.status}`,
                };
            }
            const data = await response.json();
            const choice = data?.choices?.[0];
            return {
                ok: true,
                durationMs,
                status: response.status,
                model,
                reply: extractOpenAiText(choice?.message, choice).trim().slice(0, 200),
            };
        }

        const apiKey = settings.geminiApiKey.trim();
        if (!apiKey) {
            return { ok: false, durationMs: 0, error: 'GEMINI_API_KEY is not configured' };
        }
        const response = await createAiFetch()(resolveGeminiGenerateContentUrl(settings), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'hello' }] }] }),
        });
        const durationMs = Date.now() - startedAt;
        if (!response.ok) {
            const detail = await readErrorDetail(response);
            return {
                ok: false,
                durationMs,
                status: response.status,
                model: GEMINI_THEME_MODEL,
                error: detail || `HTTP ${response.status}`,
            };
        }
        const data = await response.json();
        const parts = data?.candidates?.[0]?.content?.parts;
        const reply = Array.isArray(parts)
            ? parts
                .filter((part: unknown) => part && typeof (part as { text?: unknown }).text === 'string')
                .map((part: { text: string }) => part.text)
                .join('')
            : '';
        return {
            ok: true,
            durationMs,
            status: response.status,
            model: GEMINI_THEME_MODEL,
            reply: reply.trim().slice(0, 200),
        };
    } catch (error) {
        return { ok: false, durationMs: Date.now() - startedAt, error: summarizeError(error) };
    }
};
