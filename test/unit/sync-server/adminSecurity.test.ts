import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../sync-server/src/app';
import { D1Emulator } from '../../../sync-server/src/d1-emulator';

// Real in-memory SQLite and Hono requests exercise configuration, migration and session boundaries.
let app: typeof import('../../../sync-server/src/app')['default'];
beforeEach(async () => {
    // Each scenario owns an initializer; database-isolation behavior is tested explicitly below.
    vi.resetModules();
    app = (await import('../../../sync-server/src/app')).default;
});
const databases: D1Emulator[] = [];
const password = 'synthetic-admin-password-2026';
const createEnv = (extra: Partial<Env> = {}): Env => {
    const db = new D1Emulator(':memory:');
    databases.push(db);
    return { FOLIA_SYNC_DB: db, SYNC_TOKEN: 'synthetic-sync-token', ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: password, ...extra };
};
const request = (env: Env, path: string, init?: RequestInit) => app.request(`https://panel.synthetic.test${path}`, init, env);
const login = (env: Env, headers: Record<string, string> = {}) => request(env, '/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }),
});
const cookieOf = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
afterEach(() => {
    for (const db of databases.splice(0)) (db as unknown as { db: { close(): void } }).db.close();
});

describe('admin configuration and sessions', () => {
    it.each([undefined, '', 'short', '                ', '               a'])('disables all admin access for password %j', async (weakPassword) => {
        const env = createEnv({ ADMIN_PASSWORD: weakPassword });
        for (const path of ['/admin', '/admin/session', '/admin/api/stats']) {
            const response = await request(env, path);
            expect(response.status).toBe(503);
            expect(response.headers.get('cache-control')).toBe('no-store');
        }
        expect((await login(env)).status).toBe(503);
        expect((await request(env, '/health')).status).toBe(200);
    });

    it('requires a nonempty username without disabling public APIs', async () => {
        const env = createEnv({ ADMIN_USERNAME: '  ' });
        expect((await login(env)).status).toBe(503);
        expect((await request(env, '/api/fonts')).status).toBe(200);
    });

    it('authenticates explicit credentials with private cookie and non-cacheable responses', async () => {
        const env = createEnv();
        const response = await login(env, { Origin: 'https://panel.synthetic.test' });
        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i);
        expect(response.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
        expect(response.headers.get('set-cookie')).toMatch(/Secure/i);
        expect(response.headers.get('access-control-allow-origin')).toBeNull();
        const cookie = cookieOf(response);
        for (const path of ['/admin', '/admin/session', '/admin/api/stats']) {
            const authenticated = await request(env, path, { headers: { Cookie: cookie } });
            expect(authenticated.status).toBe(200);
            expect(authenticated.headers.get('cache-control')).toBe('no-store');
            expect(authenticated.headers.get('access-control-allow-origin')).toBeNull();
        }
    });

    it.each(['ADMIN_USERNAME', 'ADMIN_PASSWORD'] as const)('revokes a session on %s rotation', async (field) => {
        const env = createEnv();
        const cookie = cookieOf(await login(env));
        const rotated = { ...env, [field]: `${env[field]}-rotated` };
        const response = await request(rotated, '/admin/api/stats', { headers: { Cookie: cookie } });
        expect(response.status).toBe(401);
        expect((await env.FOLIA_SYNC_DB.prepare('SELECT COUNT(*) AS count FROM admin_sessions').first<{ count: number }>())?.count).toBe(0);
    });

    it('does not keep an existing cookie valid when credentials are removed', async () => {
        const env = createEnv();
        const cookie = cookieOf(await login(env));
        expect((await request({ ...env, ADMIN_PASSWORD: undefined }, '/admin/api/stats', { headers: { Cookie: cookie } })).status).toBe(503);
    });

    it.each<Record<string, string>>([
        { Origin: 'https://other.synthetic.test' },
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'cross-site' },
    ])('rejects browser cross-origin mutation %j before logout', async (headers) => {
        const env = createEnv();
        const cookie = cookieOf(await login(env));
        const response = await request(env, '/admin/logout', { method: 'POST', headers: { ...headers, Cookie: cookie } });
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect((await request(env, '/admin/api/stats', { headers: { Cookie: cookie } })).status).toBe(200);
        expect((await login(env, headers)).status).toBe(403);
        expect((await request(env, '/admin/api/fonts/synthetic', { method: 'DELETE', headers: { ...headers, Cookie: cookie } })).status).toBe(403);
    });

    it('supports same-origin logout and authenticated non-browser scripts', async () => {
        const env = createEnv();
        const cookie = cookieOf(await login(env));
        const response = await request(env, '/admin/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://panel.synthetic.test' } });
        expect(response.status).toBe(200);
        expect((await request(env, '/admin/api/stats', { headers: { Cookie: cookie } })).status).toBe(401);
        expect((await request(env, '/health', { headers: { Origin: 'https://other.synthetic.test' } })).headers.get('access-control-allow-origin')).toBe('*');
    });

    it('supports explicit HTTPS public origin behind an HTTP proxy without trusting forwarded headers', async () => {
        const env = createEnv({ ADMIN_PUBLIC_ORIGIN: 'https://public.synthetic.test' });
        const body = JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD });
        const response = await app.request('http://internal.synthetic.test/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://public.synthetic.test' }, body,
        }, env);
        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toMatch(/Secure/i);
        const denied = await app.request('http://internal.synthetic.test/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.synthetic.test', 'X-Forwarded-Host': 'other.synthetic.test', 'X-Forwarded-Proto': 'https' }, body,
        }, env);
        expect(denied.status).toBe(403);
        const plain = createEnv();
        const spoof = await app.request('http://internal.synthetic.test/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://public.synthetic.test', 'X-Forwarded-Proto': 'https' },
            body: JSON.stringify({ username: plain.ADMIN_USERNAME, password: plain.ADMIN_PASSWORD }),
        }, plain);
        expect(spoof.status).toBe(403);
    });

    it.each(['https://panel.synthetic.test/path', 'https://user@panel.synthetic.test', 'file:///synthetic', 'not-a-url'])('fails closed for invalid public origin %s', async (origin) => {
        const env = createEnv({ ADMIN_PUBLIC_ORIGIN: origin });
        expect((await login(env)).status).toBe(503);
        expect((await request(env, '/admin')).status).toBe(503);
    });

    it('revokes expired sessions', async () => {
        const env = createEnv();
        const cookie = cookieOf(await login(env));
        await env.FOLIA_SYNC_DB.prepare('UPDATE admin_sessions SET expires_at = ?').bind('2000-01-01T00:00:00.000Z').run();
        expect((await request(env, '/admin/api/stats', { headers: { Cookie: cookie } })).status).toBe(401);
        expect((await env.FOLIA_SYNC_DB.prepare('SELECT COUNT(*) AS count FROM admin_sessions').first<{ count: number }>())?.count).toBe(0);
    });

    it('renews the cookie and server expiry together for a valid active panel', async () => {
        const env = createEnv();
        const cookie = cookieOf(await login(env));
        const oldExpiry = new Date(Date.now() + 60_000).toISOString();
        await env.FOLIA_SYNC_DB.prepare('UPDATE admin_sessions SET expires_at = ?').bind(oldExpiry).run();
        const response = await request(env, '/admin', { headers: { Cookie: cookie } });
        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toContain('Max-Age=43200');
        const row = await env.FOLIA_SYNC_DB.prepare('SELECT expires_at FROM admin_sessions').first<{ expires_at: string }>();
        expect(Date.parse(row!.expires_at)).toBeGreaterThan(Date.parse(oldExpiry));
    });
});

describe('additive admin migration', () => {
    it('upgrades old session/cache tables without losing records and rejects legacy cookies', async () => {
        const env = createEnv();
        const db = env.FOLIA_SYNC_DB;
        await db.prepare('CREATE TABLE admin_sessions (token TEXT PRIMARY KEY, username TEXT, created_at TEXT, expires_at TEXT)').run();
        await db.prepare('INSERT INTO admin_sessions VALUES (?, ?, ?, ?)').bind('synthetic-legacy', env.ADMIN_USERNAME, '2020-01-01', '2099-01-01').run();
        const columns = 'kind TEXT, cache_key TEXT, payload_json TEXT, payload_bytes INTEGER, song_title TEXT, provider TEXT, model TEXT, hits INTEGER, created_at TEXT';
        await db.prepare(`CREATE TABLE ai_cache (${columns}, updated_at TEXT, PRIMARY KEY(kind,cache_key))`).run();
        await db.prepare(`CREATE TABLE ai_cache_backups (id INTEGER PRIMARY KEY, ${columns}, archived_at TEXT)`).run();
        await db.prepare("INSERT INTO ai_cache VALUES ('theme','synthetic','{}',2,'synthetic song',NULL,NULL,0,'2020','2020')").run();
        const response = await request(env, '/admin/api/stats', { headers: { Cookie: 'folia_admin_session=synthetic-legacy' } });
        expect(response.status).toBe(401);
        expect((await db.prepare('SELECT payload_json FROM ai_cache').first<{ payload_json: string }>())?.payload_json).toBe('{}');
        for (const table of ['ai_cache', 'ai_cache_backups']) {
            expect((await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results?.map((c) => c.name)).toContain('platform');
        }
        expect((await login(env)).status).toBe(200);
        expect((await request(env, '/health')).status).toBe(200);
        expect(await (await request(env, '/health')).json()).toMatchObject({ schemaVersion: 2 });
    });

    it('retries initialization after a transient additive migration failure', async () => {
        const env = createEnv();
        const db = env.FOLIA_SYNC_DB;
        await db.prepare('CREATE TABLE admin_sessions (token TEXT PRIMARY KEY, username TEXT, created_at TEXT, expires_at TEXT)').run();
        const prepare = db.prepare.bind(db);
        let failOnce = true;
        db.prepare = (query) => {
            const statement = prepare(query);
            if (query === 'ALTER TABLE admin_sessions ADD COLUMN credential_tag TEXT' && failOnce) {
                failOnce = false;
                return { ...statement, run: async () => { throw new Error('synthetic migration unavailable'); } };
            }
            return statement;
        };
        expect((await login(env)).status).toBe(500);
        expect((await login(env)).status).toBe(200);
    });

    it('rolls back failed schema batches and retries without caching a false success', async () => {
        const env = createEnv();
        const db = env.FOLIA_SYNC_DB;
        const batch = db.batch.bind(db);
        let failOnce = true;
        db.batch = (statements) => {
            if (failOnce) {
                failOnce = false;
                return batch([...statements, db.prepare('INSERT INTO synthetic_missing_table VALUES (1)')]);
            }
            return batch(statements);
        };
        expect((await request(env, '/health')).status).toBe(500);
        expect((await db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").first<{ count: number }>())?.count).toBe(0);
        expect((await login(env)).status).toBe(200);
    });

    it('initializes independent databases even after one database has already been used', async () => {
        const first = createEnv();
        const second = createEnv();
        expect((await login(first)).status).toBe(200);
        const responses = await Promise.all([login(second), login(second)]);
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        expect((await second.FOLIA_SYNC_DB.prepare('SELECT COUNT(*) AS count FROM admin_sessions').first<{ count: number }>())?.count).toBe(2);
    });
});

/*
 * 公开写接口的跨源来源校验（issue M36）。
 *
 * 公开读接口对谁都开放 —— 那是本意。但默认部署（没配 AI_CACHE_WRITE_TOKEN、也没配管理员）时
 * `requireCacheWriter` 是放行的，通配 CORS 叠上那个放行，任意网页都能以用户浏览器为跳板写缓存。
 * 所以写请求要求同源，或干脆不带 Origin（原生 OkHttp 桥、curl 都不带）。
 */
describe('public write origin gate', () => {
    const body = JSON.stringify({ schemaVersion: 1, updatedAt: '2026-01-01T00:00:00Z', data: { visualizerMode: 'classic' } });
    /* /settings 另外还要 Bearer：这里验的是来源闸，令牌给对的，免得被 401 抢在前面。 */
    const auth = { Authorization: 'Bearer synthetic-sync-token' };

    it('rejects a cross-origin settings write', async () => {
        const env = createEnv();
        const response = await request(env, '/settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth, Origin: 'https://evil.example' }, body,
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ ok: false, error: 'invalid_origin' });
    });

    it('still allows a write with no Origin header (native bridge, curl)', async () => {
        const env = createEnv();
        const response = await request(env, '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth }, body });
        expect(response.status).toBe(200);
    });

    it('still allows a same-origin write', async () => {
        const env = createEnv();
        const response = await request(env, '/settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth, Origin: 'https://panel.synthetic.test' }, body,
        });
        expect(response.status).toBe(200);
    });

    /* 读接口不受影响：网页版、桌面版跨源读都是正常用法。 */
    it('leaves cross-origin reads alone', async () => {
        const env = createEnv();
        const response = await request(env, '/health', { headers: { Origin: 'https://other.synthetic.test' } });
        expect(response.status).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
    });
});
