import { describe, expect, it } from 'vitest';
import type { LocalSong } from '../../../src/types';
import type { LocalLibraryEntity } from '../../../src/types/localLibrary';
import {
    buildEntityNameSuggestions,
    filterEntityMemberSongs,
    filterMergeEntitySuggestions,
} from '../../../src/components/local-library-entity/entityEditorModel';

// test/unit/localLibrary/localLibraryEntityEditorModel.test.ts
// Verifies the input suggestions and search behavior used by the entity editor.

const createSong = (id: string, overrides: Partial<LocalSong> = {}): LocalSong => ({
    id,
    fileName: `${id}.mp3`,
    filePath: `/music/${id}.mp3`,
    duration: 180_000,
    fileSize: 1_024,
    mimeType: 'audio/mpeg',
    addedAt: 1,
    ...overrides,
});

const createEntity = (
    id: string,
    displayName: string,
    overrides: Partial<LocalLibraryEntity> = {},
): LocalLibraryEntity => ({
    id,
    kind: 'artist',
    displayName,
    aliases: [],
    normalizedAliases: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
});

describe('local-library entity editor model', () => {
    it('builds ranked artist name suggestions without double-counting one song', () => {
        const suggestions = buildEntityNameSuggestions('artist', [
            createSong('one', {
                embeddedArtist: '小山百代/三森すずこ',
                manualArtistNames: ['小山百代'],
                matchedArtistEntities: [{ name: '三森すずこ' }],
            }),
            createSong('two', { embeddedArtist: '三森すずこ' }),
        ]);

        expect(suggestions).toEqual([
            { name: '三森すずこ', count: 2 },
            { name: '小山百代', count: 1 },
        ]);
    });

    it('searches merge candidates by display name and alias while excluding invalid targets', () => {
        const entities = [
            createEntity('current', '三森すずこ'),
            createEntity('duplicate', 'Mimori Suzuko', { aliases: ['みもりん'] }),
            createEntity('other', '小山百代'),
            createEntity('merged', '旧实体', { mergedInto: 'current' }),
            createEntity('prefix', 'みもりん候补'),
        ];

        expect(filterMergeEntitySuggestions(entities, 'current', 'みもりん'))
            .toEqual([entities[1], entities[4]]);
        const availableIds = filterMergeEntitySuggestions(entities, 'current', '').map(entity => entity.id);
        expect(availableIds).toHaveLength(3);
        expect(availableIds).toEqual(expect.arrayContaining(['duplicate', 'other', 'prefix']));
    });

    it('filters entity members using both visible metadata and file names', () => {
        const songs = [
            createSong('one', { title: 'RE:CREATE', artist: '三森すずこ' }),
            createSong('two', { fileName: 'fly-me-to-the-star.flac', album: '少女☆歌劇' }),
        ];

        expect(filterEntityMemberSongs(songs, 'create').map(song => song.id)).toEqual(['one']);
        expect(filterEntityMemberSongs(songs, 'fly-me').map(song => song.id)).toEqual(['two']);
    });
});
