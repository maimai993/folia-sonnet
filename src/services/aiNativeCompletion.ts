import type { AiCompletionRequest } from './aiCompletion';
import { readAiSettings, resolveAiApiKey, resolveAiBaseUrl, resolveAiModel } from './aiSettings';

// src/services/aiNativeCompletion.ts
// AI 补全的原生路径：请求由原生拼装并发送，WebView 冻不冻结都与它无关。
//
// 与 aiNativeFetch 的分工：那边把 **HTTP 字节**搬过桥（网页发起、原生转发，发起那一刻
// JS 必须活着）；这边把**整个补全**搬过去 —— 拼请求体、发、参数降级重试、解响应全在
// 原生。云缓存那条链的拉取/回传仍是网页发起（它必须在拿到生成结果之后才回传，而结果
// 要先由这条发出去）。
//
// 凭据只存原生（FoliaNative.setAiConfig → FoliaSettingsStore）：Web 的 localStorage
// 那份照旧给设置界面，真正发请求的原生用自己的那份。

type NativeAiFullPlugin = {
    setAiConfig?: (options: { config: Record<string, unknown> }) => Promise<unknown>;
    runAiCompletion?: (options: {
        system: string;
        prompt: string;
        maxTokens?: number;
        json?: boolean;
    }) => Promise<{ text?: string }>;
};

const getPlugin = (): NativeAiFullPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            isNativePlatform?: () => boolean;
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeAiFullPlugin };
        };
    }).Capacitor;
    if (capacitor?.isNativePlatform?.() !== true && capacitor?.getPlatform?.() !== 'android') return null;
    return capacitor?.Plugins?.FoliaNative ?? null;
};

/** 当前设置整份推给原生。设置变化与启动时各调一次。 */
export const pushAiConfigToNative = async (): Promise<boolean> => {
    const plugin = getPlugin();
    if (!plugin?.setAiConfig) return false;
    const settings = readAiSettings();
    const provider = settings.provider;
    try {
        await plugin.setAiConfig({
            config: {
                provider,
                geminiApiKey: settings.geminiApiKey,
                geminiApiUrl: settings.geminiApiUrl,
                // 非 Gemini 的密钥；Gemini 用不到但照传（原生按 provider 取）。
                apiKey: resolveAiApiKey(settings),
                model: resolveAiModel(settings),
                baseUrl: resolveAiBaseUrl(settings),
                temperature: Number.parseFloat(settings.apiTemperature) || 0.7,
            },
        });
        return true;
    } catch {
        return false;
    }
};

/**
 * 原生跑一次补全。返回 null = 原生这条路不可用（老版本 App / 桥出错），调用方回落。
 *
 * 错误码与 Web 侧同一族（ai-not-configured / ai-http-error:N / ...）：reject 的
 * message 以它开头，直接抛出去让 translateAiCompletionError 翻。
 */
export const requestAiCompletionViaNative = async (
    request: AiCompletionRequest,
): Promise<string | null> => {
    const plugin = getPlugin();
    if (!plugin?.runAiCompletion) return null;
    try {
        const result = await plugin.runAiCompletion({
            system: request.system,
            prompt: request.prompt,
            maxTokens: request.maxTokens ?? 0,
            json: request.json !== false,
        });
        const text = result?.text;
        return typeof text === 'string' ? text : null;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        // 原生跑起来的失败（配置错、接口错）是真失败，原样抛 —— 调用方的翻译层认这些码。
        if (message.startsWith('ai-')) throw new Error(message);
        // 桥本身的问题（老版本没这个方法等）：null 让调用方回落。
        return null;
    }
};
