// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stores read localStorage at import time; see foliumUiRegistries.test.ts.
const storage = vi.hoisted(() => {
    const items = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => items.get(key) ?? null,
            setItem: (key: string, value: string) => { items.set(key, String(value)); },
            removeItem: (key: string) => { items.delete(key); },
            clear: () => items.clear(),
            key: (index: number) => Array.from(items.keys())[index] ?? null,
            get length() { return items.size; },
        },
    });
    return items;
});

import i18n from '@/i18n/config';
import { useAudioProfilesStore } from '@/stores/useAudioProfilesStore';
import { useAudioConsoleStore } from '@/stores/useAudioConsoleStore';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { AUDIO_PROFILES_STORAGE_KEY, AUDIO_PROFILE_LIMIT, createAudioProfile, readStoredAudioProfiles } from '@/utils/audioProfiles';
import { normalizeAudioConsoleSettings } from '@/utils/audioConsole';
import { resolveAudioEqualizerSettings } from '@/utils/audioEqualizer';

// test/unit/stores/audioProfiles.test.ts
// 耳机方案：一套方案是一整条链的快照；切换时先存旧、再灌新；改名、复制、删除与存档
// 解析（重复 id、缺字段、上限）都按预期收敛。

const equalizer = (gains: number[]) => resolveAudioEqualizerSettings({ enabled: true, gains });
const consoleSettings = () => normalizeAudioConsoleSettings(null);

const seedState = () => {
    const a = createAudioProfile('a', '方案 1', equalizer([1, 1, 0, 0, 0, 0, 0, 0, 1, 1]), consoleSettings());
    const b = createAudioProfile('b', '方案 2', equalizer([-1, -1, 0, 0, 0, 0, 0, 0, -1, -1]), consoleSettings());
    useAudioProfilesStore.setState({ version: 1, activeId: 'a', profiles: [a, b] });
    useAudioSettingsStore.setState({ audioEqualizerSettings: equalizer([1, 1, 0, 0, 0, 0, 0, 0, 1, 1]) });
    useAudioConsoleStore.setState({ settings: consoleSettings() });
    return { a, b };
};

beforeEach(() => {
    storage.clear();
    seedState();
});

describe('switching profiles', () => {
    it('writes the edit back into the outgoing profile and applies the incoming one whole', () => {
        const { a, b } = seedState();

        // 在方案 1 上改十段与混响，再切到方案 2。
        useAudioSettingsStore.getState().handleSetAudioEqualizerSettings(equalizer([6, 6, 0, 0, 0, 0, 0, 0, 0, 0]));
        useAudioConsoleStore.getState().replaceSettings({
            ...consoleSettings(),
            reverb: { ...consoleSettings().reverb, enabled: true, rt60: 4.5 },
        });

        useAudioProfilesStore.getState().switchTo('b');

        const state = useAudioProfilesStore.getState();
        const savedA = state.profiles.find(profile => profile.id === 'a')!;
        expect(savedA.equalizer.gains[0]).toBe(6);
        expect(savedA.console.reverb.enabled).toBe(true);
        expect(savedA.console.reverb.rt60).toBe(4.5);

        // 方案 2 的内容已经灌进两个仓库。
        expect(useAudioSettingsStore.getState().audioEqualizerSettings.gains[0]).toBe(b.equalizer.gains[0]);
        expect(useAudioConsoleStore.getState().settings.reverb.enabled).toBe(false);
        expect(a.equalizer.gains[0]).toBe(1);
    });

    it('keeps each profile’s custom slots apart', () => {
        seedState();
        const slots = useAudioSettingsStore.getState().audioEqualizerSettings.customSlots.map((slot, index) => (
            index === 0 ? { ...slot, gains: [3, 3, 3, 0, 0, 0, 0, 0, 0, 0] } : slot
        ));
        useAudioSettingsStore.getState().handleSetAudioEqualizerSettings({
            ...useAudioSettingsStore.getState().audioEqualizerSettings,
            customSlots: slots,
        });

        useAudioProfilesStore.getState().switchTo('b');
        const savedA = useAudioProfilesStore.getState().profiles.find(profile => profile.id === 'a')!;
        expect(savedA.equalizer.customSlots[0].gains[0]).toBe(3);
        // 方案 2 的槽位仍是它自己那一份，没有被方案 1 的编辑串过去。
        expect(useAudioSettingsStore.getState().audioEqualizerSettings.customSlots[0].gains[0]).toBe(-1);

        useAudioProfilesStore.getState().switchTo('a');
        expect(useAudioSettingsStore.getState().audioEqualizerSettings.customSlots[0].gains[0]).toBe(3);
        expect(storage.get(AUDIO_PROFILES_STORAGE_KEY)).toContain('方案 1');
    });
});

describe('managing the list', () => {
    it('duplicates the current sound and makes the copy active without touching the audio', () => {
        seedState();
        useAudioSettingsStore.getState().handleSetAudioEqualizerSettings(equalizer([4, 4, 0, 0, 0, 0, 0, 0, 0, 0]));

        useAudioProfilesStore.getState().duplicateActive();

        const state = useAudioProfilesStore.getState();
        expect(state.profiles).toHaveLength(3);
        const copy = state.profiles[2];
        expect(copy.name).toBe(String(i18n.t('ui.consoleProfileDefault', { n: 3 })));
        expect(state.activeId).toBe(copy.id);
        expect(copy.equalizer.gains[0]).toBe(4);
        expect(useAudioSettingsStore.getState().audioEqualizerSettings.gains[0]).toBe(4);
    });

    it('renames the active profile and ignores a blank name', () => {
        seedState();
        useAudioProfilesStore.getState().renameActive('  HD600  ');
        expect(useAudioProfilesStore.getState().profiles[0].name).toBe('HD600');

        useAudioProfilesStore.getState().renameActive('   ');
        expect(useAudioProfilesStore.getState().profiles[0].name).toBe('HD600');
    });

    it('deletes the active profile, applies its neighbour and never empties the list', () => {
        const { b } = seedState();
        useAudioProfilesStore.getState().switchTo('b');
        useAudioProfilesStore.getState().deleteActive();

        const state = useAudioProfilesStore.getState();
        expect(state.profiles).toHaveLength(1);
        expect(state.activeId).toBe('a');
        expect(useAudioSettingsStore.getState().audioEqualizerSettings.gains[0]).toBe(1);

        useAudioProfilesStore.getState().deleteActive();
        expect(useAudioProfilesStore.getState().profiles).toHaveLength(1);
        expect(b.name).toBe('方案 2');
    });

    it('stops at the profile limit', () => {
        const profiles = Array.from({ length: AUDIO_PROFILE_LIMIT }, (_, index) => (
            createAudioProfile(`p${index}`, `方案 ${index + 1}`, equalizer([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), consoleSettings())
        ));
        useAudioProfilesStore.setState({ version: 1, activeId: 'p0', profiles });

        useAudioProfilesStore.getState().duplicateActive();
        expect(useAudioProfilesStore.getState().profiles).toHaveLength(AUDIO_PROFILE_LIMIT);
    });
});

describe('reading the archive', () => {
    const seed = {
        equalizer: equalizer([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        console: consoleSettings(),
        nameForIndex: (index: number) => `方案 ${index + 1}`,
    };

    it('seeds one profile when nothing is stored', () => {
        const state = readStoredAudioProfiles(seed);
        expect(state.profiles).toHaveLength(1);
        expect(state.profiles[0].name).toBe('方案 1');
        expect(state.activeId).toBe(state.profiles[0].id);
    });

    it('drops duplicate ids, clamps names and caps the list', () => {
        const profiles = Array.from({ length: 12 }, (_, index) => ({
            id: index < 2 ? 'same' : `p${index}`,
            name: index === 2 ? '   ' : `x`.repeat(40),
            equalizer: { gains: [1] },
            console: {},
        }));
        storage.set(AUDIO_PROFILES_STORAGE_KEY, JSON.stringify({ activeId: 'missing', profiles }));

        const state = readStoredAudioProfiles(seed);
        expect(state.profiles).toHaveLength(AUDIO_PROFILE_LIMIT);
        expect(new Set(state.profiles.map(profile => profile.id)).size).toBe(AUDIO_PROFILE_LIMIT);
        expect(state.profiles[1].name).toBe('x'.repeat(20));
        expect(state.profiles[2].name).toBe('方案 3');
        expect(state.activeId).toBe(state.profiles[0].id);
    });
});
