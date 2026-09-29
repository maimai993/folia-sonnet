import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/bodianApiBridge.test.ts

const require = createRequire(import.meta.url);
const { createBodianApiBridge } = require('../../../electron/bodianApiBridge.cjs');
const { createSessionRepository, SESSION_KEY } = require('../../../electron/bodian/session.cjs');
const { requestJson, signQuery } = require('../../../electron/bodian/http.cjs');

const createStore = () => {
    const values = new Map<string, unknown>();
    return { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value), delete: (key: string) => values.delete(key) };
};
const cipher = () => ({
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(Buffer.from(text).map(byte => byte ^ 0xa5)),
    decryptString: (data: Buffer) => Buffer.from(data.map(byte => byte ^ 0xa5)).toString(),
});

describe('Bodian desktop bridge', () => {
    it('advances a sparse server page to its boundary instead of repeating the first page', async () => {
        const request = vi.fn().mockResolvedValueOnce({ code: 200, data: { total: 121, list: Array.from({ length: 99 }, (_, id) => ({ id: id + 1 })) } })
            .mockResolvedValueOnce({ code: 200, data: { total: 121, list: Array.from({ length: 21 }, (_, id) => ({ id: id + 101 })) } });
        const bridge = createBodianApiBridge({ store: createStore(), request });
        const first = await bridge.request('playlist_tracks', { id: '123', limit: 100, offset: 0 });
        expect(first.data.bodianPagination).toEqual({ nextOffset: 100, hasMore: true });
        const second = await bridge.request('playlist_tracks', { id: '123', limit: 100, offset: first.data.bodianPagination.nextOffset });
        expect(second.data.list).toHaveLength(21);
        expect(second.data.bodianPagination).toEqual({ nextOffset: 121, hasMore: false });
        expect(request.mock.calls.map(([url]) => url.searchParams.get('pn'))).toEqual(['1', '2']);
    });
    it.each([false, true])('handles Chromium-decoded and raw gzip responses (compressed=%s)', async compressed => {
        const headers = new Map();
        const factory = (_options: unknown, onResponse: (response: any) => void) => {
            const request = new EventEmitter() as any;
            request.setHeader = (key: string, value: string) => headers.set(key, value);
            request.abort = () => {};
            request.end = () => queueMicrotask(() => {
                const response = new EventEmitter() as any;
                response.statusCode = 200;
                response.headers = { 'content-encoding': 'gzip' };
                onResponse(response);
                const body = Buffer.from('{"code":200,"data":{"status":3}}');
                response.emit('data', compressed ? gzipSync(body) : body);
                response.emit('end');
            });
            return request;
        };
        await expect(requestJson(new URL('https://bd-api.kuwo.cn/api/play/music/v2/checkRight'), {
            body: '{"musicId":1}', requestFactory: factory,
        })).resolves.toMatchObject({ data: { status: 3 } });
        expect(headers.has('Content-Length')).toBe(false);
    });
    it('restricts operations and rejects invalid ids or structured renderer params before networking', async () => {
        const request = vi.fn();
        const bridge = createBodianApiBridge({ store: createStore(), safeStorage: cipher(), request });
        for (const [operation, params] of [['fetch', {}], ['constructor', {}], ['song_detail', { id: '../users' }], ['search', { query: {} }]]) {
            expect(await bridge.request(operation, params)).toMatchObject({ ok: false });
        }
        expect(request).not.toHaveBeenCalled();
    });

    it('sends desktop identity, validated pagination and never uses credentials supplied by the renderer', async () => {
        const request = vi.fn(async () => ({ code: 200, data: { resultList: [] } }));
        const bridge = createBodianApiBridge({ store: createStore(), safeStorage: cipher(), request });
        expect(await bridge.request('search', { query: '测试', offset: 50, limit: 50, token: 'renderer-secret' })).toMatchObject({ ok: true });
        const [url, init] = request.mock.calls[0] as unknown as [URL, any];
        expect(url.hostname).toBe('bd-api.kuwo.cn');
        expect(url.searchParams.get('pn')).toBe('1');
        expect(url.searchParams.get('token')).toBe('');
        expect(init.headers.devid).toMatch(/^[a-f0-9]{32}$/);
    });

    it('encrypts sessions, restores them lazily, and clears them on logout', () => {
        const store = createStore(), safeStorage = cipher();
        const sessions = createSessionRepository({ store, safeStorage });
        sessions.set({ uid: '12', token: 'test-secret', user: { id: '12' } });
        expect(Buffer.from(String(store.get(SESSION_KEY)), 'base64').toString()).not.toContain('test-secret');
        const restored = createSessionRepository({ store, safeStorage });
        expect(restored.get()).toMatchObject({ uid: '12', token: 'test-secret' });
        restored.clear();
        expect(restored.get()).toBeNull();
        expect(store.get(SESSION_KEY)).toBeUndefined();
    });

    it('keeps credentials only in memory when OS encryption is unavailable', () => {
        const store = createStore();
        const repository = createSessionRepository({ store, safeStorage: { isEncryptionAvailable: () => false }, warn: vi.fn() });
        repository.set({ uid: '1', token: 'secret' });
        expect(repository.get().token).toBe('secret');
        expect(store.get(SESSION_KEY)).toBeUndefined();
    });

    it('preserves auth and playback errors without returning upstream response bodies', async () => {
        const request = vi.fn(async () => ({ code: 11012, data: { token: 'secret' } }));
        const bridge = createBodianApiBridge({ store: createStore(), safeStorage: cipher(), request });
        const result = await bridge.request('song_detail', { id: 1 });
        expect(result).toMatchObject({ ok: false, error: { code: 'auth-required' } });
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    it.each(['user_playlists', 'user_albums', 'liked_songs'])
        ('requires a fresh verified session for %s before networking', async operation => {
            const request = vi.fn();
            const bridge = createBodianApiBridge({ store: createStore(), safeStorage: cipher(), request });
            expect(await bridge.request(operation, { key: 'old-key' })).toMatchObject({ ok: false, error: { code: 'auth-required' } });
            expect(request).not.toHaveBeenCalled();
        });

    it('discards rejected credentials without decrypting them and keeps catalog requests anonymous', async () => {
        const store = createStore();
        store.set('BODIAN_SESSION_V1', 'rejected-sealed-session');
        const safeStorage = { ...cipher(), decryptString: vi.fn() };
        const request = vi.fn(async () => ({ code: 200, data: { resultList: [] } }));
        const bridge = createBodianApiBridge({ store, safeStorage, request });
        expect(store.get('BODIAN_SESSION_V1')).toBeUndefined();
        expect(safeStorage.decryptString).not.toHaveBeenCalled();
        expect(await bridge.request('login_status')).toEqual({ ok: true, data: null });
        expect(request).not.toHaveBeenCalled();
        await bridge.request('search', { query: 'test' });
        const [url, init] = request.mock.calls[0] as unknown as [URL, any];
        expect(url.searchParams.get('uid')).toBe('-1');
        expect(url.searchParams.get('token')).toBe('');
        expect(init.headers.token).toBeUndefined();
    });

    it('restores only V2 QR sessions and clears them on an authenticated request rejection', async () => {
        const store = createStore(), safeStorage = cipher();
        createSessionRepository({ store, safeStorage }).set({ uid: '123', token: 'fresh-secret', user: { id: '123', nickname: 'Test' } });
        const request = vi.fn().mockResolvedValue({ code: 11012 });
        const bridge = createBodianApiBridge({ store, safeStorage, request });
        expect(await bridge.request('login_status')).toMatchObject({ ok: true, data: { id: '123' } });
        expect(request).not.toHaveBeenCalled();
        expect(await bridge.request('user_albums')).toMatchObject({ ok: false, error: { code: 'auth-required' } });
        expect(await bridge.request('login_status')).toEqual({ ok: true, data: null });
        expect(store.get(SESSION_KEY)).toBeUndefined();
    });

    it('does not clear a new QR session when an old account request is rejected late', async () => {
        const store = createStore(), safeStorage = cipher();
        createSessionRepository({ store, safeStorage }).set({ uid: '123', token: 'old-token', user: { id: '123' } });
        let rejectOld!: (value: unknown) => void;
        const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { rejectOld = resolve; }))
            .mockResolvedValueOnce({ code: 200, data: { qrCode: 'fresh-qr' } })
            .mockResolvedValueOnce({ code: 200, data: { status: 3 } })
            .mockResolvedValueOnce({ code: 200, data: { id: 456, token: 'new-token', userInfo: { id: 456 } } });
        const bridge = createBodianApiBridge({ store, safeStorage, request });
        const oldRequest = bridge.request('user_albums');
        await bridge.request('logout');
        await bridge.request('login_qr_key');
        expect(await bridge.request('login_qr_check', { key: 'fresh-qr' })).toMatchObject({ ok: true, data: { state: 'confirmed' } });
        rejectOld({ code: 11012 });
        await oldRequest;
        expect(await bridge.request('login_status')).toMatchObject({ ok: true, data: { id: '456' } });
    });

    it('signs the exact query and body and preserves upstream preview metadata', async () => {
        const request = vi.fn(async () => ({ code: 200, data: { status: 3, audition: { start: 0, end: 29, https: 'https://cdn.kuwo.cn/preview.mp3' } } }));
        const bridge = createBodianApiBridge({ store: createStore(), safeStorage: cipher(), request, now: () => 1234 });
        const result = await bridge.request('audio', { id: 228908, quality: 'high' });
        expect(result).toMatchObject({ ok: true, data: { quality: 'standard', preview: { startTime: 0, endTime: 29 } } });
        const [url, init] = request.mock.calls[0] as unknown as [URL, any];
        const params = Object.fromEntries(url.searchParams);
        const signature = params.sign; delete params.sign;
        expect(signature).toBe(signQuery(url.pathname, params, init.body));
        expect(request).toHaveBeenCalledTimes(1);
    });
});
