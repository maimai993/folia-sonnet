// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stores read localStorage at import time; see audioSettingsSetters.test.ts.
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

const native = vi.hoisted(() => ({ writeNativeSettings: vi.fn(async () => null) }));
vi.mock('@/services/nativeSettingsBridge', () => ({ writeNativeSettings: native.writeNativeSettings }));

import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';

// test/unit/stores/backgroundSilentSkip.test.ts
// 后台自动静默跳过：默认开，按 background_silent_skip 持久化，并把开关推给原生设置。

const initialAudio = useAudioSettingsStore.getState();

beforeEach(() => {
    useAudioSettingsStore.setState(initialAudio, true);
    storage.clear();
    native.writeNativeSettings.mockClear();
});

describe('backgroundSilentSkip', () => {
    it('defaults to on', () => {
        expect(useAudioSettingsStore.getState().backgroundSilentSkip).toBe(true);
    });

    it('persists the switch under background_silent_skip and pushes it to native settings', () => {
        useAudioSettingsStore.getState().handleToggleBackgroundSilentSkip(false);

        expect(useAudioSettingsStore.getState().backgroundSilentSkip).toBe(false);
        expect(storage.get('background_silent_skip')).toBe('false');
        expect(native.writeNativeSettings).toHaveBeenCalledWith({ backgroundSilentSkip: false });

        useAudioSettingsStore.getState().handleToggleBackgroundSilentSkip(true);

        expect(useAudioSettingsStore.getState().backgroundSilentSkip).toBe(true);
        expect(storage.get('background_silent_skip')).toBe('true');
        expect(native.writeNativeSettings).toHaveBeenLastCalledWith({ backgroundSilentSkip: true });
    });
});
