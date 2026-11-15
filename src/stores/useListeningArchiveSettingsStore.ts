import { create } from 'zustand';
import type { ArchiveSettings } from '../services/listeningArchive/types';
import { getStoredBoolean, setStoredBoolean } from './storagePrimitives';

// src/stores/useListeningArchiveSettingsStore.ts
// 听歌档案的两个设置：采集开关与低性能模式。
//
// 两个都是功能性设置（不是外观参数），所以不进外观配置的短码 / JSON：它们在档案自己的设置页
// 和命令面板里改，只存本机。键名以 `folia_listening_archive_` 开头。

const LISTENING_ARCHIVE_ENABLED_KEY = 'folia_listening_archive_enabled';
const LISTENING_ARCHIVE_LOW_PERFORMANCE_KEY = 'folia_listening_archive_low_performance';

export type ListeningArchiveSettingsState = ArchiveSettings & {
    setEnabled: (enabled: boolean) => void;
    setLowPerformance: (lowPerformance: boolean) => void;
};

export const useListeningArchiveSettingsStore = create<ListeningArchiveSettingsState>((set) => ({
    enabled: getStoredBoolean(LISTENING_ARCHIVE_ENABLED_KEY, true),
    lowPerformance: getStoredBoolean(LISTENING_ARCHIVE_LOW_PERFORMANCE_KEY, false),
    setEnabled: (enabled) => {
        setStoredBoolean(LISTENING_ARCHIVE_ENABLED_KEY, enabled);
        set({ enabled });
    },
    setLowPerformance: (lowPerformance) => {
        setStoredBoolean(LISTENING_ARCHIVE_LOW_PERFORMANCE_KEY, lowPerformance);
        set({ lowPerformance });
    },
}));

/** 采集侧读开关的那一处：每帧回调里不能订阅 React store，只能用 getState 读当前值。 */
export const isListeningArchiveEnabled = (): boolean => useListeningArchiveSettingsStore.getState().enabled;
