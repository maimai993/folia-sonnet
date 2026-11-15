import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../sync-server/src/app';
import { D1Emulator } from '../../../sync-server/src/d1-emulator';

// Exercise shipped Hono routes with isolated SQLite and disabled external lyric verification.
const db = new D1Emulator(':memory:');
const env = {
    FOLIA_SYNC_DB: db,
    SYNC_TOKEN: 'synthetic-sync-only',
    ADMIN_USERNAME: 'synthetic-admin',
    ADMIN_PASSWORD: 'synthetic-password-only',
    AI_CACHE_VERIFY: 'off',
};
const key = 'a'.repeat(32);
const otherKey = 'b'.repeat(32);
let cookie = '';
const request = (route: string, init?: RequestInit) => app.request(`https://synthetic.invalid${route}`, init, env);
const payload = (text: string) => ({ decision: { mode: 'original' }, text });
const put = (text: string, cacheKey = key) => request(`/api/ai-cache/stage/${cacheKey}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: payload(text), songTitle: 'Synthetic Song', provider: 'synthetic', model: 'test', platform: 'qq' }),
});
const snapshot = async () => ({
    current: (await db.prepare('SELECT * FROM ai_cache ORDER BY cache_key').all()).results,
    backups: (await db.prepare('SELECT * FROM ai_cache_backups ORDER BY id').all()).results,
});
const restore = (id: number) => request(`/admin/api/ai-cache-backups/${id}/restore`, { method: 'POST', headers: { Cookie: cookie } });
const firstBackup = async () => (await db.prepare('SELECT id FROM ai_cache_backups ORDER BY id LIMIT 1').first<{ id: number }>())!.id;
const seedBackup = async () => {
    expect((await put('initial')).status).toBe(200);
    expect((await put('current')).status).toBe(200);
    return firstBackup();
};

beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network access is forbidden in this regression suite'); }));
    expect((await request('/health')).status).toBe(200);
    const response = await request('/admin/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }),
    });
    expect(response.status).toBe(200);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
});
beforeEach(async () => {
    for (const name of ['fail_archive', 'fail_prune', 'fail_replace', 'fail_restore', 'fail_delete']) {
        await db.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    }
    await db.prepare('DELETE FROM ai_cache_backups').run();
    await db.prepare('DELETE FROM ai_cache').run();
    await db.prepare('DELETE FROM ai_cache_hits').run();
});
afterAll(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    (db as unknown as { db: { close(): void } }).db.close();
});

describe('AI cache atomic archive/prune/replacement/restore', () => {
    it('retains the old value when archiving fails on the public PUT route', async () => {
        expect((await put('initial')).status).toBe(200);
        const before = await snapshot();
        await db.prepare("CREATE TRIGGER fail_archive BEFORE INSERT ON ai_cache_backups BEGIN SELECT RAISE(ABORT, 'synthetic archive'); END").run();
        expect((await put('replacement')).status).toBe(500);
        expect(await snapshot()).toEqual(before);
    });

    it('rolls back an archived version when the final replacement fails', async () => {
        await seedBackup();
        const before = await snapshot();
        await db.prepare("CREATE TRIGGER fail_replace BEFORE UPDATE ON ai_cache BEGIN SELECT RAISE(ABORT, 'synthetic replacement'); END").run();
        expect((await put('replacement')).status).toBe(500);
        expect(await snapshot()).toEqual(before);
    });

    it('rolls back archive and replacement if pruning fails', async () => {
        for (let i = 0; i <= 10; i += 1) expect((await put(`version-${i}`)).status).toBe(200);
        const before = await snapshot();
        await db.prepare("CREATE TRIGGER fail_prune BEFORE DELETE ON ai_cache_backups BEGIN SELECT RAISE(ABORT, 'synthetic prune'); END").run();
        expect((await put('replacement')).status).toBe(500);
        expect(await snapshot()).toEqual(before);
    });

    it('retains only the latest ten versions of this key and leaves other keys alone', async () => {
        expect((await put('other-old', otherKey)).status).toBe(200);
        expect((await put('other-new', otherKey)).status).toBe(200);
        for (let i = 0; i < 13; i += 1) expect((await put(`version-${i}`)).status).toBe(200);
        const response = await request(`/admin/api/ai-cache-backups/stage/${key}`, { headers: { Cookie: cookie } });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.backups).toHaveLength(10);
        expect(body.backups.map((row: { payload: { text: string } }) => row.payload.text)).toEqual(Array.from({ length: 10 }, (_, i) => `version-${11 - i}`));
        expect((await db.prepare('SELECT COUNT(*) AS n FROM ai_cache_backups WHERE cache_key = ?').bind(otherKey).first<{ n: number }>())!.n).toBe(1);
    });

    it('leaves both tables unchanged when restoring fails in the UPSERT', async () => {
        const id = await seedBackup();
        const before = await snapshot();
        await db.prepare("CREATE TRIGGER fail_restore BEFORE UPDATE ON ai_cache BEGIN SELECT RAISE(ABORT, 'synthetic restore'); END").run();
        expect((await restore(id)).status).toBe(500);
        expect(await snapshot()).toEqual(before);
    });

    it('rolls back restoration if removing the restored backup fails last', async () => {
        const id = await seedBackup();
        const before = await snapshot();
        await db.prepare(`CREATE TRIGGER fail_delete BEFORE DELETE ON ai_cache_backups WHEN OLD.id = ${id} BEGIN SELECT RAISE(ABORT, 'synthetic delete'); END`).run();
        expect((await restore(id)).status).toBe(500);
        expect(await snapshot()).toEqual(before);
    });

    it('restores through the authenticated route and archives the previously current value', async () => {
        const id = await seedBackup();
        await db.prepare('UPDATE ai_cache SET hits = 9').run();
        const before = (await snapshot()).current![0];
        expect((await restore(id)).status).toBe(200);
        const after = await snapshot();
        expect(JSON.parse(String(after.current![0].payload_json)).text).toBe('initial');
        expect(after.current![0].hits).toBe(9);
        expect(after.current![0].created_at).toBe(before.created_at);
        expect(after.backups).toHaveLength(1);
        expect(JSON.parse(String(after.backups![0].payload_json)).text).toBe('current');
        expect(after.backups![0].hits).toBe(9);
    });

    it('returns 404 with zero writes if another restore consumes the target before its batch', async () => {
        const id = await seedBackup();
        const originalBatch = db.batch.bind(db);
        let release!: () => void;
        let reached!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const paused = new Promise<void>((resolve) => { reached = resolve; });
        const batch = vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
            reached();
            await gate;
            return originalBatch(statements);
        });
        const waiting = restore(id);
        try {
            expect(await Promise.race([paused.then(() => true), Promise.resolve(waiting).then(() => false)])).toBe(true);
            expect((await restore(id)).status).toBe(200);
            const before = await snapshot();
            release();
            const response = await waiting;
            expect(response.status).toBe(404);
            expect((await response.json()).error).toBe('not_found');
            expect(await snapshot()).toEqual(before);
        } finally {
            release();
            await waiting;
            batch.mockRestore();
        }
    });

    it('returns 404 with zero writes if the target is deleted before its batch', async () => {
        const id = await seedBackup();
        const originalBatch = db.batch.bind(db);
        let release!: () => void;
        let reached!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const paused = new Promise<void>((resolve) => { reached = resolve; });
        const batch = vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
            reached();
            await gate;
            return originalBatch(statements);
        });
        const waiting = restore(id);
        try {
            expect(await Promise.race([paused.then(() => true), Promise.resolve(waiting).then(() => false)])).toBe(true);
            await db.prepare('DELETE FROM ai_cache_backups WHERE id = ?').bind(id).run();
            const before = await snapshot();
            release();
            const response = await waiting;
            expect(response.status).toBe(404);
            expect((await response.json()).error).toBe('not_found');
            expect(await snapshot()).toEqual(before);
        } finally {
            release();
            await waiting;
            batch.mockRestore();
        }
    });

    it('restores the oldest target at the backup limit without pruning it before use', async () => {
        for (let i = 0; i <= 10; i += 1) expect((await put(`version-${i}`)).status).toBe(200);
        const id = await firstBackup();
        expect((await restore(id)).status).toBe(200);
        const after = await snapshot();
        expect(JSON.parse(String(after.current![0].payload_json)).text).toBe('version-0');
        expect(after.backups).toHaveLength(10);
        expect(after.backups!.some((row) => row.id === id)).toBe(false);
        expect(after.backups!.map((row) => JSON.parse(String(row.payload_json)).text)).toEqual(Array.from({ length: 10 }, (_, i) => `version-${i + 1}`));
    });

    it('preserves public GET metadata, old-client platform behavior and overwrite counters', async () => {
        expect((await put('initial')).status).toBe(200);
        expect((await request(`/api/ai-cache/stage/${key}`)).status).toBe(200);
        const before = (await snapshot()).current![0];
        expect((await put('new')).status).toBe(200);
        const response = await request(`/api/ai-cache/stage/${key}`);
        const body = await response.json();
        expect(body.entry.payload.text).toBe('new');
        expect(body.entry.platform).toBe('qq');
        expect(body.entry.hits).toBe(1);
        expect(body.entry.createdAt).toBe(before.created_at);
        const oldClient = await request(`/api/ai-cache/stage/${otherKey}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload: payload('legacy') }) });
        expect(oldClient.status).toBe(200);
    });
});

describe('AI cache UTF-8 payload limits', () => {
    it('stores exact UTF-8 bytes for accepted Chinese and astral Unicode', async () => {
        const text = '汉字🎵é';
        expect((await put(text)).status).toBe(200);
        const row = (await snapshot()).current![0];
        expect(row.payload_bytes).toBe(new TextEncoder().encode(JSON.stringify(payload(text))).byteLength);
        expect(row.payload_bytes).toBeGreaterThan(JSON.stringify(payload(text)).length);
    });

    it('accepts exactly 65536 bytes and rejects the next multibyte payload without any write', async () => {
        const overhead = new TextEncoder().encode(JSON.stringify(payload(''))).byteLength;
        const text = '汉'.repeat(Math.floor((65536 - overhead) / 3)) + 'a'.repeat((65536 - overhead) % 3);
        expect(new TextEncoder().encode(JSON.stringify(payload(text))).byteLength).toBe(65536);
        expect((await put(text)).status).toBe(200);
        expect((await snapshot()).current![0].payload_bytes).toBe(65536);
        const before = await snapshot();
        const response = await put(`${text}汉`);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_payload');
        expect(await snapshot()).toEqual(before);
    });

    it('rejects a payload below 64K UTF-16 chars but above the UTF-8 byte limit', async () => {
        expect((await put('initial')).status).toBe(200);
        const before = await snapshot();
        const text = '汉'.repeat(23000);
        expect(JSON.stringify(payload(text)).length).toBeLessThan(65536);
        const response = await put(text);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_payload');
        expect(await snapshot()).toEqual(before);
    });

    it('keeps wire schema version 2 and rejects empty uploads without archiving', async () => {
        expect((await (await request('/health')).json()).schemaVersion).toBe(2);
        expect((await put('initial')).status).toBe(200);
        const before = await snapshot();
        const response = await request(`/api/ai-cache/stage/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload: {} }) });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('empty_payload');
        expect(await snapshot()).toEqual(before);
    });

    /*
     * /songs 的总数是 `COUNT(DISTINCT song_title)`，整个歌名索引读一遍去重（4 万条 5.6ms），
     * 而分页本身只要 0.15ms —— 所以它带了 5 秒缓存。缓存不能把新歌盖住：写入、删除
     * 都要立刻作废，否则「刚推上去就刷新 /songs」看不到自己那首。
     */
    it('counts a new song on /songs as soon as it is pushed, despite the total cache', async () => {
        const total = async () => (await (await request('/api/ai-cache/songs?limit=50')).json()).total;
        const putTitle = (songTitle: string, cacheKey: string) => request(`/api/ai-cache/stage/${cacheKey}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ payload: payload('x'), songTitle, provider: 'synthetic', model: 'test', platform: 'qq' }),
        });

        expect(await total()).toBe(0);
        expect((await putTitle('Synthetic Song', key)).status).toBe(200);
        expect(await total()).toBe(1);
        /* 同一个歌名换个键不算新歌，总数不变（这条同时证明缓存值是对的，不是恒加一）。 */
        expect((await putTitle('Synthetic Song', otherKey)).status).toBe(200);
        expect(await total()).toBe(1);
        /* 出现新歌名，缓存必须立刻作废。 */
        expect((await putTitle('Another Song', 'c'.repeat(32))).status).toBe(200);
        expect(await total()).toBe(2);
        /* 删掉唯一那条「Another Song」之后立刻少掉（DELETE 在 admin 路由下，要带 cookie）。 */
        expect((await request(`/admin/api/ai-cache/stage/${'c'.repeat(32)}`, { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(200);
        expect(await total()).toBe(1);
    });
});
