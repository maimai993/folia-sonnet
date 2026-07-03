import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importFolder, resyncFolder } from '@/services/localMusicService';
import {
    deleteDirHandle,
    deleteLocalLibrarySnapshot,
    deleteLocalSong,
    deleteLocalSongs,
    getDirHandles,
    getFromCache,
    getLocalLibrarySnapshot,
    getLocalSongs,
    saveDirHandles,
    saveLocalLibrarySnapshot,
    saveLocalSong,
    saveLocalSongs,
    saveToCache,
} from '@/services/db';
import type { LocalSong } from '@/types';

// test/unit/services/localMusicService.test.ts
// Covers local folder import root reuse and subfolder resync routing.

vi.mock('@/services/db', () => ({
    deleteDirHandle: vi.fn(),
    deleteLocalLibrarySnapshot: vi.fn(),
    deleteLocalSong: vi.fn(),
    deleteLocalSongs: vi.fn(),
    getDirHandles: vi.fn(),
    getFromCache: vi.fn(),
    getLocalLibrarySnapshot: vi.fn(),
    getLocalSongs: vi.fn(),
    saveDirHandles: vi.fn(),
    saveLocalLibrarySnapshot: vi.fn(),
    saveLocalSong: vi.fn(),
    saveLocalSongs: vi.fn(),
    saveToCache: vi.fn(),
}));

class FakeFileHandle {
    kind = 'file' as const;
    name: string;
    private readonly file: File;

    constructor(name: string, options: { content?: string; lastModified?: number; type?: string; } = {}) {
        this.name = name;
        this.file = new File([options.content ?? 'audio'], name, {
            type: options.type ?? 'audio/mpeg',
            lastModified: options.lastModified ?? 1000,
        });
    }

    async getFile() {
        return this.file;
    }
}

class FakeDirectoryHandle {
    kind = 'directory' as const;
    private readonly entries: Array<FakeDirectoryHandle | FakeFileHandle>;

    constructor(
        public name: string,
        entries: Array<FakeDirectoryHandle | FakeFileHandle> = [],
        private readonly sameEntryToken = name
    ) {
        this.entries = entries;
    }

    async *values() {
        for (const entry of this.entries) {
            yield entry;
        }
    }

    async getDirectoryHandle(name: string) {
        const entry = this.entries.find(item => item.kind === 'directory' && item.name === name);
        if (!entry || entry.kind !== 'directory') {
            throw new Error(`Missing directory ${name}`);
        }
        return entry;
    }

    async getFileHandle(name: string) {
        const entry = this.entries.find(item => item.kind === 'file' && item.name === name);
        if (!entry || entry.kind !== 'file') {
            throw new Error(`Missing file ${name}`);
        }
        return entry;
    }

    async queryPermission() {
        return 'granted' as PermissionState;
    }

    async requestPermission() {
        return 'granted' as PermissionState;
    }

    async isSameEntry(other: FileSystemHandle) {
        return other instanceof FakeDirectoryHandle && other.sameEntryToken === this.sameEntryToken;
    }
}

const createLibraryHandle = (token = 'library-root') => new FakeDirectoryHandle('Music', [
    new FakeDirectoryHandle('Disc 1', [
        new FakeFileHandle('Track 01.mp3'),
    ], `${token}:disc-1`),
], token);

describe('localMusicService', () => {
    beforeEach(() => {
        vi.mocked(deleteDirHandle).mockReset();
        vi.mocked(deleteLocalLibrarySnapshot).mockReset();
        vi.mocked(deleteLocalSong).mockReset();
        vi.mocked(deleteLocalSongs).mockReset();
        vi.mocked(getDirHandles).mockReset();
        vi.mocked(getFromCache).mockReset();
        vi.mocked(getLocalLibrarySnapshot).mockReset();
        vi.mocked(getLocalSongs).mockReset();
        vi.mocked(saveDirHandles).mockReset();
        vi.mocked(saveLocalLibrarySnapshot).mockReset();
        vi.mocked(saveLocalSong).mockReset();
        vi.mocked(saveLocalSongs).mockReset();
        vi.mocked(saveToCache).mockReset();

        vi.mocked(getLocalSongs).mockResolvedValue([]);
        vi.mocked(getLocalLibrarySnapshot).mockResolvedValue(null);
        vi.mocked(saveDirHandles).mockResolvedValue(undefined);
        vi.mocked(saveLocalSongs).mockResolvedValue(undefined);
        vi.mocked(saveLocalLibrarySnapshot).mockResolvedValue(undefined);
        vi.mocked(getFromCache).mockResolvedValue([]);

        vi.stubGlobal('window', {
            showDirectoryPicker: vi.fn(),
            dispatchEvent: vi.fn(),
        });
        vi.stubGlobal('CustomEvent', class {
            constructor(public type: string, public init?: CustomEventInit) {}
        });
    });

    it('rescans the existing root when the same folder is imported again', async () => {
        const persistedHandle = createLibraryHandle();
        const selectedHandle = createLibraryHandle();
        vi.mocked(getDirHandles).mockResolvedValue({ Music: persistedHandle as unknown as FileSystemDirectoryHandle });
        vi.mocked((window as any).showDirectoryPicker).mockResolvedValue(selectedHandle as unknown as FileSystemDirectoryHandle);

        const importedSongs = await importFolder();

        expect(importedSongs).toHaveLength(1);
        expect(saveDirHandles).toHaveBeenCalledWith({ Music: selectedHandle });
        expect(saveLocalLibrarySnapshot).toHaveBeenCalledWith(expect.objectContaining({ rootFolderName: 'Music' }));
        expect(saveLocalSongs).toHaveBeenCalledWith([
            expect.objectContaining<Partial<LocalSong>>({
                filePath: 'Music/Disc 1/Track 01.mp3',
                folderName: 'Music/Disc 1',
            }),
        ]);
    });

    it('routes a child-folder resync through the imported root handle', async () => {
        const persistedHandle = createLibraryHandle();
        vi.mocked(getDirHandles).mockResolvedValue({ Music: persistedHandle as unknown as FileSystemDirectoryHandle });

        const importedSongs = await resyncFolder('Music/Disc 1');

        expect(importedSongs).toHaveLength(1);
        expect((window as any).showDirectoryPicker).not.toHaveBeenCalled();
        expect(saveDirHandles).toHaveBeenCalledWith({ Music: persistedHandle });
        expect(saveLocalLibrarySnapshot).toHaveBeenCalledWith(expect.objectContaining({ rootFolderName: 'Music' }));
        expect(saveLocalSongs).toHaveBeenCalledWith([
            expect.objectContaining<Partial<LocalSong>>({
                filePath: 'Music/Disc 1/Track 01.mp3',
                folderName: 'Music/Disc 1',
            }),
        ]);
    });
});
