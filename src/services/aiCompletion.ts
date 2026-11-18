import { createAiFetch } from './aiNativeFetch';
import { requestAiCompletionViaNative } from './aiNativeCompletion';
import { assertOnlineInferenceAllowed } from './aiMemoryGate';
import {
    aiProtocolOf,
    isAiConfigured,
    readAiSettings,
    resolveAiApiKey,
    resolveAiChatCompletionsUrl,
    resolveAiModel,
    resolveAnthropicMessagesUrl,
    resolveGeminiGenerateContentUrl,
    type AiProviderId,
} from './aiSettings';
import {
    detectOpenAICompatibleProvider,
    sendOpenAICompatibleRequest,
} from '../../shared/openAICompatibleRequest.mjs';

// src/services/aiCompletion.ts
// One prompt through the AI connection the user configured in Settings → AI.
//
// This is the shared half: `folium.ai` (mods) and the built-in AI lyric
// animation director both call it, so a feature never has to hold a credential
// of its own. The request leaves from whichever window runs the caller through
// createAiFetch, which is also what lets an Android build reach an endpoint at
// all — it has no Node main process, and a plain fetch from its WebView is
// stopped by CORS.
//
// The credential is read per request, handed straight to the transport, and
// stays out of every result, error and log line: provider bodies are redacted
// before they are put in a message, because a gateway that echoes the
// Authorization header back must not be able to push a key into a toast.

export interface AiCompletionTarget {
    provider: AiProviderId;
    model: string;
}

/**
 * 一张要交给模型的图。
 *
 * 只支持 base64 data URL（data:image/jpeg;base64,...）—— 三家供应商都接受内联图片，
 * 而外部 URL 会被部分兼容端点拒绝（它们不替我们下载）。调用方自己压好再传，别把原图塞进来。
 */
export interface AiImageInput {
    /** data:image/<fmt>;base64,<data> */
    dataUrl: string;
    /** 这张图是干什么的（「封面」「第 30 秒的画面」），写进提示词让模型知道该看什么。 */
    label: string;
}

export interface AiCompletionRequest {
    system: string;
    prompt: string;
    /**
     * 随提问一起交出去的图（多模态）。
     *
     * 没给就是纯文本，行为与以前完全一致。给了之后：OpenAI 兼容走 image_url，
     * Anthropic 走 image block，Gemini 走 inlineData。
     */
    images?: readonly AiImageInput[];
    /** Best effort: the provider may cap it lower. */
    maxTokens?: number;
    temperature?: number;
    /** Ask for a JSON answer. On by default, since most callers parse one. */
    json?: boolean;
    signal?: AbortSignal;
}

export interface AiCompletionResult {
    text: string;
    target: AiCompletionTarget;
}

// The Gemini model is a host decision — its settings expose no model field for
// that provider — so it is pinned here rather than left to each caller.
// The address is not: it comes from Settings → AI, so a network that cannot reach
// the official host can point at a reverse proxy instead.
const GEMINI_MODEL = 'gemini-3-flash-preview';
const DEFAULT_TEMPERATURE = 0.7;

/**
 * 「这台机器现在没有可以用的 AI 连接」。
 *
 * 它跟 Key 过期、接口报错不是一类：那两件是**这一次调用出了问题**，换个时间重试
 * 有可能过；这一件是**请求根本发不出去**，重来多少次结果都一样。调用方必须能分辨
 * 它 —— 拿它当普通失败报出去，每切一首歌弹一遍「失败」，用户只会觉得功能坏了。
 *
 * 消息以它开头，后面可以跟给人看的原因（见 translateAiCompletionError）。
 */
export const AI_NOT_CONFIGURED = 'ai-not-configured';

export const isAiNotConfiguredError = (error: unknown): boolean => (
    String((error as Error)?.message ?? error ?? '').trim().startsWith(AI_NOT_CONFIGURED)
);

/** What the host would ask right now, and whether it has the credential to do it. */
export const readAiTarget = (): { target: AiCompletionTarget; configured: boolean } => {
    const settings = readAiSettings();
    const configured = isAiConfigured(settings);
    // DeepSeek rides the OpenAI transport with a fixed endpoint: the target
    // keeps its own id so the UI can say which provider answered.
    if (aiProtocolOf(settings.provider) !== 'gemini') {
        return {
            target: {
                provider: settings.provider,
                model: resolveAiModel(settings),
            },
            configured,
        };
    }
    return { target: { provider: 'gemini', model: GEMINI_MODEL }, configured };
};

/** `{ provider, model }` when configured, null when Settings → AI is still empty. */
export const describeAiTarget = (): AiCompletionTarget | null => {
    const { target, configured } = readAiTarget();
    return configured ? target : null;
};

export const isAiTargetConfigured = (): boolean => readAiTarget().configured;

/*
 * Errors are prefixed codes, so a caller can recognize the case and localize it
 * (see translateAiCompletionError). Provider detail rides along after the code,
 * stripped of anything that looks like a credential first.
 */
const redact = (text: string): string => String(text)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/([?&](?:key|api[_-]?key|token|access_token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi, '$1[redacted]');

const readErrorDetail = async (response: Response): Promise<string> => {
    const rawText = await response.text().catch(() => '');
    try {
        const parsed = JSON.parse(rawText) as { error?: unknown; message?: unknown } | null;
        const error = parsed?.error;
        if (typeof error === 'string') return error;
        if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
            return (error as { message: string }).message;
        }
        if (typeof parsed?.message === 'string') return parsed.message;
    } catch {
        // Not JSON: report the body as-is.
    }
    return rawText.trim();
};

const failWithResponse = async (response: Response): Promise<never> => {
    const detail = redact(await readErrorDetail(response)).slice(0, 300);
    throw new Error(`ai-http-error:${response.status}${detail ? ` ${detail}` : ''}`);
};

const describeUnexpected = (error: unknown): Error => {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (name === 'TimeoutError' || name === 'AbortError' || /abort/i.test(message)) {
        return new Error('ai-aborted');
    }
    return new Error(`ai-request-failed: ${redact(message).slice(0, 300)}`);
};

/** The model's answer out of an OpenAI-compatible response body.
 */
const extractOpenAiText = (payload: unknown): string => {
    const choice = (payload as { choices?: { message?: unknown }[] } | null)?.choices?.[0];
    const message = choice?.message as { content?: unknown; refusal?: unknown } | undefined;
    if (!message) return '';
    if (typeof message.refusal === 'string' && message.refusal.trim()) {
        throw new Error(`ai-refused: ${redact(message.refusal).slice(0, 300)}`);
    }
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
            .join('');
    }
    return '';
};

const runOpenAi = async (request: AiCompletionRequest, send: typeof fetch): Promise<string> => {
    const settings = readAiSettings();
    const apiKey = resolveAiApiKey(settings);
    if (!apiKey) throw new Error(AI_NOT_CONFIGURED);

    const apiUrl = resolveAiChatCompletionsUrl(settings);
    const model = resolveAiModel(settings);
    const requested = Number(request.temperature);
    const configured = Number.parseFloat(settings.apiTemperature);
    const temperature = Number.isFinite(requested)
        ? Math.min(2, Math.max(0, requested))
        : Number.isFinite(configured) ? configured : DEFAULT_TEMPERATURE;

    const response = await sendOpenAICompatibleRequest({
        apiUrl,
        provider: detectOpenAICompatibleProvider(apiUrl),
        body: {
            model,
            messages: [
                { role: 'system', content: request.system },
                { role: 'user', content: buildOpenAiUserContent(request) },
            ],
            temperature,
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
            // Only OpenAI itself takes json_schema; the long tail of compatible
            // endpoints rejects it outright, so everyone gets plain JSON mode.
            ...(request.json === false ? {} : { response_format: { type: 'json_object' } }),
        },
        init: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            signal: request.signal,
        },
        fetchImpl: send,
    });

    if (!response.ok) return failWithResponse(response);
    const payload = await response.json().catch(() => {
        throw new Error('ai-bad-response (not JSON)');
    });
    const text = extractOpenAiText(payload);
    if (!text.trim()) throw new Error('ai-empty-response');
    return text;
};


/** 把 data:image/jpeg;base64,xxx 拆成媒体类型与裸 base64；格式不对返回 null（这张图就跳过）。 */
const splitImageDataUrl = (dataUrl: string): { mediaType: string; data: string } | null => {
    const matched = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl);
    return matched ? { mediaType: matched[1].toLowerCase(), data: matched[2] } : null;
};
type OpenAiUserContent = string | Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
>;

/**
 * OpenAI 兼容端点的 user 内容。
 *
 * 没有图就**保持纯字符串**：一大批兼容端点（各家中转、本地推理服务）对数组形式的 content
 * 支持参差不齐，纯文本路径不能被这次改动拖下水。
 */
const buildOpenAiUserContent = (request: AiCompletionRequest): OpenAiUserContent => {
    if (!request.images || request.images.length === 0) return request.prompt;
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
        { type: 'text', text: request.prompt },
    ];
    for (const image of request.images) {
        if (!splitImageDataUrl(image.dataUrl)) continue;
        parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
    }
    return parts.length > 1 ? parts : request.prompt;
};
const runAnthropic = async (request: AiCompletionRequest, send: typeof fetch): Promise<string> => {
    const settings = readAiSettings();
    const apiKey = resolveAiApiKey(settings);
    if (!apiKey) throw new Error(AI_NOT_CONFIGURED);

    const response = await send(resolveAnthropicMessagesUrl(settings), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            // 2023-06-01 stays: the later version only removes fields this app never sends.
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: resolveAiModel(settings),
            max_tokens: request.maxTokens ?? 4096,
            ...(request.system ? { system: request.system } : {}),
            messages: [{ role: 'user', content: request.prompt }],
        }),
        signal: request.signal,
    });

    if (!response.ok) return failWithResponse(response);
    const payload = await response.json().catch(() => {
        throw new Error('ai-bad-response (not JSON)');
    });
    const blocks = (payload as { content?: unknown })?.content;
    const text = Array.isArray(blocks)
        ? blocks
            .map((block) => (block as { type?: unknown; text?: unknown }))
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join('')
        : '';
    if (!text.trim()) throw new Error('ai-empty-response');
    return text;
};

const runGemini = async (request: AiCompletionRequest, send: typeof fetch): Promise<string> => {
    const settings = readAiSettings();
    const apiKey = settings.geminiApiKey.trim();
    if (!apiKey) throw new Error(AI_NOT_CONFIGURED);

    const response = await send(resolveGeminiGenerateContentUrl(settings), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ parts: [{ text: request.prompt }] }],
            generationConfig: {
                ...(request.json === false ? {} : { responseMimeType: 'application/json' }),
                ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
            },
        }),
        signal: request.signal,
    });

    if (!response.ok) return failWithResponse(response);
    const data = await response.json().catch(() => {
        throw new Error('ai-bad-response (not JSON)');
    });
    const parts = (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null)
        ?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
        ? parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
        : '';
    if (!text.trim()) throw new Error('ai-empty-response');
    return text;
};

/**
 * 「这台机器现在没有可以用的 AI 连接」。
 *
 * 它跟 Key 过期、接口报错不是一类：那两件是**这一次调用出了问题**，换个时间重试
 * 有可能过；这一件是**请求根本发不出去**，重来多少次结果都一样。调用方必须能分辨
 * 它 —— 拿它当普通失败报给用户，每切一首歌弹一遍「失败」，用户只会觉得功能坏了。
 *
 * 消息以它开头，后面的细节是给人看的原因（见 translateAiCompletionError）。
 */
export const requestAiCompletion = async (request: AiCompletionRequest): Promise<AiCompletionResult> => {
    if (!request || typeof request.system !== 'string' || typeof request.prompt !== 'string') {
        throw new Error('ai-complete requires { system: string, prompt: string }');
    }
    const { target, configured } = readAiTarget();
    if (!configured) throw new Error(AI_NOT_CONFIGURED);

    // 总闸被打开时不发起在线补全（issue #401）。注意这里**不看内存水位**：在线补全只是一次
    // 网络请求，内存紧的时候禁它没有任何收益。闸门关着就以 ai-memory-guarded 开头抛出，
    // 调用方按「这台机器现在不该算」处理，别当普通失败反复重试。
    assertOnlineInferenceAllowed();

    /*
     * 安卓先走原生补全：请求由原生发起后，WebView 冻不冻结都与它无关 —— OkHttp 在
     * 自己的线程池里跑完，答案照样回来。没有这个方法（老版本 App / 非安卓）回落到
     * 下面那条（它经 aiNativeFetch 也是原生 OkHttp 发，只是发起那一刻需要 JS 活着）。
     */
    const native = await requestAiCompletionViaNative(request);
    if (native !== null) return { text: native, target };

    const send = createAiFetch();
    try {
        /*
         * 不能写成 `target.provider === 'openai'`。
         *
         * DeepSeek 是 OpenAI 兼容端点，但它是**自己的** provider id —— 上面那句会把
         * 它判成 Gemini，于是去读空的 geminiApiKey 并抛「未配置」。表现就是：测试连接
         * 明明成功（那条路认的是 isOpenAiCompatibleProvider），点生成却说没配置密钥。
         */
        const protocol = aiProtocolOf(target.provider);
        const text = protocol === 'gemini'
            ? await runGemini(request, send)
            : protocol === 'anthropic'
                ? await runAnthropic(request, send)
                : await runOpenAi(request, send);
        return { text, target };
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('ai-')) throw error;
        throw describeUnexpected(error);
    }
};

/**
 * The codes above are English by contract and reach the user in whatever the UI
 * speaks, so they are translated in one place instead of at every call site.
 * Anything that is not a known code is returned untouched.
 */
export const translateAiCompletionError = (message: string): string => {
    const text = String(message ?? '');
    if (text.startsWith(AI_NOT_CONFIGURED)) {
        return '还没有配置 AI：请在「设置 → AI」里选好服务商并填写密钥。';
    }
    if (text.startsWith('ai-aborted')) return '请求已被中止。';
    if (text.startsWith('ai-timeout')) return '请求超时：AI 没有在限定时间内回答。';
    if (text.startsWith('ai-empty-response')) return 'AI 返回的内容是空的。';
    if (text.startsWith('ai-refused')) return `AI 拒绝了这个请求：${text.slice('ai-refused:'.length).trim()}`;
    if (text.startsWith('ai-bad-response')) return 'AI 返回的不是合法 JSON。';
    /*
     * 免费渠道的「Key 无效 / 已停用」不是用户填错了什么 —— 他压根没有可填的东西。
     * 这两条要说清楚该干什么：去群里发机器码、签到，然后就能用。
     */
    if (
        (text.startsWith('ai-http-error:401') || text.startsWith('ai-http-error:403'))
        && readAiSettings().provider === 'foliawork'
    ) {
        return '请在群里发送机器码，完成绑定签到后即可使用。';
    }
    if (text.startsWith('ai-not-lyrics')) {
        return `免费渠道只接受歌词，这次没有生成：${text.slice('ai-not-lyrics:'.length).trim()}`;
    }
    if (text.startsWith('ai-http-error')) return `接口返回错误：${text.slice('ai-http-error:'.length).trim()}`;
    if (text.startsWith('ai-request-failed')) return `请求失败：${text.slice('ai-request-failed:'.length).trim()}`;
    if (text.startsWith('permission-denied')) {
        return `缺少 ${text.slice('permission-denied:'.length).trim() || '相应'}权限，无法调用 AI。`;
    }
    return text;
};
