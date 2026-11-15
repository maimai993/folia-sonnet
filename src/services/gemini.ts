import { DualTheme, Theme } from "../types";
import { applyStoredAnimationIntensityToDualTheme } from "./themePreferences";
import { sanitizeDualTheme } from "./themeSanitizer";
import { getWebAiProvider } from "./runtimeConfig";
import { resolveFoliaApiUrl } from "./webApi";
import { recordAiThemeAttempt, type AiThemeTrigger } from "../utils/aiThemeDiagnostics";
import { AI_NOT_CONFIGURED, isAiNotConfiguredError } from "./aiCompletion";
import { isLocalAiThemeAvailable } from "./aiThemeClient";
import { type AiCloudCacheSource } from "./aiCloudCache";
import { requestStage, resolveStageLyricSource, type StageLyricLine } from "./aiStage";

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? '');
};

/*
 * 云端缓存条目的形状校验放在 services/aiStage.ts —— 缓存是任何人都能推的，
 * 先校验再用，形状不对就跟没命中一样。
 */

/*
 * 「不是这一次没跑通，而是这台机器根本发不出去」。
 *
 * 两类错误落在这里：
 *  - services/aiCompletion 抛的 ai-not-configured：设置里没填密钥；
 *  - 部署端点地址解析不出来：安卓构建没配 VITE_FOLIA_API_BASE。
 *
 * 它们都不是「生成失败」。调用方拿它走封面取色兜底，而不是弹一条
 * 「主题生成失败」—— 后者会让没配置的人以为功能是坏的。
 *
 * 服务端回的「密钥无效 / 没配置」是另一回事（那一次请求确实发出去了、
 * 被拒了），仍然走兜底但不算不可用，见调用方。
 */
export const isMissingAiApiKeyError = (error: unknown) => {
  const message = getErrorMessage(error);
  if (isAiNotConfiguredError(error)) return true;
  return /(?:openai_api_key|gemini_api_key|api key)/i.test(message)
    && /(?:not configured|missing|configure)/i.test(message);
};

/**
 * AI 主题生成。每次尝试（成功或失败）都记一条可公开的记录：provider、阶段、HTTP 状态、
 * 截断后的错误原文与耗时 —— 「偶尔生成失败」这类反馈靠它定位，不记提示词、歌词与 Key。
 */
export interface AiThemeGenerationResult {
    theme: DualTheme;
    /** 'cloud' = 这次没有调用模型，用的是别人推上去的那份答案。 */
    source: AiCloudCacheSource;
}

export const generateThemeFromLyrics = async (
  lyricsText: string,
  options?: {
    isPureMusic?: boolean;
    songTitle?: string;
    artist?: string;
    album?: string | null;
    trigger?: AiThemeTrigger;
    lines?: readonly StageLyricLine[];
    /** 「重新生成」：不看缓存，生成完覆盖云端那条。 */
    force?: boolean;
    /**
     * 这首歌来自哪个音乐平台。只跟着上传走（服务端拿它去核对歌词），
     * 键仍然是那个 MD5 —— 早先推上去的条目照样拉得到。
     */
    platform?: string;
  }
): Promise<AiThemeGenerationResult> => {
  const provider = getWebAiProvider();
  const trigger = options?.trigger ?? 'unknown';
  const startedAt = Date.now();
  // HTTP 失败那条在分支里已经记过，catch 只补没走到响应的（网络错误、解析失败），不重复记。
  let recorded = false;

  /*
   * 指纹**不在这里算**。
   *
   * 参与指纹的是「歌词正文 + policy（纯音乐 / 提示词 / 屏蔽的样式 / force）」，
   * 全部由 services/aiStage.ts 的 buildStageContext 统一产出 —— 主题链路与导演链路
   * 才会算出同一个值，一次请求省下的那次模型调用才真的省下来。
   *
   * 这里只负责把「是不是纯音乐」这个判断结果交给它，不再自己拼一份。
   */
  const lyricLines = options?.lines ?? [];
  const resolved = resolveStageLyricSource({
      lines: lyricLines as { fullText?: string }[],
      isPureMusic: options?.isPureMusic === true,
      songTitle: options?.songTitle ?? '',
  });

  try {
    /*
     * 主题与动画合成一次请求发出去，回来一次解析两半（services/aiStage.ts）。
     *
     * 桌面版走 Electron 主进程时拿不到合并 prompt —— 那条路只能出主题，出不了动画
     * 决策，所以自己给一个只产主题的实现，照样由同一个入口统一编排、统一上报。
     */
    if ((window as any).electron && typeof (window as any).electron.generateTheme === 'function') {
      const stage = await requestStage({
        song: {
          title: options?.songTitle ?? '',
          artist: options?.artist ?? '',
          album: options?.album ?? null,
        },
        lines: lyricLines as { fullText?: string }[],
        isPureMusic: resolved.isPureMusic,
        songTitle: options?.songTitle,
        platform: options?.platform,
        require: 'theme',
        /* 「重新生成」同样要跳过缓存，否则桌面端点下去拿回的还是云端那条旧答案。 */
        force: options?.force === true,
        generate: async () => ({
          theme: sanitizeDualTheme(await (window as any).electron.generateTheme(lyricsText, options)),
        }),
      });
      if (!stage.theme) throw new Error('AI 没有返回可用的主题。');
      recorded = true;
      recordAiThemeAttempt({ provider, trigger, stage: 'request', ok: true, durationMs: Date.now() - startedAt });
      return { theme: applyStoredAnimationIntensityToDualTheme(stage.theme), source: stage.source };
    }

    /*
     * 设备本地直连：安卓没有 Electron 主进程，也没有部署自带的 generate-theme 端点，
     * 两条路都走不通 —— 这就是「AI 主题」在 App 里一直是灰的的原因。
     *
     * 用户在设置里填了自己的 Key 之后走这条，请求直接从设备发出去（安卓经原生
     * OkHttp 桥绕开 CORS）。主题与歌词动画合成一次请求（services/aiStage.ts）：
     * 一次往返两份答案，另一半留给动画导演，切一首歌只烧一次调用。
     */
    if (isLocalAiThemeAvailable()) {
      const stage = await requestStage({
        song: {
          title: options?.songTitle ?? '',
          artist: options?.artist ?? '',
          album: options?.album ?? null,
        },
        lines: lyricLines as { fullText?: string }[],
        isPureMusic: resolved.isPureMusic,
        songTitle: options?.songTitle,
        platform: options?.platform,
        require: 'theme',
        force: options?.force === true,
      });
      if (!stage.theme) throw new Error('AI 没有返回可用的主题。');
      recorded = true;
      recordAiThemeAttempt({
        provider,
        trigger,
        stage: stage.source === 'ai' ? 'request' : 'cloud-cache',
        ok: true,
        durationMs: Date.now() - startedAt,
      });
      return { theme: applyStoredAnimationIntensityToDualTheme(stage.theme), source: stage.source };
    }

    /*
     * 部署端点这条路也要先问云端，不能上来就去找服务器。
     *
     * 走这条的正是**没填 Key 的人** —— 云缓存这个开关默认打开就是为他准备的：
     * 他自己一个主题都生成不出来，能撞上别人推上来的那份就是白赚。
     *
     * 所以顺序固定：先拉云端 → 命中就用 → 没命中再去找服务器 → 服务器也没 Key
     * 才轮到报错。有缓存还报「没配置 Key」，那才是真的错。
     *
     * 地址也因此**延后**到 generate 里才算：缓存命中时压根不需要地址，
     * 早早解析反而让「没填地址」这种无关问题挡在缓存前面。
     */
    const stage = await requestStage({
        song: {
            title: options?.songTitle ?? '',
            artist: options?.artist ?? '',
            album: options?.album ?? null,
        },
        lines: lyricLines as { fullText?: string }[],
        isPureMusic: resolved.isPureMusic,
        songTitle: options?.songTitle,
        platform: options?.platform,
        require: 'theme',
        force: options?.force === true,
        generate: async () => {
            /*
             * 解析不出地址 = 这条路根本不通：安卓构建必须显式配后端地址，
             * 没配的时候 resolveFoliaApiUrl 会抛。那是配置问题，不是「生成失败」，
             * 统一成 ai-not-configured，好让上层认得出「本机不可用」。
             */
            let endpoint = '';
            try {
                endpoint = resolveFoliaApiUrl(
                    provider === 'openai' ? 'generate-theme_openai' : 'generate-theme',
                );
            } catch {
                throw new Error(AI_NOT_CONFIGURED);
            }
            const response = await fetch(
                endpoint,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ lyricsText, ...options }),
                },
            );

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

            return { theme: sanitizeDualTheme(await response.json() as DualTheme) };
        },
    });

    if (!stage.theme) throw new Error('AI 没有返回可用的主题。');
    recorded = true;
    recordAiThemeAttempt({
        provider,
        trigger,
        stage: stage.source === 'ai' ? 'web-endpoint' : 'cloud-cache',
        ok: true,
        durationMs: Date.now() - startedAt,
    });
    /*
     * 存进去的是「未经动画强度处理」的原始那份，取出来时才叠加。
     * 存已处理的、取时再处理一遍，强度会被叠乘，越用越偏。
     *
     * 部署端点是单用途的，只能出主题 —— 但仍写进同一条 stage 条目，不给同一段
     * 歌词留两份缓存。缺的动画那半会被 require:'decision' 判成没命中，等有 Key
     * 的那次生成再补上。
     */
    return { theme: applyStoredAnimationIntensityToDualTheme(stage.theme), source: stage.source };
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
