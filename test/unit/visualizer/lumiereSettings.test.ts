import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LUMIERE_TUNING, type LumiereTuning } from '@/types';
import { normalizeLumiereTuning } from '@/utils/lumiereTuning';
import { compressConfig, decompressConfig } from '@/utils/appearanceCodec';
import { useVisualizerSettingsStore } from '@/stores/useVisualizerSettingsStore';

// test/unit/visualizer/lumiereSettings.test.ts
// Verifies 绘光 tuning normalization, its appearance short-code round trip and the store setter/reset.
const createLocalStorageMock = (): Storage => {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        getItem: key => values.get(key) ?? null,
        key: index => Array.from(values.keys())[index] ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
        clear: () => values.clear(),
    };
};

const NON_DEFAULT_TUNING: LumiereTuning = {
    lightIntensity: 1.6,
    audioResponse: 0,
    fogDensity: 0.4,
    moteAmount: 1.8,
    bloom: 0.3,
    textBloom: 1.5,
    unlitOpacity: 0.4,
    windowNeighbors: 1,
    decay: 0.2,
    echo: 0,
    fogOctaves: 3,
    lineArt: false,
    frontBokeh: false,
    trails: true,
    overlayFrame: false,
    keywordColors: false,
    themeIcons: false,
    renderQuality: 'balanced',
};

describe('normalizeLumiereTuning', () => {
    it('returns defaults for non-object input', () => {
        expect(normalizeLumiereTuning(undefined)).toEqual(DEFAULT_LUMIERE_TUNING);
        expect(normalizeLumiereTuning('nope')).toEqual(DEFAULT_LUMIERE_TUNING);
        expect(normalizeLumiereTuning(null)).toEqual(DEFAULT_LUMIERE_TUNING);
    });

    it('keeps a valid tuning unchanged', () => {
        expect(normalizeLumiereTuning(NON_DEFAULT_TUNING)).toEqual(NON_DEFAULT_TUNING);
    });

    it('clamps ranges, rounds octaves and rejects bad enums', () => {
        const normalized = normalizeLumiereTuning({
            lightIntensity: 0,
            audioResponse: 9,
            unlitOpacity: 0.9,
            fogOctaves: 4.6,
            windowNeighbors: 3,
            renderQuality: 'ultra',
            lineArt: 'yes',
            decay: Number.NaN,
        });
        expect(normalized.lightIntensity).toBe(0.3);
        expect(normalized.audioResponse).toBe(2);
        expect(normalized.unlitOpacity).toBe(0.6);
        expect(normalized.fogOctaves).toBe(5);
        expect(normalized.windowNeighbors).toBe(DEFAULT_LUMIERE_TUNING.windowNeighbors);
        expect(normalized.renderQuality).toBe(DEFAULT_LUMIERE_TUNING.renderQuality);
        expect(normalized.lineArt).toBe(DEFAULT_LUMIERE_TUNING.lineArt);
        expect(normalized.decay).toBe(DEFAULT_LUMIERE_TUNING.decay);
        expect(normalizeLumiereTuning({ fogOctaves: 12 }).fogOctaves).toBe(6);
        expect(normalizeLumiereTuning({ fogOctaves: 0 }).fogOctaves).toBe(2);
    });
});

describe('Lumiere appearance codec', () => {
    it('round-trips every Lumiere tuning field through the short code', () => {
        const decoded = decompressConfig(compressConfig({ lumiereTuning: NON_DEFAULT_TUNING }));
        expect(decoded.lumiereTuning).toEqual(NON_DEFAULT_TUNING);
    });

    it('accepts lumiereTuning as a valid JSON config key', () => {
        const decoded = decompressConfig(JSON.stringify({ lumiereTuning: NON_DEFAULT_TUNING }));
        expect(decoded.lumiereTuning).toEqual(NON_DEFAULT_TUNING);
    });
});

describe('Lumiere store tuning', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('normalizes patches, persists them and resets to defaults', () => {
        const storage = createLocalStorageMock();
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
        useVisualizerSettingsStore.setState({ lumiereTuning: { ...DEFAULT_LUMIERE_TUNING } });

        useVisualizerSettingsStore.getState().handleSetLumiereTuning({ renderQuality: 'low', unlitOpacity: 5 });
        const next = useVisualizerSettingsStore.getState().lumiereTuning;
        expect(next.renderQuality).toBe('low');
        expect(next.unlitOpacity).toBe(0.6);
        expect(JSON.parse(storage.getItem('lumiere_tuning') ?? '{}').renderQuality).toBe('low');

        useVisualizerSettingsStore.getState().handleResetLumiereTuning();
        expect(useVisualizerSettingsStore.getState().lumiereTuning).toEqual(DEFAULT_LUMIERE_TUNING);
    });
});
