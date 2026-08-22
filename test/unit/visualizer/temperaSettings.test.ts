import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TEMPERA_LAYER_IMAGE, DEFAULT_TEMPERA_TUNING, TEMPERA_MAX_LAYER_IMAGES } from '@/types';
import { useSettingsUiStore } from '@/stores/useSettingsUiStore';

// test/unit/visualizer/temperaSettings.test.ts
// Verifies the Tempera canvas-image pool at the store boundary. Those records arrive from
// localStorage, sync and pasted appearance codes alike, so every field has to be clamped
// rather than trusted - a bad scale would blow the user's artwork off screen.
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

const setImages = (images: unknown) => {
    useSettingsUiStore.getState().handleSetTemperaTuning({ layerImages: images as never });
    return useSettingsUiStore.getState().temperaTuning.layerImages;
};

describe('Tempera canvas images', () => {
    let storage: Storage;

    beforeEach(() => {
        storage = createLocalStorageMock();
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
        useSettingsUiStore.setState({ temperaTuning: { ...DEFAULT_TEMPERA_TUNING, layerImages: [] } });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('starts empty and accepts a well-formed pool entry', () => {
        expect(DEFAULT_TEMPERA_TUNING.layerImages).toEqual([]);
        const images = setImages([{ id: 'a', name: 'art.png', align: 'left', scale: 0.9, opacity: 0.8 }]);
        expect(images).toHaveLength(1);
        expect(images[0]).toEqual({ id: 'a', name: 'art.png', align: 'left', scale: 0.9, opacity: 0.8 });
    });

    it('clamps scale and opacity into range', () => {
        const [image] = setImages([{ id: 'a', name: 'art.png', scale: 99, opacity: 12 }]);
        expect(image.scale).toBeLessThanOrEqual(2);
        expect(image.opacity).toBe(1);
    });

    it('drops entries that carry no id and falls back on bad fields', () => {
        const images = setImages([
            { name: 'no-id.png' },
            null,
            'nonsense',
            { id: 'b', scale: 'huge', align: 'sideways' },
        ]);
        expect(images).toHaveLength(1);
        expect(images[0].id).toBe('b');
        expect(images[0].name).toBe('b');
        expect(images[0].scale).toBe(DEFAULT_TEMPERA_LAYER_IMAGE.scale);
        // An unknown alignment must resolve to a known tendency, not be passed through.
        expect(images[0].align).toBe(DEFAULT_TEMPERA_LAYER_IMAGE.align);
    });

    it('caps the number of placements and survives a non-array', () => {
        expect(setImages(Array.from({ length: 30 }, (_, index) => ({ id: `i${index}`, name: 'x' }))))
            .toHaveLength(TEMPERA_MAX_LAYER_IMAGES);
        expect(setImages('not an array')).toEqual([]);
    });
});
