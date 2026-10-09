import { DualTheme } from "../types";
import { applyStoredAnimationIntensityToDualTheme } from "./themePreferences";
import { sanitizeDualTheme } from "./themeSanitizer";
import { getWebAiProvider } from "./runtimeConfig";
import { resolveFoliaApiUrl } from "./webApi";
import { recordAiThemeAttempt, type AiThemeTrigger } from "../utils/aiThemeDiagnostics";

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? '');
};

export const isMissingAiApiKeyError = (error: unknown) => {
  const message = getErrorMessage(error);
  return /(?:openai_api_key|gemini_api_key|api key)/i.test(message)
    && /(?:not configured|missing|configure)/i.test(message);
};

/**
 * AI 主题生成。每次尝试（成功或失败）都记一条可公开的记录：provider、阶段、HTTP 状态、
 * 截断后的错误原文与耗时 —— 「偶尔生成失败」这类反馈靠它定位，不记提示词、歌词与 Key。
 */
export const generateThemeFromLyrics = async (
  lyricsText: string,
  options?: { isPureMusic?: boolean; songTitle?: string; trigger?: AiThemeTrigger }
): Promise<DualTheme> => {
  const provider = getWebAiProvider();
  const trigger = options?.trigger ?? 'unknown';
  const startedAt = Date.now();
  // HTTP 失败那条在分支里已经记过，catch 只补没走到响应的（网络错误、解析失败），不重复记。
  let recorded = false;
  try {
    // Check if running in Electron environment
    if ((window as any).electron && typeof (window as any).electron.generateTheme === 'function') {
      const dualTheme = await (window as any).electron.generateTheme(lyricsText, options);
      const theme = sanitizeDualTheme(dualTheme);
      recordAiThemeAttempt({ provider, trigger, stage: 'request', ok: true, durationMs: Date.now() - startedAt });
      return theme;
    }

    const endpoint = resolveFoliaApiUrl(provider === 'openai' ? 'generate-theme_openai' : 'generate-theme');

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ lyricsText, ...options }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = (errorData as { error?: string }).error || `HTTP ${response.status}`;
      recorded = true;
      recordAiThemeAttempt({
        provider,
        trigger,
        stage: 'web-endpoint',
        ok: false,
        status: response.status,
        error: message,
        durationMs: Date.now() - startedAt,
      });
      throw new Error(message || 'Failed to generate theme');
    }

    const dualTheme = await response.json();
    recordAiThemeAttempt({
      provider,
      trigger,
      stage: 'request',
      ok: true,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return applyStoredAnimationIntensityToDualTheme(sanitizeDualTheme(dualTheme as DualTheme));
  } catch (error) {
    if (!recorded) {
      recordAiThemeAttempt({
        provider,
        trigger,
        stage: 'unknown',
        ok: false,
        error: getErrorMessage(error),
        durationMs: Date.now() - startedAt,
      });
    }
    console.error("Failed to generate theme via API:", error);
    throw error;
  }
};

// The AI connection the web OBS overlay (Dynamic AI mode) generates a theme with. The overlay runs
// in a separate browser context, so it takes an explicit provider instead of reading anything from
// the app; the provider is selected by Docker runtime config or the Vite build fallback.
export interface ObsAiConfig {
  provider: 'gemini' | 'openai';
}

// OBS-overlay variant of generateThemeFromLyrics: keyless (the endpoint uses its own server env
// key), abortable, and with no Electron branch since the overlay is web-only. Used per song by the
// overlay; the caller falls back to the builtin theme if it rejects.
export const generateObsThemeFromLyrics = async (
  lyricsText: string,
  options: { isPureMusic?: boolean; songTitle?: string } | undefined,
  aiConfig: ObsAiConfig,
  signal?: AbortSignal,
): Promise<DualTheme> => {
  const endpoint = resolveFoliaApiUrl(aiConfig.provider === 'openai' ? 'generate-theme_openai' : 'generate-theme');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lyricsText, ...(options ?? {}) }),
    signal,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error((errorData as { error?: string }).error || 'Failed to generate theme');
  }

  const dualTheme = await response.json();
  return applyStoredAnimationIntensityToDualTheme(sanitizeDualTheme(dualTheme as DualTheme));
};
