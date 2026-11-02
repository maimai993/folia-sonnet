import { isCapacitorAndroid } from '../platform/runtime';
import { writeNativeSettings } from './nativeSettingsBridge';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { md5 } from '../utils/md5';

// 原生后台主题任务的配置与认领；不控制播放器，原生结果仍由正常 stage 入口校验。
export type BackgroundThemeConfig = {
    enabled: boolean;
    cloudEnabled: boolean;
    cloudBaseUrl: string;
    system: string;
    promptTemplate: string;
    policy: string;
    daylight?: boolean;
};
let activeConfig: BackgroundThemeConfig | null = null;

/*
 * 已经写进原生 `backgroundTheme.config` 的那份配置的签名。
 *
 * 为什么要在 JS 这边记一笔：原生结果的 identity 里带着「设置指纹」（cloudEnabled /
 * cloudBaseUrl / system / promptTemplate）。回前台时这个 hook 会把配置按当前设置重算一遍，
 * 只要落笔，原生就可能把「刚算好的主题」判成旧配置下的答案而丢掉。重算出来一模一样时
 * 干脆不写，是从源头上不给这件事发生的机会（见 useBackgroundThemeConfig 里的取舍说明）。
 */
let pushedSignature = '';

/** 参与 answer identity 的字符串字段：空串代表「这一拍还读不到设置」，不能用来覆盖已知值。 */
const IDENTITY_TEXT_FIELDS = ['cloudBaseUrl', 'system', 'promptTemplate', 'policy'] as const;

const signatureOf = (config: BackgroundThemeConfig): string => JSON.stringify([
    config.enabled,
    config.cloudEnabled,
    config.cloudBaseUrl,
    config.system,
    config.promptTemplate,
    config.policy,
    config.daylight === true,
]);

/** 当前已下发给原生的配置（没有就是 null）。 */
export const readActiveBackgroundThemeConfig = (): BackgroundThemeConfig | null => activeConfig;

/**
 * 回前台重算的配置与已下发的那份合并，**空串不覆盖已有值**。
 *
 * 为什么要这一步：`system` / `promptTemplate` 由导演设置、模式目录与 i18n 现拼，
 * `cloudBaseUrl` 来自云设置；刚回到前台的那一拍里，这些来源可能还没水合完，
 * 拼出来是空串。空串一旦写进原生，`BackgroundThemeRules.parseConfig` 会退回内置
 * 默认提示词，指纹跟着变 —— 原生已经算好的结果就此认领不到（issue #209 的第 3 条）。
 * 所以只让「真的读到了的内容」参与覆盖，读不到就保持原生那份。
 */
export const mergeBackgroundThemeConfig = (
    previous: BackgroundThemeConfig | null,
    next: BackgroundThemeConfig,
): BackgroundThemeConfig => {
    if (!previous) return { ...next };
    const merged: BackgroundThemeConfig = { ...next };
    for (const field of IDENTITY_TEXT_FIELDS) {
        if (!next[field].trim() && previous[field].trim()) {
            console.log(`[BackgroundTheme] 配置字段 ${field} 这一拍算不出内容，保留已下发的值，避免原生结果被判定过期`);
            merged[field] = previous[field];
        }
    }
    return merged;
};

/** 两份配置是否等价（按影响结果的字段比，不看对象身份）。 */
export const isSameBackgroundThemeConfig = (
    first: BackgroundThemeConfig | null,
    second: BackgroundThemeConfig | null,
): boolean => (first && second ? signatureOf(first) === signatureOf(second) : false);

/**
 * 下发配置。传进来的应当是 [mergeBackgroundThemeConfig] 合过的那份；
 * 与上次写进原生的完全一样时不重写（不重写＝原生结果不会因指纹变化被判过期）。
 */
export const configureBackgroundTheme = async (config: BackgroundThemeConfig): Promise<void> => {
    activeConfig = config;
    if (!isCapacitorAndroid()) return;
    const signature = signatureOf(config);
    if (signature === pushedSignature) return;
    const written = await writeNativeSettings({ 'backgroundTheme.config': JSON.stringify(config) });
    if (!written) {
        /*
         * 没写成就不记签名：下一拍还会再试。
         * 记了会让「这次没落盘」变成「以后都不落盘」，原生就一直按旧配置生成。
         */
        console.warn('[BackgroundTheme] 原生配置下发失败，保留未下发状态等下次重试');
        return;
    }
    pushedSignature = signature;
    console.log('[BackgroundTheme] 原生配置已下发', {
        enabled: config.enabled,
        cloudEnabled: config.cloudEnabled,
        policyLength: config.policy.length,
        daylight: config.daylight === true,
    });
};

/**
 * 只用于日志对照的 Web 侧歌词指纹（md5 前 16 位）。
 *
 * **不要拿它当身份**：原生那边的键由 `BackgroundThemeRules.lyricHash`（SHA-256 前 16 位）
 * 算，两边算法本来就不一样；这一行只是为了让排查时能把「Web 手上是哪段歌词」和
 * 原生日志里的指纹对上号（issue #209 要的现场）。
 */
const lyricTextProbe = (text: string): string => md5(text.replace(/\s+/g, ' ').trim()).slice(0, 16);

export const readBackgroundTheme = async (title: string, lyricText: string): Promise<{ payload: unknown; source: 'ai' | 'cloud' } | null> => {
    if (!isCapacitorAndroid() || !activeConfig?.enabled) return null;
    const song = usePlaybackStore.getState().currentSong;
    if (!song || song.name !== title) return null;
    const plugin = (window as unknown as { Capacitor?: { Plugins?: { FoliaNative?: {
        getBackgroundThemeResult?: (input: { songKey: string; policy: string; lyricText: string }) => Promise<{ payload?: unknown; source?: string }>;
    } } } }).Capacitor?.Plugins?.FoliaNative;
    if (!plugin?.getBackgroundThemeResult) return null;
    try {
        const songKey = getPlaybackSongKey(song);
        const policy = activeConfig.policy;
        const result = await plugin.getBackgroundThemeResult({ songKey, policy, lyricText });
        if (!result?.payload || (result.source !== 'cloud' && result.source !== 'ai')) {
            /*
             * 未命中也要记：issue #209 正是靠这几行才看得出「原生到底算没算过」。
             * 歌词指纹两侧都打出来，但要知道它们本来就允许不同（Web 这份是界面上的歌词）。
             */
            console.log('[BackgroundTheme] 原生未给出结果，回落云缓存/生成', {
                songKey,
                policyLength: policy.length,
                webLyricProbe: lyricTextProbe(lyricText),
                webLyricLength: lyricText.length,
            });
            return null;
        }
        console.log('[BackgroundTheme] 采用原生结果', { songKey, source: result.source, webLyricProbe: lyricTextProbe(lyricText) });
        return { payload: result.payload, source: result.source };
    } catch (error) {
        console.warn('[BackgroundTheme] 原生结果读取失败，回落正常主题流程', error);
        return null;
    }
};
