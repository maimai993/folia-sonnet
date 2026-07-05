import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocalSongs, saveLocalSongs } from '../../../src/services/db';
import type { LocalSong } from '../../../src/types';

// test/unit/services/dbLocalSongCoverSanitization.test.ts
// Verifies that local song cover persistence never keeps non-Blob cover payloads.

type StoredRecord = Record<string, unknown> & { id: string };

class FakeObjectStore {
    constructor(private readonly records: Map<string, StoredRecord>) {}

    getAll() {
        const request: { onsuccess?: () => void; onerror?: () => void; result?: StoredRecord[]; error?: unknown } = {};
        queueMicrotask(() => {
            request.result = Array.from(this.records.values()).map(record => ({ ...record }));
            request.onsuccess?.();
        });
        return request;
    }

    put(record: StoredRecord) {
        this.records.set(record.id, { ...record });
    }
}

class FakeTransaction {
    oncomplete?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    error?: unknown;

    constructor(private readonly records: Map<string, StoredRecord>) {
        queueMicrotask(() => this.oncomplete?.());
    }

    objectStore() {
        return new FakeObjectStore(this.records);
    }
}

class FakeDatabase {
    objectStoreNames = { contains: () => true };

    constructor(private readonly records: Map<string, StoredRecord>) {}

    transaction() {
        return new FakeTransaction(this.records);
    }
}

const buildLocalSong = (patch: Partial<LocalSong> & Pick<LocalSong, 'id'>): LocalSong => ({
    id: patch.id,
    fileName: `${patch.id}.mp3`,
    filePath: `/music/${patch.id}.mp3`,
    duration: 180000,
    fileSize: 1024,
    mimeType: 'audio/mpeg',
    addedAt: 1,
    ...patch,
});

describe('db local song cover sanitization', () => {
    let records: Map<string, StoredRecord>;

    beforeEach(() => {
        records = new Map();
        vi.stubGlobal('indexedDB', {
            open: () => {
                const db = new FakeDatabase(records);
                const request: {
                    onsuccess?: (event: { target: { result: FakeDatabase } }) => void;
                    onerror?: () => void;
                    result?: FakeDatabase;
                    error?: unknown;
                } = { result: db };
                queueMicrotask(() => request.onsuccess?.({ target: { result: db } }));
                return request;
            },
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does not persist non-Blob embedded covers', async () => {
        await saveLocalSongs([
            buildLocalSong({
                id: 'bad-cover-song',
                embeddedCover: { size: 20, type: 'image/png' } as unknown as Blob,
            }),
        ]);

        expect(records.get('bad-cover-song')?.embeddedCover).toBeUndefined();
    });

    it('sanitizes non-Blob embedded covers when reading local songs and writes them back', async () => {
        records.set('bad-cover-song', {
            ...buildLocalSong({
                id: 'bad-cover-song',
                embeddedCover: { size: 20, type: 'image/png' } as unknown as Blob,
            }),
        } as unknown as StoredRecord);

        const songs = await getLocalSongs();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(songs[0]?.embeddedCover).toBeUndefined();
        expect(records.get('bad-cover-song')?.embeddedCover).toBeUndefined();
    });
});
