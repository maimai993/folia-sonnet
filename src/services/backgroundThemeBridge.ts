import { isCapacitorAndroid } from '../platform/runtime';
import { writeNativeSettings } from './nativeSettingsBridge';
import { usePlaybackStore } from '../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';

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

export const configureBackgroundTheme = async (config: BackgroundThemeConfig): Promise<void> => {
    activeConfig = config;
    if (!isCapacitorAndroid()) return;
    await writeNativeSettings({ 'backgroundTheme.config': JSON.stringify(config) });
};

export const readBackgroundTheme = async (title: string, lyricText: string): Promise<{ payload: unknown; source: 'ai' | 'cloud' } | null> => {
    if (!isCapacitorAndroid() || !activeConfig?.enabled) return null;
    const song = usePlaybackStore.getState().currentSong;
    if (!song || song.name !== title) return null;
    const plugin = (window as unknown as { Capacitor?: { Plugins?: { FoliaNative?: {
        getBackgroundThemeResult?: (input: { songKey: string; policy: string; lyricText: string }) => Promise<{ payload?: unknown; source?: string }>;
    } } } }).Capacitor?.Plugins?.FoliaNative;
    if (!plugin?.getBackgroundThemeResult) return null;
    try {
        const result = await plugin.getBackgroundThemeResult({ songKey: getPlaybackSongKey(song), policy: activeConfig.policy, lyricText });
        return result?.payload && (result.source === 'cloud' || result.source === 'ai')
            ? { payload: result.payload, source: result.source } : null;
    } catch (error) {
        console.warn('[BackgroundTheme] 原生结果读取失败，回落正常主题流程', error);
        return null;
    }
};
