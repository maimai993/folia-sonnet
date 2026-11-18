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
import { PREBUILD_TRACKS_KEY, VOCAL_CANCEL_KEY, VOCAL_ONLY_KEY, useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';

// test/unit/stores/audioSettingsSetters.test.ts
// The set-to-a-value forms of mute and repeat mode (Folium's playback.setMuted /
// setLoopMode call them) and the toggles that now delegate to them: one place
// persists and toasts, the value already in effect writes nothing and toasts
// nothing, and the toggles behave exactly as before.

const initialAudio = useAudioSettingsStore.getState();

beforeEach(async () => {
    useAudioSettingsStore.setState(initialAudio, true);
    useStatusMessageStore.setState({ message: null });
    storage.clear();
    /*
     * 「禁用 AI 推理」总闸默认打开（#401），它会当场拒掉人声 / 伴奏分离。
     * 这个文件验的是开关拨动的语义（持久化、互斥、一次原子更新），所以先把推理打开。
     */
    const { useAiInferenceSettingsStore } = await import('@/stores/useAiInferenceSettingsStore');
    useAiInferenceSettingsStore.getState().setAiInferenceDisabled(false);
});

describe('handleSetMuted', () => {
    it('sets and persists the mute switch, leaving the volume alone', () => {
        useAudioSettingsStore.setState({ volume: 0.5, isMuted: false });
        useAudioSettingsStore.getState().handleSetMuted(true);
        expect(useAudioSettingsStore.getState()).toMatchObject({ isMuted: true, volume: 0.5 });
        expect(storage.get('player_is_muted')).toBe('true');
    });

    it('writes nothing for the value already in effect', () => {
        useAudioSettingsStore.setState({ isMuted: true });
        useAudioSettingsStore.getState().handleSetMuted(true);
        expect(storage.has('player_is_muted')).toBe(false);
    });

    it('backs the toggle, which still flips and persists', () => {
        useAudioSettingsStore.setState({ isMuted: false });
        useAudioSettingsStore.getState().handleToggleMute();
        expect(useAudioSettingsStore.getState().isMuted).toBe(true);
        expect(storage.get('player_is_muted')).toBe('true');
        useAudioSettingsStore.getState().handleToggleMute();
        expect(useAudioSettingsStore.getState().isMuted).toBe(false);
        expect(storage.get('player_is_muted')).toBe('false');
    });
});

describe('handleSetLoopMode', () => {
    it('sets, persists and toasts the new mode', () => {
        useAudioSettingsStore.setState({ loopMode: 'off' });
        useAudioSettingsStore.getState().handleSetLoopMode('one');
        expect(useAudioSettingsStore.getState().loopMode).toBe('one');
        expect(storage.get('player_loop_mode')).toBe('one');
        expect(useStatusMessageStore.getState().message).toMatchObject({
            type: 'success',
            text: i18n.t('player.loopOne'),
            nonce: expect.any(Number),
        });
    });

    it('writes and toasts nothing for the mode already in effect', () => {
        useAudioSettingsStore.setState({ loopMode: 'all' });
        useAudioSettingsStore.getState().handleSetLoopMode('all');
        expect(storage.has('player_loop_mode')).toBe(false);
        expect(useStatusMessageStore.getState().message).toBeNull();
    });

    // 四态：顺序 → 列表循环 → 单曲循环 → 随机 → 回到顺序。随机放最后：它是这一圈里唯一会重排队列的模式。
    it('backs the toggle, which still cycles off, all, one, shuffle and toasts each step', () => {
        useAudioSettingsStore.setState({ loopMode: 'off' });
        const seen: [string, string | undefined][] = [];
        for (let press = 0; press < 4; press += 1) {
            useAudioSettingsStore.getState().handleToggleLoopMode();
            seen.push([useAudioSettingsStore.getState().loopMode, useStatusMessageStore.getState().message?.text]);
        }
        expect(seen).toEqual([
            ['all', i18n.t('player.loopAll')],
            ['one', i18n.t('player.loopOne')],
            ['shuffle', i18n.t('player.loopShuffle')],
            ['off', i18n.t('player.loopOff')],
        ]);
        expect(storage.get('player_loop_mode')).toBe('off');
    });
});

// One three-way control, not two independent switches: every choice writes both keys and both
// fields in a single store update, so there is never a frame with both modes on together. That
// in-between state is what used to leave the player on the wrong source with no sound when going
// from vocals-only to instrumental. The native swap itself is covered by VocalTrackSwitchTest.kt.
describe('handleSetVocalMode', () => {
    const keys = () => [storage.get(VOCAL_CANCEL_KEY), storage.get(VOCAL_ONLY_KEY)];

    it('all clears both keys and fields and returns to idle', () => {
        useAudioSettingsStore.getState().handleSetVocalMode('instrumental');
        useAudioSettingsStore.getState().handleSetVocalMode('off');
        expect(useAudioSettingsStore.getState()).toMatchObject({
            vocalCancelEnabled: false,
            vocalOnlyEnabled: false,
            vocalCancelState: 'idle',
            vocalCancelPercent: 0,
        });
        expect(keys()).toEqual(['false', 'false']);
    });

    it('vocal turns on vocals-only and clears the instrumental half', () => {
        useAudioSettingsStore.getState().handleSetVocalMode('vocal');
        expect(useAudioSettingsStore.getState()).toMatchObject({
            vocalCancelEnabled: false,
            vocalOnlyEnabled: true,
            vocalCancelState: 'building',
        });
        expect(keys()).toEqual(['false', 'true']);
    });

    it('instrumental turns on the instrumental and clears the vocals-only half', () => {
        useAudioSettingsStore.getState().handleSetVocalMode('instrumental');
        expect(useAudioSettingsStore.getState()).toMatchObject({
            vocalCancelEnabled: true,
            vocalOnlyEnabled: false,
            vocalCancelState: 'building',
        });
        expect(keys()).toEqual(['true', 'false']);
    });

    it('each choice is one atomic store update, never both modes on', () => {
        const seen: Array<[boolean, boolean]> = [];
        const stop = useAudioSettingsStore.subscribe(state => {
            seen.push([state.vocalCancelEnabled, state.vocalOnlyEnabled]);
        });
        useAudioSettingsStore.getState().handleSetVocalMode('vocal');
        useAudioSettingsStore.getState().handleSetVocalMode('instrumental');
        stop();
        expect(seen).toEqual([
            [false, true],
            [true, false],
        ]);
    });

    // The reported failure: 只留人声 → 关闭人声 left no sound. The web side must land on the
    // instrumental half in one step, without leaving the vocals-only track still selected.
    it('vocals-only to instrumental lands on the backing in one step', () => {
        useAudioSettingsStore.getState().handleSetVocalMode('vocal');
        expect(useAudioSettingsStore.getState()).toMatchObject({ vocalCancelEnabled: false, vocalOnlyEnabled: true });
        useAudioSettingsStore.getState().handleSetVocalMode('instrumental');
        expect(useAudioSettingsStore.getState()).toMatchObject({ vocalCancelEnabled: true, vocalOnlyEnabled: false });
        expect(keys()).toEqual(['true', 'false']);
    });
});

// The 存储 page's master switch: on by default (the separation is done ahead of time, so switching
// between vocals and instrumental is instant), persisted on its own key, and independent of the
// vocal-mode switches. jsdom is not Android, so no native call happens.
describe('handleTogglePrebuildTracks', () => {
    it('is on by default', () => {
        expect(useAudioSettingsStore.getState().prebuildTracksEnabled).toBe(true);
        // Nothing written until the listener touches it: the default lives in the code, not in storage.
        expect(storage.get(PREBUILD_TRACKS_KEY)).toBeUndefined();
    });

    it('persists and exposes the switch', () => {
        // Off first: it already starts on, and setting the same value is deliberately a no-op.
        useAudioSettingsStore.getState().handleTogglePrebuildTracks(false);
        useAudioSettingsStore.getState().handleTogglePrebuildTracks(true);
        expect(useAudioSettingsStore.getState().prebuildTracksEnabled).toBe(true);
        expect(storage.get(PREBUILD_TRACKS_KEY)).toBe('true');
    });

    it('turns back off', () => {
        const state = useAudioSettingsStore.getState();
        state.handleTogglePrebuildTracks(true);
        state.handleTogglePrebuildTracks(false);
        expect(useAudioSettingsStore.getState().prebuildTracksEnabled).toBe(false);
        expect(storage.get(PREBUILD_TRACKS_KEY)).toBe('false');
    });

    it('leaves the vocal-mode keys alone', () => {
        useAudioSettingsStore.getState().handleSetVocalMode('vocal');
        const before = [storage.get(VOCAL_CANCEL_KEY), storage.get(VOCAL_ONLY_KEY)];
        useAudioSettingsStore.getState().handleTogglePrebuildTracks(true);
        expect([storage.get(VOCAL_CANCEL_KEY), storage.get(VOCAL_ONLY_KEY)]).toEqual(before);
    });

    it('the same value is a no-op', () => {
        // Starts on, so turn it off first: the two `false`s below are the pair being compared.
        useAudioSettingsStore.getState().handleTogglePrebuildTracks(false);
        const seen: boolean[] = [];
        const stop = useAudioSettingsStore.subscribe(state => seen.push(state.prebuildTracksEnabled));
        useAudioSettingsStore.getState().handleTogglePrebuildTracks(false);
        useAudioSettingsStore.getState().handleTogglePrebuildTracks(false);
        stop();
        expect(seen).toEqual([]);
    });
});
