import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/bodianApiBridge.test.ts — host persistence and IPC; protocol tests live in the API repository.

const require = createRequire(import.meta.url);
const { createBodianApiBridge } = require('../../../electron/bodianApiBridge.cjs');
const { createSessionRepository, SESSION_KEY } = require('../../../electron/bodian/session.cjs');
const { createBodianMediaPolicy } = require('../../../electron/bodian/mediaCors.cjs');
const { createWire } = require('../../helpers/bodianWire.cjs');
const createStore = () => {
    const values = new Map<string, unknown>();
    return { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) };
};
const cipher = () => ({ isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(Buffer.from(text).map(byte => byte ^ 0xa5)),
    decryptString: (data: Buffer) => Buffer.from(data.map(byte => byte ^ 0xa5)).toString() });
const account = { uid: '123', token: 'fixture-private', user: { id: '123', nickname: 'Fixture', avatarUrl: '' } };

describe('Bodian desktop bridge', () => {
    it('rejects unregistered operations and structured IPC params before calling the package', async () => {
        const request = vi.fn();
        const bridge = createBodianApiBridge({ store: createStore(), apiFactory: () => ({ request }) });
        for (const [operation, params] of [['fetch', {}], ['constructor', {}], ['subscribe_playlist', {}], ['search', { query: {} }]]) {
            expect(await bridge.request(operation, params)).toMatchObject({ ok: false });
        }
        expect(request).not.toHaveBeenCalled();
    });
    it('injects the host dependencies and preserves package errors', async () => {
        const result = { ok: false, error: { code: 'auth-required', message: 'Sign in required' } };
        const apiFactory = vi.fn((_options: unknown) => ({ request: vi.fn().mockResolvedValue(result) }));
        const requestFactory = vi.fn();
        const bridge = createBodianApiBridge({ store: createStore(), apiFactory, requestFactory });
        expect(apiFactory.mock.calls[0][0]).toMatchObject({ deviceId: expect.stringMatching(/^[a-f0-9]{32}$/), requestFactory });
        expect(await bridge.request('user_albums')).toEqual(result);
    });
    it('sanitizes unexpected exceptions', async () => {
        const bridge = createBodianApiBridge({ store: createStore(), apiFactory: () => ({ request: () => { throw new Error('fixture-private'); } }) });
        const result = await bridge.request('search', { query: 'test' });
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain('fixture-private');
    });
    it('retains V2 encrypted sessions and the device identifier across recreation', async () => {
        const store = createStore(), safeStorage = cipher();
        const saved = createSessionRepository({ store, safeStorage }); saved.set(account);
        expect(Buffer.from(String(store.get(SESSION_KEY)), 'base64').toString()).not.toContain('fixture-private');
        const requestFactory = vi.fn();
        const bridge = createBodianApiBridge({ store, safeStorage, requestFactory });
        expect(await bridge.request('login_status')).toEqual({ ok: true, data: account.user });
        expect(createSessionRepository({ store, safeStorage }).deviceId).toBe(saved.deviceId);
        expect(requestFactory).not.toHaveBeenCalled();
        await bridge.request('logout');
        expect(store.get(SESSION_KEY)).toBeUndefined();
        expect(await bridge.request('login_status')).toEqual({ ok: true, data: null });
    });
    it.each([false, true])('keeps credentials in memory for unavailable/basic_text encryption (%s)', basicText => {
        const store = createStore();
        const repository = createSessionRepository({ store, safeStorage: { ...cipher(), isEncryptionAvailable: () => basicText,
            getSelectedStorageBackend: () => 'basic_text' }, warn: vi.fn() });
        repository.set(account);
        expect(repository.get().token).toBe('fixture-private');
        expect(store.get(SESSION_KEY)).toBeUndefined();
    });
    it('never decrypts or migrates V1 credentials', async () => {
        const store = createStore(); store.set('BODIAN_SESSION_V1', 'fixture-old');
        const safeStorage = { ...cipher(), decryptString: vi.fn() };
        const bridge = createBodianApiBridge({ store, safeStorage });
        expect(store.get('BODIAN_SESSION_V1')).toBeUndefined();
        expect(await bridge.request('login_status')).toEqual({ ok: true, data: null });
        expect(safeStorage.decryptString).not.toHaveBeenCalled();
    });
    it('uses the package to clear a rejected persisted session', async () => {
        const store = createStore(), safeStorage = cipher();
        createSessionRepository({ store, safeStorage }).set(account);
        const wire = createWire(() => ({ code: 11012, data: { token: 'fixture-private' } }));
        const bridge = createBodianApiBridge({ store, safeStorage, requestFactory: wire.factory });
        const result = await bridge.request('user_albums');
        expect(result).toMatchObject({ ok: false, error: { code: 'auth-required' } });
        expect(JSON.stringify(result)).not.toContain('fixture-private');
        expect(store.get(SESSION_KEY)).toBeUndefined();
    });
    it('registers only successful audio results with the media policy', async () => {
        const policy = createBodianMediaPolicy(), url = 'https://audio.example.test/full.mp3';
        const request = vi.fn().mockResolvedValueOnce({ ok: true, data: { url } }).mockResolvedValueOnce({ ok: false, error: { code: 'network' } });
        const register = vi.fn(policy.register);
        const bridge = createBodianApiBridge({ store: createStore(), apiFactory: () => ({ request }), onAudioSource: register });
        await bridge.request('audio', { id: '123' }); await bridge.request('audio', { id: '456' });
        expect(register).toHaveBeenCalledTimes(1);
        expect(policy.allows({ url, resourceType: 'media', method: 'GET' })).toBe(true);
        expect(policy.allows({ url: 'https://other.example.test/full.mp3', resourceType: 'media', method: 'GET' })).toBe(false);
    });
});
