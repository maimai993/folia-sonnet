import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/bodianAuth.test.ts

const require = createRequire(import.meta.url);
const { createAuthOperations } = require('../../../electron/bodian/auth.cjs');
const setup = () => {
    const sessions = { revision: 0, get: vi.fn(), set: vi.fn(), clear: vi.fn() };
    const client = { call: vi.fn() };
    return { sessions, client, auth: createAuthOperations({ client, sessions }) };
};

describe('Bodian authentication protocol', () => {
    it('exchanges only a confirmed QR using authType 10', async () => {
        const { client, sessions, auth } = setup();
        client.call.mockResolvedValueOnce({ data: { qrCode: 'new-key' } })
            .mockResolvedValueOnce({ data: { status: 3 } })
            .mockResolvedValueOnce({ data: { id: 123, token: 'new-token', userInfo: { id: '123', nickname: 'Test' } } });
        await auth.login_qr_key();
        expect(await auth.login_qr_check({ key: 'new-key' })).toEqual({ state: 'confirmed' });
        expect(client.call.mock.calls[2][1].body).toEqual({ authType: 10, qrCode: 'new-key' });
        expect(sessions.set).toHaveBeenCalledWith({ uid: '123', token: 'new-token', user: { id: '123', nickname: 'Test', avatarUrl: '' } });
    });

    it('does not accept credentials from an unknown QR status', async () => {
        const { client, sessions, auth } = setup();
        client.call.mockResolvedValueOnce({ data: { qrCode: 'new-key' } })
            .mockResolvedValueOnce({ data: { status: 99, id: 123, token: 'untrusted' } });
        await auth.login_qr_key();
        await expect(auth.login_qr_check({ key: 'new-key' })).rejects.toMatchObject({ code: 'invalid-response' });
        expect(sessions.set).not.toHaveBeenCalled();
        expect(client.call).toHaveBeenCalledTimes(2);
    });

    it('rejects conflicting IDs in the exchanged response', async () => {
        const { client, sessions, auth } = setup();
        client.call.mockResolvedValueOnce({ data: { qrCode: 'new-key' } })
            .mockResolvedValueOnce({ data: { status: 3 } })
            .mockResolvedValueOnce({ data: { id: 123, token: 'untrusted', userInfo: { uid: 456 } } });
        await auth.login_qr_key();
        await expect(auth.login_qr_check({ key: 'new-key' })).rejects.toMatchObject({ code: 'invalid-response' });
        expect(sessions.set).not.toHaveBeenCalled();
    });

    it('returns the previously verified local identity without calling an unverified validation endpoint', async () => {
        const { client, sessions, auth } = setup();
        sessions.get.mockReturnValue({ uid: '123', token: 'stored-token', user: { id: '123', nickname: 'Test' } });
        expect(await auth.login_status()).toMatchObject({ id: '123', nickname: 'Test' });
        expect(client.call).not.toHaveBeenCalled();
    });

    it('clears an internally inconsistent saved identity', async () => {
        const { client, sessions, auth } = setup();
        sessions.get.mockReturnValue({ uid: '123', token: 'stored-token', user: { id: '456' } });
        await expect(auth.login_status()).rejects.toMatchObject({ code: 'auth-required' });
        expect(sessions.clear).toHaveBeenCalled();
    });
});
