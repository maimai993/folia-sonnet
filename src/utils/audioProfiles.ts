// src/utils/audioProfiles.ts
// 「耳机方案」的模型层：一套方案 = 一次完整的调音快照。
//
// 为什么快照整条链而不是只存十段：换一副耳机要改的往往不止频响 —— 封闭式要多压一点
// 低频、灵敏度高的要降几 dB 总增益、齿音重的要动后置那一级。只存 EQ 的话，切过去
// 之后压缩与混响还留在上一副耳机的设置里，听感对不上，也就失去了「一键比较」的意义。
//
// 存在 localStorage，与 audio_equalizer_settings / folia_audio_console 平级：
// 当前正在听的那一份仍由原来那两个键负责，方案库只是它的「存档位」。切换时先把当前
// 状态写回旧方案，再把新方案灌进那两个键 —— 于是一直只有一份「正在生效」的设置，
// 不会出现两处状态各说各话。

import { normalizeAudioConsoleSettings, type AudioConsoleSettings } from './audioConsole';
import { resolveAudioEqualizerSettings, type AudioEqualizerSettings } from './audioEqualizer';

export const AUDIO_PROFILES_STORAGE_KEY = 'folia_audio_profiles';

/** 最多 8 套：再多的话芯片一行放不下，也没人真会为八副耳机分别调音。 */
export const AUDIO_PROFILE_LIMIT = 8;

export const AUDIO_PROFILE_NAME_MAX = 20;

export type AudioProfile = {
    id: string;
    name: string;
    /** 十段增益、预设、两颗滤波器与自定义槽位，整份保存。 */
    equalizer: AudioEqualizerSettings;
    /** 前置形状、后置、压缩、混响、声场、染色、限幅。 */
    console: AudioConsoleSettings;
};

export type AudioProfilesState = {
    version: 1;
    activeId: string;
    profiles: AudioProfile[];
};

/** 深拷贝：快照必须与正在编辑的对象断开，否则下一次拖动会改到「存档」。 */
export const cloneAudioEqualizerSettings = (settings: AudioEqualizerSettings): AudioEqualizerSettings => (
    resolveAudioEqualizerSettings(JSON.parse(JSON.stringify(settings)))
);

export const cloneAudioConsoleSettings = (settings: AudioConsoleSettings): AudioConsoleSettings => (
    normalizeAudioConsoleSettings(JSON.parse(JSON.stringify(settings)))
);

export const createAudioProfile = (
    id: string,
    name: string,
    equalizer: AudioEqualizerSettings,
    console: AudioConsoleSettings,
): AudioProfile => ({
    id,
    name,
    equalizer: cloneAudioEqualizerSettings(equalizer),
    console: cloneAudioConsoleSettings(console),
});

let idCounter = 0;

/** 方案 id 只在本机用：时间戳加一个自增号，同一毫秒里连点两次也不会撞。 */
export const createAudioProfileId = (): string => {
    idCounter += 1;
    return `p${Date.now().toString(36)}${idCounter.toString(36)}`;
};

const asRecord = (value: unknown): Record<string, unknown> => (
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const readName = (value: unknown, fallback: string): string => {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim().slice(0, AUDIO_PROFILE_NAME_MAX);
    return trimmed || fallback;
};

/**
 * 读方案库。没有存档、存档损坏、或者一份都读不出来时，用当前设置播下第一套 ——
 * 升级上来的用户打开调音台就该看到「方案 1」，而不是一个空列表。
 */
export const readStoredAudioProfiles = (seed: {
    equalizer: AudioEqualizerSettings;
    console: AudioConsoleSettings;
    /** 名字的默认值由界面层给，模型层不碰翻译。 */
    nameForIndex: (index: number) => string;
}): AudioProfilesState => {
    const fallback = (): AudioProfilesState => {
        const profile = createAudioProfile(createAudioProfileId(), seed.nameForIndex(0), seed.equalizer, seed.console);
        return { version: 1, activeId: profile.id, profiles: [profile] };
    };

    if (typeof window === 'undefined') return fallback();

    let parsed: unknown;
    try {
        const raw = window.localStorage.getItem(AUDIO_PROFILES_STORAGE_KEY);
        if (!raw) return fallback();
        parsed = JSON.parse(raw);
    } catch {
        return fallback();
    }

    const root = asRecord(parsed);
    const rawProfiles = Array.isArray(root.profiles) ? root.profiles : [];
    const seen = new Set<string>();
    const profiles: AudioProfile[] = [];

    rawProfiles.slice(0, AUDIO_PROFILE_LIMIT).forEach((value, index) => {
        const record = asRecord(value);
        // id 重复会让「切换」切到错的那一套：重复的直接丢掉，后面按名字重发一个。
        const id = typeof record.id === 'string' && record.id && !seen.has(record.id)
            ? record.id
            : createAudioProfileId();
        if (seen.has(id)) return;
        seen.add(id);
        profiles.push(createAudioProfile(
            id,
            readName(record.name, seed.nameForIndex(index)),
            // 缺字段的旧存档按中性补齐，不会因为方案库损坏而让某套方案变成怪声。
            resolveAudioEqualizerSettings(record.equalizer),
            normalizeAudioConsoleSettings(record.console),
        ));
    });

    if (profiles.length === 0) return fallback();

    const activeId = typeof root.activeId === 'string' && profiles.some(profile => profile.id === root.activeId)
        ? root.activeId
        : profiles[0].id;

    return { version: 1, activeId, profiles };
};

export const writeStoredAudioProfiles = (state: AudioProfilesState) => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(AUDIO_PROFILES_STORAGE_KEY, JSON.stringify(state));
    } catch {
        // 配额满 / 隐私模式：这一轮切换仍然有效，只是下次启动回到旧的那一套。
    }
};
