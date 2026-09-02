import { strFromU8, strToU8, unzip, unzipSync, zip, type AsyncZippable, type Unzipped } from 'fflate';
import { TEMPERA_MAX_LAYER_IMAGES, type TemperaLayerImage } from '../types';
import {
    getTemperaLayerImage,
    prepareTemperaLayerImage,
    saveTemperaLayerImage,
    type StoredTemperaLayerImage,
} from './temperaLayerImages';

// src/services/temperaImageArchive.ts
// Moves the Tempera canvas-image pool in and out of a zip.
//
// The files themselves only ever live in IndexedDB keyed by `tempera_layer_image_${id}`; the
// tuning carries ids and placement, which is what makes it small enough to sync, and also what
// makes the pool invisible to every existing text export - a shortcode or a sync snapshot that
// carried the artwork would blow its own size budget. So the pool gets a binary sidecar: a zip
// holding the pool-wide settings plus the original bytes, rebuilt on import through the same
// `prepareTemperaLayerImage` path a drag-and-drop upload takes, thumbnails included.
//
// Compression and decompression run off-thread through fflate's async `zip`/`unzip`: the pool holds
// up to sixteen images at print resolution, and deflating tens of megabytes on the main thread is
// long enough to be visible as a stall in the lyric animation that is usually playing behind this
// dialog. fflate buffers each file into the worker rather than transferring it, so the pool is
// briefly held twice - the alternative is detaching the bytes the pool is still showing.

const ARCHIVE_KIND = 'folia-tempera-pool';
const SCHEMA_VERSION = 1;

// 解压后总大小上限。超过即视为损坏或压缩炸弹并拒绝导入，避免把整个 zip 一次性
// inflate 进内存（实测 51KB 的 zip 可产出 50MB 字节，令浏览器瞬间吃掉数百 MB）。
const TEMPERA_ARCHIVE_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 MB

/** 备份解压后预计超过上限时抛出，UI 据此显示警告并取消导入。 */
export class TemperaArchiveTooLargeError extends Error {
    constructor() {
        super('Tempera pool backup is too large to import');
        this.name = 'TemperaArchiveTooLargeError';
    }
}

/**
 * 只解析 zip 中央目录、对每条目的 originalSize 求和，不做任何解压：filter 始终返回
 * false，fflate 因此不会 inflate 任何条目。返回解压后的总字节数。
 */
const probeUncompressedSize = (bytes: Uint8Array): number => {
    let total = 0;
    unzipSync(bytes, {
        filter: file => {
            total += file.originalSize;
            return false;
        },
    });
    return total;
};

export interface TemperaImagePoolSnapshot {
    layerImages: TemperaLayerImage[];
    layerImageDepth: 'back' | 'front';
    layerImageFrequency: number;
}

export interface TemperaImageArchiveExportResult {
    blob: Blob;
    /** Placements whose bytes made it into the zip. */
    exported: number;
    /** Placements left out because their file was gone from IndexedDB. */
    skipped: number;
}

export interface TemperaImageArchiveImportResult {
    layerImages: TemperaLayerImage[];
    layerImageDepth: 'back' | 'front';
    layerImageFrequency: number;
    /** Files that were skipped because they were not images the pool accepts. */
    skipped: number;
    /** Files dropped because the pool was already full. */
    truncated: number;
}

const EXTENSION_BY_MIME: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
};

const encodeJson = (value: unknown) => strToU8(JSON.stringify(value, null, 2));

/**
 * Rebuilds the on-disk name of an entry. The id already embeds the original file name
 * (including its extension, e.g. `12345-photo.png`), so the entry is exactly `images/${id}`
 * with no extra suffix appended.
 */
const entryPath = (image: { id: string }) => `images/${image.id}`;

const readJsonEntry = (files: Unzipped, path: string): unknown => {
    const file = files[path];
    if (!file) throw new Error(`Tempera pool zip is missing ${path}`);
    return JSON.parse(strFromU8(file));
};

const asDepth = (value: unknown): 'back' | 'front' => (value === 'front' ? 'front' : 'back');

const asFrequency = (value: unknown) => (
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
);

/**
 * Runs fflate's async entry points as promises. Both hand back a terminator that nothing calls:
 * a cancelled export leaves the worker to finish and be collected, which is cheaper than tracking
 * the operation through the dialog's close path.
 */
const runZip = (files: AsyncZippable): Promise<Uint8Array<ArrayBuffer>> => new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data)));
});

const runUnzip = (bytes: Uint8Array): Promise<Unzipped> => new Promise((resolve, reject) => {
    unzip(bytes, (error, files) => (error ? reject(error) : resolve(files)));
});

/**
 * Reads the whole pool - settings and files - into a zip. Entries whose file has gone
 * missing are dropped from the manifest instead of producing a zip with holes in it: importing
 * that back would restore placements that can never resolve to a picture. The two counts are
 * returned because a backup that silently holds fewer pictures than the pool shows is worse than
 * one that says so at the moment it is taken.
 */
export const createTemperaImageArchive = async (
    snapshot: TemperaImagePoolSnapshot,
): Promise<TemperaImageArchiveExportResult> => {
    const files: Record<string, Uint8Array> = {};
    const keptIds = new Set<string>();

    await Promise.all(snapshot.layerImages.map(async image => {
        const stored = await getTemperaLayerImage(image.id).catch(() => null);
        if (!stored?.blob) return;
        files[entryPath(image)] = new Uint8Array(await stored.blob.arrayBuffer());
        keptIds.add(image.id);
    }));

    // Order matters: the pool is rendered in array order and the pool-wide depth/frequency are
    // restored alongside it, so the zip replays the same pool rather than a shuffled one.
    const ordered = snapshot.layerImages.filter(image => keptIds.has(image.id));
    files['pool.json'] = encodeJson({
        layerImages: ordered,
        layerImageDepth: snapshot.layerImageDepth,
        layerImageFrequency: snapshot.layerImageFrequency,
    });
    files['meta.json'] = encodeJson({
        kind: ARCHIVE_KIND,
        schemaVersion: SCHEMA_VERSION,
        imageCount: ordered.length,
    });

    return {
        blob: new Blob([await runZip(files)], { type: 'application/zip' }),
        exported: ordered.length,
        skipped: snapshot.layerImages.length - ordered.length,
    };
};

const collectEntries = (
    files: Unzipped,
    manifest: TemperaLayerImage[],
): Array<{ image: TemperaLayerImage; bytes: Uint8Array; mimeType: string }> => {
    const paths = Object.keys(files);
    const entries: Array<{ image: TemperaLayerImage; bytes: Uint8Array; mimeType: string }> = [];
    manifest.forEach(image => {
        const prefix = `images/${image.id}`;
        const path = paths.find(name => name === prefix);
        if (!path) return;
        const bytes = files[path];
        if (!bytes) return;
        const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const mimeType = Object.entries(EXTENSION_BY_MIME)
            .find(([, value]) => value === extension)?.[0] ?? 'application/octet-stream';
        entries.push({ image, bytes, mimeType });
    });
    return entries;
};

/**
 * Restores a pool from a zip. Rebuilds those bytes through `prepareTemperaLayerImage`
 * instead of storing them as-is, so an import arrives in exactly the state a fresh drag-and-drop
 * would leave it in - thumbnails and all - and so the shape is validated on the way in.
 */
export const readTemperaImageArchiveFile = async (
    file: File,
    options: { existing: TemperaLayerImage[]; maxImages?: number },
): Promise<TemperaImageArchiveImportResult> => {
    const maxImages = options.maxImages ?? TEMPERA_MAX_LAYER_IMAGES;
    const bytes = new Uint8Array(await file.arrayBuffer());

    // 解压前先判断总体积：中央目录里声明的解压后大小之和超过阈值就直接拒绝，
    // 这样永远不会把整个 zip inflate 进内存。
    if (probeUncompressedSize(bytes) > TEMPERA_ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
        throw new TemperaArchiveTooLargeError();
    }

    const files = await runUnzip(bytes);
    const meta = readJsonEntry(files, 'meta.json') as { kind?: unknown; schemaVersion?: unknown } | null;
    if (!meta || meta.kind !== ARCHIVE_KIND || meta.schemaVersion !== SCHEMA_VERSION) {
        throw new Error('Not a Folia canvas-image backup');
    }

    const pool = readJsonEntry(files, 'pool.json') as {
        layerImages?: unknown;
        layerImageDepth?: unknown;
        layerImageFrequency?: unknown;
    };
    const manifest = Array.isArray(pool.layerImages) ? pool.layerImages as TemperaLayerImage[] : [];
    const entries = collectEntries(files, manifest);
    const existingIds = new Set(options.existing.map(image => image.id));
    // Files named by the manifest but absent from the archive: a backup edited by hand, or one
    // that lost entries to a partial write. Counted rather than thrown so the rest still imports.
    let skipped = manifest.length - entries.length;
    let truncated = 0;

    const layerImages: TemperaLayerImage[] = [];
    for (let index = 0; index < entries.length; index += 1) {
        // A pool-size change means an older backup can hold more entries than fit now; those are
        // dropped rather than silently overflowing the pool. Counted off the loop index rather
        // than `entries.indexOf(entry)`: indexOf matches by object identity, so it only reports
        // the right position while `collectEntries` happens to mint a fresh object per row - and
        // the tail it names is the resolvable entries, not the manifest rows, which is the number
        // the user is actually missing.
        if (layerImages.length + options.existing.length >= maxImages) {
            truncated = entries.length - index;
            break;
        }

        const entry = entries[index];
        // The id travelled with the file, so importing the same backup twice would have the
        // second copy overwrite the first in IndexedDB instead of sitting next to it. A colliding
        // id is therefore minted afresh, leaving the existing record untouched.
        const source = new File(
            [new Uint8Array(entry.bytes) as unknown as BlobPart],
            entry.image.name || 'image',
            { type: entry.mimeType },
        );
        const prepared = await prepareTemperaLayerImage(source);
        const id = !existingIds.has(prepared.id) && !layerImages.some(image => image.id === prepared.id)
            ? prepared.id
            : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${prepared.name}`;
        const stored: StoredTemperaLayerImage = { ...prepared, id };
        await saveTemperaLayerImage(stored);
        layerImages.push({ ...entry.image, id, name: stored.name || entry.image.name });
        existingIds.add(id);
    }

    return {
        layerImages,
        layerImageDepth: asDepth(pool.layerImageDepth),
        layerImageFrequency: asFrequency(pool.layerImageFrequency),
        skipped,
        truncated,
    };
};
