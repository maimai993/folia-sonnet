// src/stores/useAudioProfilesStore.ts
// 耳机方案：保存 / 切换 / 复制 / 改名 / 删除。
//
// 只有一套设置「正在生效」—— 就是 useAudioSettingsStore 与 useAudioConsoleStore 里那一份。
// 切换方案时先把当前状态写回旧方案，再把新方案灌进去；平时编辑不需要通知这里，
// 因此拖滑杆的高频更新不会牵动这个 store 的订阅者。

import { create } from 'zustand';
import i18n from '../i18n/config';
import {
    AUDIO_PROFILE_LIMIT,
    AUDIO_PROFILE_NAME_MAX,
    cloneAudioConsoleSettings,
    cloneAudioEqualizerSettings,
    createAudioProfile,
    createAudioProfileId,
    readStoredAudioProfiles,
    writeStoredAudioProfiles,
    type AudioProfile,
    type AudioProfilesState,
} from '../utils/audioProfiles';
import { useAudioConsoleStore } from './useAudioConsoleStore';
import { useAudioSettingsStore } from './useAudioSettingsStore';

const DEFAULT_NAME_KEY = 'ui.consoleProfileDefault';

const profileName = (index: number): string => String(i18n.t(DEFAULT_NAME_KEY, { n: index + 1 }));

const readCurrentSnapshot = () => ({
    equalizer: cloneAudioEqualizerSettings(useAudioSettingsStore.getState().audioEqualizerSettings),
    console: cloneAudioConsoleSettings(useAudioConsoleStore.getState().settings),
});

const initial = readStoredAudioProfiles({
    ...readCurrentSnapshot(),
    nameForIndex: profileName,
});

type AudioProfilesStore = AudioProfilesState & {
    /** 切到另一套：先存下当前这套，再把它灌进两个设置仓库。 */
    switchTo: (id: string) => void;
    /** 以当前声音为基础复制一套并切过去 —— 比较两种调法时最常用的一步。 */
    duplicateActive: () => void;
    renameActive: (name: string) => void;
    deleteActive: () => void;
    /** 把当前设置写回正在使用的那一套（关窗时调用，保证下次切换拿到的是最新的）。 */
    syncActive: () => void;
};

const commit = (
    set: (partial: AudioProfilesState) => void,
    state: AudioProfilesState,
) => {
    writeStoredAudioProfiles(state);
    set(state);
};

/** 把一套方案灌进两个仓库：均衡器那份会顺带结束正在播放的 mod 曲线。 */
const applyProfile = (profile: AudioProfile) => {
    useAudioSettingsStore.getState().handleSetAudioEqualizerSettings(cloneAudioEqualizerSettings(profile.equalizer));
    useAudioConsoleStore.getState().replaceSettings(cloneAudioConsoleSettings(profile.console));
};

export const useAudioProfilesStore = create<AudioProfilesStore>((set, get) => ({
    ...initial,

    switchTo: (id) => {
        const state = get();
        if (id === state.activeId) return;

        const target = state.profiles.find(profile => profile.id === id);
        if (!target) return;

        // 先把「正在响的这套」落回它自己的存档，再换。
        const snapshot = readCurrentSnapshot();
        const profiles = state.profiles.map(profile => (
            profile.id === state.activeId ? { ...profile, ...snapshot } : profile
        ));

        applyProfile(target);
        commit(set, { version: 1, activeId: id, profiles });
    },

    duplicateActive: () => {
        const state = get();
        if (state.profiles.length >= AUDIO_PROFILE_LIMIT) return;

        const snapshot = readCurrentSnapshot();
        const profiles = state.profiles.map(profile => (
            profile.id === state.activeId ? { ...profile, ...snapshot } : profile
        ));
        const copy = createAudioProfile(
            createAudioProfileId(),
            profileName(profiles.length),
            snapshot.equalizer,
            snapshot.console,
        );

        // 声音不用重新灌：复制出来的这一套就是此刻听到的。
        commit(set, { version: 1, activeId: copy.id, profiles: [...profiles, copy] });
    },

    renameActive: (name) => {
        const trimmed = name.trim().slice(0, AUDIO_PROFILE_NAME_MAX);
        if (!trimmed) return;

        const state = get();
        const current = state.profiles.find(profile => profile.id === state.activeId);
        if (!current || current.name === trimmed) return;

        commit(set, {
            version: 1,
            activeId: state.activeId,
            profiles: state.profiles.map(profile => (
                profile.id === state.activeId ? { ...profile, name: trimmed } : profile
            )),
        });
    },

    deleteActive: () => {
        const state = get();
        if (state.profiles.length <= 1) return;

        const index = state.profiles.findIndex(profile => profile.id === state.activeId);
        const remaining = state.profiles.filter(profile => profile.id !== state.activeId);
        // 删掉正在用的那套时，落到它左边那一套（删的是第一套就落到新的第一套）。
        const next = remaining[Math.max(0, Math.min(index - 1, remaining.length - 1))];

        applyProfile(next);
        commit(set, { version: 1, activeId: next.id, profiles: remaining });
    },

    syncActive: () => {
        const state = get();
        const snapshot = readCurrentSnapshot();
        const current = state.profiles.find(profile => profile.id === state.activeId);
        if (!current) return;
        if (
            JSON.stringify(current.equalizer) === JSON.stringify(snapshot.equalizer)
            && JSON.stringify(current.console) === JSON.stringify(snapshot.console)
        ) {
            return;
        }

        commit(set, {
            version: 1,
            activeId: state.activeId,
            profiles: state.profiles.map(profile => (
                profile.id === state.activeId ? { ...profile, ...snapshot } : profile
            )),
        });
    },
}));

export const readAudioProfiles = (): AudioProfilesState => {
    const state = useAudioProfilesStore.getState();
    return { version: 1, activeId: state.activeId, profiles: state.profiles };
};
