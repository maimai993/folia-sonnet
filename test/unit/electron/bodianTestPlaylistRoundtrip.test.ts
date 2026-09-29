import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/bodianTestPlaylistRoundtrip.test.ts

const require = createRequire(import.meta.url);
const { testPlaylistRoundtrip } = require('../../helpers/bodianTestPlaylistRoundtrip.cjs');

function setup(initial: string[] = [], failAfterAdd = false) {
    let ids = [...initial];
    const client = { call: vi.fn(async (path: string, options: any) => {
        if (path.endsWith('/musicList')) return { data: { list: ids.map(id => ({ id })), total: ids.length } };
        expect(options.body).toEqual({ playListId: 123, musicIdList: [456] });
        if (path.endsWith('/delete')) ids = ids.filter(id => id !== '456');
        else {
            ids.push('456');
            if (failAfterAdd) throw new Error('Connection interrupted after server accepted add');
        }
        return { data: {} };
    }) };
    const library = { user_playlists: vi.fn().mockResolvedValue({ owned: { playLists: [{ id: 123, name: 'Test playlist' }] } }) };
    return { client, library, expectedName: 'Test playlist', songId: '456', ids: () => ids };
}

describe('dedicated test playlist roundtrip', () => {
    it('adds the test song and restores original membership', async () => {
        const deps = setup(['789']);
        expect(await testPlaylistRoundtrip(deps)).toEqual({ added: true, restored: true, originalCount: 1 });
        expect(deps.ids()).toEqual(['789']);
    });
    it('restores membership even if the add response is lost', async () => {
        const deps = setup(['789'], true);
        await expect(testPlaylistRoundtrip(deps)).rejects.toThrow('Connection interrupted');
        expect(deps.ids()).toEqual(['789']);
    });
    it('never removes an existing test song', async () => {
        const deps = setup(['456']);
        await expect(testPlaylistRoundtrip(deps)).rejects.toThrow('already exists');
        expect(deps.ids()).toEqual(['456']);
        expect(deps.client.call).toHaveBeenCalledTimes(1);
    });
    it('rejects a missing dedicated playlist before writing', async () => {
        const deps = setup();
        deps.expectedName = 'Different playlist';
        await expect(testPlaylistRoundtrip(deps)).rejects.toThrow('uniquely identified');
        expect(deps.client.call).not.toHaveBeenCalled();
    });
});
