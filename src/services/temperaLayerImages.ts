import type { TemperaLayerImage } from '../types';
import {
    buildStoredVisualizerImageAsset,
    clearStoredVisualizerImageAsset,
    getStoredVisualizerImageAsset,
    isSupportedVisualizerImageFile,
    saveStoredVisualizerImageAsset,
} from './visualizerImageAsset';

// src/services/temperaLayerImages.ts
// Persists the user's Tempera canvas images in IndexedDB, one record per image. The tuning
// only carries ids and placement, so it stays small enough to sync; the blobs stay here.
export interface StoredTemperaLayerImage {
    id: string;
    name: string;
    mimeType: string;
    blob: Blob;
}

const keyFor = (id: string) => `tempera_layer_image_${id}`;

export const isSupportedTemperaLayerImageFile = isSupportedVisualizerImageFile;

export const getTemperaLayerImage = async (id: string) => (
    getStoredVisualizerImageAsset<StoredTemperaLayerImage>(keyFor(id))
);

export const saveTemperaLayerImage = async (image: StoredTemperaLayerImage) => {
    await saveStoredVisualizerImageAsset(keyFor(image.id), image);
};

export const clearTemperaLayerImage = async (id: string) => {
    await clearStoredVisualizerImageAsset(keyFor(id));
};

export const buildStoredTemperaLayerImage = (file: File) => (
    buildStoredVisualizerImageAsset<StoredTemperaLayerImage>(file)
);

/**
 * Resolves placed images to their stored blobs, skipping any whose file has gone missing.
 * Blobs rather than object URLs on purpose: Pixi's `Assets` loader picks a parser from the
 * URL's file extension and a `blob:` URL has none, so it refuses to load one. The renderer
 * decodes these directly instead, which also removes any URL lifetime to manage.
 */
export const loadTemperaLayerImageBlobs = async (
    placements: TemperaLayerImage[],
): Promise<Map<string, Blob>> => {
    const blobs = new Map<string, Blob>();
    await Promise.all(placements.map(async placement => {
        const stored = await getTemperaLayerImage(placement.id).catch(() => null);
        if (stored?.blob) blobs.set(placement.id, stored.blob);
    }));
    return blobs;
};
