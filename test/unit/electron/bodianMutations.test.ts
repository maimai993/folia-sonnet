import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/bodianMutations.test.ts

const require = createRequire(import.meta.url);
const { createMutationOperations } = require('../../../electron/bodian/mutations.cjs');
const setup = () => {
    const sessions = { revision: 0, get: () => ({ uid: '123' }) };
    const client = { call: vi.fn().mockResolvedValue({ data: { playLists: [{ id: 456 }] } }) };
    return { client, sessions, operations: createMutationOperations({ client, sessions }) };
};

describe('Bodian playlist mutations', () => {
    it.each([['playlist_tracks_add', '/api/service/playlist/music'], ['playlist_tracks_del', '/api/service/playlist/music/delete']])
        ('checks ownership and signs %s', async (operation, endpoint) => {
            const { client, operations } = setup();
            await operations[operation]({ id: '456', trackIds: '789,789', userId: 'attacker' });
            expect(client.call.mock.calls).toEqual([
                ['/api/service/playlist/userCreate', { params: { userId: '123' } }],
                [endpoint, { method: 'POST', signed: true, body: { playListId: 456, musicIdList: [789] } }],
            ]);
        });
    it('does not write to a playlist owned by another account', async () => {
        const { client, operations } = setup();
        await expect(operations.playlist_tracks_add({ id: '999', trackIds: '789' })).rejects.toMatchObject({ code: 'unsupported' });
        expect(client.call).toHaveBeenCalledTimes(2);
    });
    it('accepts the current account built-in liked playlist after fond lookup', async () => {
        const { client, operations } = setup();
        client.call.mockResolvedValueOnce({ data: { playLists: [] } })
            .mockResolvedValueOnce({ data: { id: 999 } });
        await operations.playlist_tracks_add({ id: '999', trackIds: '789' });
        expect(client.call.mock.calls[2][1].body.playListId).toBe(999);
    });
    it('rejects a changed account between ownership lookup and mutation', async () => {
        const { client, sessions, operations } = setup();
        client.call.mockImplementationOnce(async () => {
            sessions.revision++;
            return { data: { playLists: [{ id: 456 }] } };
        });
        await expect(operations.playlist_tracks_add({ id: '456', trackIds: '789' })).rejects.toMatchObject({ code: 'auth-required' });
        expect(client.call).toHaveBeenCalledTimes(1);
    });
    it.each(['', '1,', '9007199254740992', '1,../2'])('rejects invalid tracks %s before networking', async trackIds => {
        const { client, operations } = setup();
        await expect(operations.playlist_tracks_add({ id: '456', trackIds })).rejects.toMatchObject({ code: 'invalid-response' });
        expect(client.call).not.toHaveBeenCalled();
    });
    it('resolves the current account liked playlist rather than accepting a renderer target', async () => {
        const { client, operations } = setup();
        client.call.mockResolvedValueOnce({ data: { id: 456 } });
        await operations.like_song({ id: '789', liked: true, playlistId: '999' });
        expect(client.call.mock.calls[1][1].body.playListId).toBe(456);
    });
});
