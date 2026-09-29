import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/bodianIdentityCheck.test.ts

const require = createRequire(import.meta.url);
const { createIdentityCheck } = require('../../helpers/bodianIdentityCheck.cjs');

const setup = (login: unknown) => {
    const client = { call: vi.fn().mockResolvedValueOnce({ data: { qrCode: 'test-qr' } })
        .mockResolvedValueOnce({ data: { status: 3 } }).mockResolvedValueOnce({ data: login }) };
    return { client, check: createIdentityCheck({ client, expectedAccountId: '123' }) };
};

describe('isolated Bodian identity check', () => {
    it('requires an independent account ID before any request', () => {
        const client = { call: vi.fn() };
        for (const expectedAccountId of ['', '-1', 'abc', 9007199254740992]) {
            expect(() => createIdentityCheck({ client, expectedAccountId })).toThrow();
        }
        expect(client.call).not.toHaveBeenCalled();
    });

    it('uses the documented third-party QR flow and returns no credentials', async () => {
        const { check, client } = setup({ id: 123, userInfo: { id: '123' }, token: 'test-secret' });
        await check.start();
        const result = await check.poll();
        expect(result).toEqual({ state: 'identity-matched' });
        expect(client.call.mock.calls[2]).toEqual(['/api/ucenter/users/login', {
            anonymous: true, signed: true, method: 'POST', body: { authType: 10, qrCode: 'test-qr' },
        }]);
        expect(await check.poll()).toEqual({ state: 'expired' });
        expect(client.call).toHaveBeenCalledTimes(3);
    });

    it.each([
        { id: '456', token: 'test-secret' },
        { id: '123', userInfo: { uid: '456' }, token: 'test-secret' },
        { token: 'test-secret' },
    ])('rejects missing, conflicting or mismatched IDs without further requests', async login => {
        const { check, client } = setup(login);
        await check.start();
        expect(await check.poll()).toEqual({ state: 'identity-mismatch' });
        expect(await check.poll()).toEqual({ state: 'expired' });
        expect(client.call).toHaveBeenCalledTimes(3);
    });

    it('rejects a profile response without a credential', async () => {
        const { check } = setup({ id: '123' });
        await check.start();
        expect(await check.poll()).toEqual({ state: 'missing-credential' });
    });

    it('discards an exchange response arriving after cancellation', async () => {
        const { check, client } = setup(null);
        let finish!: (value: unknown) => void;
        client.call.mockReset().mockResolvedValueOnce({ data: { qrCode: 'test-qr' } })
            .mockResolvedValueOnce({ data: { status: 3 } })
            .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await check.start();
        const pending = check.poll();
        await vi.waitFor(() => expect(client.call).toHaveBeenCalledTimes(3));
        check.cancel();
        finish({ data: { id: '123', token: 'test-secret' } });
        expect(await pending).toEqual({ state: 'expired' });
    });

    it('does not exchange on an unknown QR status', async () => {
        const { check, client } = setup(null);
        client.call.mockReset().mockResolvedValueOnce({ data: { qrCode: 'test-qr' } })
            .mockResolvedValueOnce({ data: { status: 99, id: '123', token: 'test-secret' } });
        await check.start();
        expect(await check.poll()).toEqual({ state: 'unsupported-status' });
        expect(client.call).toHaveBeenCalledTimes(2);
    });

    it('expires locally before issuing another request', async () => {
        let clock = 0;
        const client = { call: vi.fn().mockResolvedValue({ data: { qrCode: 'test-qr' } }) };
        const check = createIdentityCheck({ client, expectedAccountId: '123', now: () => clock });
        await check.start();
        clock = 5 * 60 * 1000;
        expect(await check.poll()).toEqual({ state: 'expired' });
        expect(client.call).toHaveBeenCalledTimes(1);
    });

    it('does not issue duplicate exchanges when polling overlaps', async () => {
        const { check, client } = setup(null);
        let finish!: (value: unknown) => void;
        client.call.mockReset().mockResolvedValueOnce({ data: { qrCode: 'test-qr' } })
            .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
            .mockResolvedValueOnce({ data: { id: '123', token: 'test-secret' } });
        await check.start();
        const pending = check.poll();
        expect(await check.poll()).toEqual({ state: 'pending' });
        finish({ data: { status: 3 } });
        expect(await pending).toEqual({ state: 'identity-matched' });
        expect(client.call).toHaveBeenCalledTimes(3);
    });
});
