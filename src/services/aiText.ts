import { DualTheme } from "../types";
import { applyStoredAnimationIntensityToDualTheme } from "./themePreferences";
import { sanitizeDualTheme } from "./themeSanitizer";
import { getWebAiProvider, type WebAiProvider } from "./runtimeConfig";
import { isCapacitorAndroid } from "../platform/runtime";
import { generateThemeWithConfiguredAi, isLocalAiThemeAvailable } from "./aiThemeClient";
export {
  AI_PROVIDER_PRESETS,
  inferAiProviderFromUrl,
  modelAlwaysThinks,
  resolveAiConnection,
  resolveAiProviderPreset,
  retiredModelHint,
} from '../../shared/ai/providerRegistry.mjs';
/*
 * 免费渠道的「贡献账号」入口地址。组件不直接 import shared/ai/（见本文件末尾那段说明），
 * 所以从这一处转出。
 */
import { FOLIA_WORK_API_BASE, FOLIA_WORK_MODEL } from '../../shared/ai/foliawork.mjs';
import { ensureMachineCode } from './foliaMachineCode';
import { readAiSettings } from './aiSettings';
export { FOLIA_WORK_SHARE_PAGE_URL, FOLIA_CHECKIN_URL } from '../../shared/ai/foliawork.mjs';
/** 免费渠道的连接测试在渲染层跑（它没有主进程凭据，请求形状也是原生端点）。 */
export { testConfiguredAiConnection } from './aiThemeClient';

// src/services/aiText.ts

/**
 * The window's one way out to the AI text services (Gemini, OpenAI and OpenAI-compatible hosts).
 * The app asks them for three things: a theme made from a song's lyrics, a segmentation of lyric
 * lines into words, and the connection test of the settings form. This file is the only place in
 * src/ that knows how those asks leave the window: the desktop bridge (window.electron's
 * generateTheme, segmentLyrics and testAiConnection) and our own web routes (/api/generate-theme,
 * /api/generate-theme_openai, /api/segment-lyrics).
 *
 * The window never sends a request to a service itself. The only key it handles is the one typed
 * into the settings form, which it hands to the main process to store or to test. On the desktop
 * the main process sends the request, with the service and the key from the user's settings
 * (electron/aiTextClient.cjs, behind the IPC handlers in electron/main.cjs). On the web our
 * serverless routes send it, with the deployment's key (worker/, and api-ts/ built into api/;
 * segmentation in shared/lyricSegmentationService.mjs). Which service the web build uses is the
 * deployment's choice, read by ./runtimeConfig.
 *
 * It lives in src/services/ because the theme controller, the OBS overlay, the lyric segmentation
 * and the settings form all use it, and none of them owns it.
 *
 * The settings form also reads the provider registry through here (presets, sites, default and
 * retired models: shared/ai/providerRegistry.mjs), so no component imports shared/ai/ itself.
 */

/** Our web route for the theme ask, one per service. */
const THEME_ROUTES: Record<WebAiProvider, string> = {
  gemini: '/api/generate-theme',
  openai: '/api/generate-theme_openai',
};

/** Anything that is not a service of the table goes to Gemini's route. */
const themeRoute = (provider: WebAiProvider) => THEME_ROUTES[provider] ?? THEME_ROUTES.gemini;

/** Our web route for the segmentation ask. The route picks the service itself. */
const SEGMENTATION_ROUTE = '/api/segment-lyrics';

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? '');
};

/** What our web theme routes answer when the deployment has no key; they say it for nothing else. */
const WEB_ROUTE_WITHOUT_KEY = 'Server configuration error';

export const isMissingAiApiKeyError = (error: unknown) => {
  const message = getErrorMessage(error);
  return message === WEB_ROUTE_WITHOUT_KEY
    || (/(?:openai_api_key|gemini_api_key|api key)/i.test(message)
      && /(?:not configured|missing|configure)/i.test(message));
};

export const generateThemeFromLyrics = async (
  lyricsText: string,
  options?: { isPureMusic?: boolean; songTitle?: string }
): Promise<DualTheme> => {
  /*
   * ⚠️ 主链路**不走这里**：useThemeController 用的是 services/gemini 那一版同名函数，
   * 它经 requestStage 编排，先问云缓存、没有再生成、生成完回传。这里这一版不碰缓存，
   * 只为 OBS 叠加层与兼容路径留着。
   *
   * 两份同名实现是上游合并留下的（它把 useThemeController 的 import 改到了这里，
   * 主题链路于是绕开云缓存 —— 那就是「云缓存失效」）。别再用它做主链路。
   */
  try {
    // Check if running in Electron environment
    if ((window as any).electron && typeof (window as any).electron.generateTheme === 'function') {
      const dualTheme = await (window as any).electron.generateTheme(lyricsText, options);
      return sanitizeDualTheme(dualTheme);
    }

    // 安卓（Capacitor）没有同源的 /api 路由 —— 同源就是 WebView 自己的那个服务器，
    // 认不出的路径一律回 index.html，于是 `response.json()` 抛
    // "Unexpected token '<', "<!DOCTYPE " ..."。看着像 AI 挂了，其实请求压根没出去。
    // App 里走第三条路：用户填的 Key，经原生 OkHttp 桥直连服务商（services/aiThemeClient.ts）。
    if (isCapacitorAndroid()) {
      // 还没填 Key 就别发一次注定 403 的请求：抛一个 isMissingAiApiKeyError 认得出的错，
      // 界面才能提示「去设置里填 Key」，而不是报一个看不懂的 HTTP 403。
      if (!isLocalAiThemeAvailable()) throw new Error(WEB_ROUTE_WITHOUT_KEY);
      return generateThemeWithConfiguredAi(lyricsText, options);
    }

    const response = await fetch(themeRoute(getWebAiProvider()), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ lyricsText, ...options }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to generate theme');
    }

    const dualTheme = await response.json();
    return applyStoredAnimationIntensityToDualTheme(sanitizeDualTheme(dualTheme as DualTheme));
  } catch (error) {
    console.error("Failed to generate theme via API:", error);
    throw error;
  }
};

// The AI connection the web OBS overlay (Dynamic AI mode) generates a theme with. The overlay runs
// in a separate browser context, so it takes an explicit provider instead of reading anything from
// the app; the provider is selected by Docker runtime config or the Vite build fallback.
export interface ObsAiConfig {
  provider: WebAiProvider;
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
  const response = await fetch(themeRoute(aiConfig.provider), {
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

type SegmentationBridge = {
  segmentLyrics?: (lines: string[]) => Promise<string[][]>;
};

const getSegmentationBridge = (): SegmentationBridge | null => {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { electron?: SegmentationBridge }).electron;
  return bridge && typeof bridge.segmentLyrics === 'function' ? bridge : null;
};

/** Whether an AI segmentation request can be made at all from this build. */
export const isLyricSegmentationAiAvailable = (): boolean => {
  if (typeof window === 'undefined') return false;
  // 桌面端走 IPC，由主进程拿着用户设置里的模型去问。
  if (getSegmentationBridge()) return true;
  // 安卓（Capacitor）没有同源的 /api/segment-lyrics：那个请求会拿到 WebView 自己的
  // index.html，`response.json()` 悄悄解析成 {}，于是「AI 分词」永远静默失败 ——
  // 界面上看不出它跑过，也看不出它没跑成。这里直接说不可用，让调用方走规则分词。
  if (isCapacitorAndroid()) return false;
  return typeof fetch === 'function';
};

/**
 * One segmentation request: the desktop build goes through IPC so it can use the model the user
 * configured in settings, and the web build posts to the deployment's own route because its
 * credentials live server-side. Resolves to the rows as they were answered; checking them against
 * the lines is the caller's. `signal` only reaches the web path; ipcRenderer.invoke cannot be
 * cancelled.
 */
export const requestLyricSegmentation = async (lines: string[], signal?: AbortSignal): Promise<unknown> => {
  const bridge = getSegmentationBridge();
  if (bridge?.segmentLyrics) {
    return bridge.segmentLyrics(lines);
  }

  const response = await fetch(SEGMENTATION_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines }),
    signal,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error || 'Failed to segment lyrics');
  }

  return (payload as { lines?: unknown }).lines;
};

/** Whether model discovery can run here; saved credentials stay in the desktop main process. */
export const canListAiModels = (): boolean => Boolean(window.electron?.listAiModels);

/** Loads the current connection's models without exposing its saved key to the renderer. */
export const fetchAiModels = (payload: AiConnectionTestPayload): Promise<AiModelListResult> => (
  window.electron?.listAiModels
    ? window.electron.listAiModels(payload)
    : Promise.resolve({ ok: false, errorKind: 'config' })
);

/** Whether the connection test can run here. It is desktop only: there is no web route for it. */
export const canRunAiConnectionTest = (): boolean => Boolean(window.electron?.testAiConnection);

/**
 * 桌面端启动时的一次性对齐：把 AI 服务商默认成免费渠道，并把本机机器码交给主进程。
 *
 * 为什么放在这个文件（而不是某个 hook 里）：`aiTextArchitecture` 那条门禁规定，只有
 * `services/aiText.ts` 可以提到 AI 设置的字段名。主进程也不许写死服务商的地址与模型，
 * 所以「第一次运行该是什么样子」只能由渲染层通过已有的 `save-settings` 通道写进去。
 *
 * 只种一次：`AI_PROVIDER` 有值就再也不碰 —— 用户换成别家之后不会被改回来。
 * 返回 true 表示这次真的种了（测试与日志用得上）。
 */
export const seedFreeChannelOnDesktop = async (): Promise<boolean> => {
  const bridge = window.electron;
  if (!bridge?.saveSettings) return false;
  try {
    /*
     * **只在什么都没存过时**把服务商默认成免费渠道 —— 这是「默认选免费」，不是「只能免费」。
     *
     * 不种这一份的话，设置表单读到的「什么都没存」会退回 Gemini：新装的人看到的是
     * 「Google Gemini」，免费渠道那一块（机器码、剩余积分、贡献账号）根本不出现。
     * 存过就再也不碰，用户换成别家之后不会被改回来。
     */
    const settings = typeof bridge.getSettings === 'function'
      ? await bridge.getSettings().catch(() => null)
      : null;
    if (settings && settings.AI_PROVIDER !== undefined) {
      // 已经配过了：只需要保证当前选的是免费渠道时，机器码在凭据库里。
      if (readAiSettings().provider !== 'foliawork') return false;
      await bridge.saveSettings('OPENAI_API_KEY', ensureMachineCode());
      return false;
    }
    await bridge.saveSettings('AI_PROVIDER', 'openai');
    await bridge.saveSettings('AI_PROVIDER_PRESET', 'foliawork');
    await bridge.saveSettings('OPENAI_API_URL', FOLIA_WORK_API_BASE);
    await bridge.saveSettings('OPENAI_API_MODEL', FOLIA_WORK_MODEL);
    // 首次运行必然是免费渠道：顺手把机器码交过去，用户装完就能直接用。
    await bridge.saveSettings('OPENAI_API_KEY', ensureMachineCode());
    console.info('[folia] 首次运行：AI 服务商已默认成免费渠道');
    return true;
  } catch {
    // 写不进去（旧版本 / IPC 被拦）：主进程那条路会报「没配 Key」，
    // 用户能看到明确的提示，比这里静默失败更容易排查。
    console.warn('[folia] 没能把免费渠道写进主进程设置，桌面端主题生成可能报「未配置」');
    return false;
  }
};

/**
 * Hands the unsaved values of the settings form to the main process, which sends one "hello" with
 * them and answers with what came back. Only where canRunAiConnectionTest() says yes.
 */
export const runAiConnectionTest = (payload: AiConnectionTestPayload): Promise<AiConnectionTestResult> => (
  window.electron!.testAiConnection(payload)
);
