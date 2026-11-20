import { Hono } from 'hono';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './app.js';

// src/admin.ts
// The panel uses explicitly configured credentials and revocable database sessions.
// A credential tag binds each session to the operator configuration without storing its password.

export type AdminEnv = { Bindings: Env };
type AdminContext = Context<AdminEnv>;

export const ADMIN_COOKIE = 'folia_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_RENEW_BELOW_MS = 10 * 60 * 60 * 1000;

type AdminCredentials = { username: string; password: string };
type AdminCredentialEnv = { ADMIN_USERNAME?: string; ADMIN_PASSWORD?: string };

export interface AdminSessionRow {
    token: string;
    username: string;
    created_at: string;
    expires_at: string;
    credential_tag: string | null;
}

/** No built-in account: missing or weak configuration disables admin access. */
export const readAdminCredentials = (env: AdminCredentialEnv): AdminCredentials | null => {
    const username = String(env.ADMIN_USERNAME ?? '').trim();
    const password = String(env.ADMIN_PASSWORD ?? '');
    if (!username || password.trim().length < 16) return null;
    return { username, password };
};

/** Only explicit operator configuration may override the request origin behind a reverse proxy. */
export const readAdminPublicOrigin = (c: AdminContext): string | null => {
    const configured = c.env.ADMIN_PUBLIC_ORIGIN;
    if (configured === undefined || configured === '') return new URL(c.req.url).origin;
    try {
        const url = new URL(configured);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
            || url.pathname !== '/' || url.search || url.hash) return null;
        return url.origin;
    } catch {
        return null;
    }
};

/** Reject browser mutations from other origins, including form submissions. */
export const isSameOriginAdminMutation = (c: AdminContext): boolean => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return true;
    const expectedOrigin = readAdminPublicOrigin(c);
    if (!expectedOrigin) return false;
    const origin = c.req.header('Origin');
    if (origin && origin !== expectedOrigin) return false;
    return c.req.header('Sec-Fetch-Site') !== 'cross-site';
};

const credentialTag = async (credentials: AdminCredentials): Promise<string> => {
    const data = new TextEncoder().encode(JSON.stringify([credentials.username, credentials.password]));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const newToken = (): string => {
    const cryptoRef = globalThis.crypto as Crypto | undefined;
    if (cryptoRef?.getRandomValues) {
        const bytes = new Uint8Array(32);
        cryptoRef.getRandomValues(bytes);
        return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('secure_random_unavailable');
};

const readSessionRow = async (db: Env['FOLIA_SYNC_DB'], token: string): Promise<AdminSessionRow | null> => {
    if (!token) return null;
    const row = await db
        .prepare('SELECT token, username, created_at, expires_at, credential_tag FROM admin_sessions WHERE token = ?')
        .bind(token)
        .first<AdminSessionRow>();
    if (!row?.expires_at) return null;
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await db.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
        return null;
    }
    return row;
};

/**
 * A session is valid only for the currently configured username and password.
 *
 * 实现只吃 `env` 与 cookie 值，不碰 Hono 上下文 —— 因为 `Context` 的 `Variables` 是逆变的，
 * 一个「多带点 Variables」的上下文（AI 缓存写入准入那个中间件就是）传不进来。所以真正的
 * 判断在 `readAdminSessionFor` 里，[readAdminSession] 只是把上下文拆成它要的两样东西。
 */
const readAdminSessionFor = async (env: Env, token: string | undefined): Promise<string | null> => {
    const credentials = readAdminCredentials(env);
    if (!credentials || !token) return null;
    const row = await readSessionRow(env.FOLIA_SYNC_DB, token);
    if (!row) return null;
    if (row.username !== credentials.username || row.credential_tag !== await credentialTag(credentials)) {
        await destroyAdminSession(env.FOLIA_SYNC_DB, token);
        return null;
    }
    return row.username;
};

export const readAdminSession = (c: AdminContext): Promise<string | null> => (
    readAdminSessionFor(c.env, getCookie(c, ADMIN_COOKIE))
);

/** 同上，给「上下文里还带别的 Variables」的中间件用（AI 缓存的写入准入）。 */
export const readCacheWriterAdminSession = (c: Context<CacheWriterEnv>): Promise<string | null> => (
    readAdminSessionFor(c.env, getCookie(c, ADMIN_COOKIE))
);

const sessionCookieOptions = (c: AdminContext) => ({
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    // Local HTTP remains supported; public deployments must terminate HTTPS.
    secure: readAdminPublicOrigin(c)?.startsWith('https:') ?? false,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
});

/** Sliding expiry renews only a session that still belongs to the current credentials. */
export const touchAdminSession = async (c: AdminContext): Promise<void> => {
    if (!await readAdminSession(c)) return;
    const token = getCookie(c, ADMIN_COOKIE)!;
    const row = await readSessionRow(c.env.FOLIA_SYNC_DB, token);
    if (!row) return;
    if (Date.parse(row.expires_at) - Date.now() > SESSION_RENEW_BELOW_MS) return;
    await c.env.FOLIA_SYNC_DB
        .prepare('UPDATE admin_sessions SET expires_at = ? WHERE token = ? AND credential_tag = ?')
        .bind(new Date(Date.now() + SESSION_TTL_MS).toISOString(), token, row.credential_tag)
        .run();
    setCookie(c, ADMIN_COOKIE, token, sessionCookieOptions(c));
};

/** Gate for every /admin/api/* route. */
export const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next: Next) => {
    c.header('Cache-Control', 'no-store');
    if (!readAdminCredentials(c.env)) return c.json({ ok: false, error: 'admin_not_configured' }, 503);
    if (!isSameOriginAdminMutation(c)) return c.json({ ok: false, error: 'invalid_origin' }, 403);
    if (!await readAdminSession(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);
    await next();
};

/** 常量时间比较：按长度先短路会让攻击者从耗时里逐位试出凭证。 */
const equalsConstantTime = (left: string, right: string): boolean => {
    const a = new TextEncoder().encode(left);
    const b = new TextEncoder().encode(right);
    let diff = a.length ^ b.length;
    for (let index = 0; index < a.length; index += 1) {
        diff |= a[index] ^ (b[index] ?? 0);
    }
    return diff === 0;
};

/** 写缓存用的独立令牌（环境变量 `AI_CACHE_WRITE_TOKEN`），带头 `X-Folia-Cache-Token`。 */
export const CACHE_WRITE_TOKEN_HEADER = 'X-Folia-Cache-Token';

/**
 * 写缓存的准入门（issue C6）。
 *
 * 云缓存是**全局共享**的一张表：一条写入会影响所有人拿到的主题。所以写入不能对公网开放 ——
 * 谁能写、写的是谁的条目，必须有依据。两种准入，都代表「这台机器被记录在案」：
 *
 *  1. **管理员会话**：自己在面板里看得到、捞得回、删得掉那些条目的人，当然也能写。
 *  2. **写入令牌**（`AI_CACHE_WRITE_TOKEN`）：给客户端签发的独立凭证。它和 `SYNC_TOKEN`
 *     分开，是因为读缓存的人本来就没有 token；写和读用两把钥匙，泄露一把不至于两边都失守。
 *     没配这个变量时只有管理员能写（安全默认：不配就不开）。
 *
 * 不在这里做同源校验：客户端是原生 App（OkHttp），没有 Origin，服务端也不该因此拒绝它。
 */
/**
 * 写缓存这道门认定之后，把「是谁」放进上下文，写库时记进 `ai_cache.writer`。
 *
 * 记的是凭证的标识而不是凭证本身：令牌只记它的指纹前缀（够对上是哪把钥匙，又不至于
 * 把钥匙抄进库和日志）；管理员记用户名。追责与吊销靠的就是这一列。
 */
export type CacheWriterEnv = { Bindings: Env; Variables: { cacheWriter: string } };
/** 令牌的标识：SHA-256 前 12 位。同一个令牌每次算出来都一样，反推不出令牌。 */
const tokenTag = async (token: string): Promise<string> => (
    (await credentialTag({ username: 'cache-write-token', password: token })).slice(0, 12)
);

/** 见 `requireCacheWriter`：管理员会话或 `AI_CACHE_WRITE_TOKEN`，两种准入都代表「被记录在案」。 */
export const requireCacheWriter: MiddlewareHandler<CacheWriterEnv> = async (c, next: Next) => {
    c.header('Cache-Control', 'no-store');
    const configured = String(c.env.AI_CACHE_WRITE_TOKEN ?? '').trim();
    if (configured) {
        const supplied = String(c.req.header(CACHE_WRITE_TOKEN_HEADER) ?? '');
        if (supplied && equalsConstantTime(supplied, configured)) {
            c.set('cacheWriter', `token:${await tokenTag(configured)}`);
            await next();
            return;
        }
    }
    /* 令牌没给或不对，再看管理员会话：面板登录期间用 curl 写也照样放行。 */
    const username = readAdminCredentials(c.env) ? await readCacheWriterAdminSession(c) : null;
    if (username) {
        c.set('cacheWriter', `admin:${username}`);
        await next();
        return;
    }
    /*
     * 两种准入都没配（连管理员都没有）：这是部署方没开门，不是请求方的错 —— 回 503 而不是
     * 401，否则运维看了只会一直怀疑客户端的 token 写错了。
     */
    if (!configured && !readAdminCredentials(c.env)) {
        return c.json({ ok: false, error: 'cache_write_not_configured' }, 503);
    }
    return c.json({ ok: false, error: 'unauthorized' }, 401);
};

/** Cheap housekeeping: expired rows are swept whenever the panel is opened. */
export const pruneExpiredSessions = async (db: Env['FOLIA_SYNC_DB']): Promise<void> => {
    await db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?')
        .bind(new Date().toISOString())
        .run();
};

export const createAdminSession = async (db: Env['FOLIA_SYNC_DB'], credentials: AdminCredentials): Promise<string> => {
    const token = newToken();
    const now = new Date().toISOString();
    await db
        .prepare('INSERT INTO admin_sessions (token, username, created_at, expires_at, credential_tag) VALUES (?, ?, ?, ?, ?)')
        .bind(token, credentials.username, now, new Date(Date.now() + SESSION_TTL_MS).toISOString(), await credentialTag(credentials))
        .run();
    return token;
};

export const destroyAdminSession = async (db: Env['FOLIA_SYNC_DB'], token: string): Promise<void> => {
    if (!token) return;
    await db.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(token).run();
};

const admin = new Hono<AdminEnv>();

admin.post('/login', async (c) => {
    let username = '';
    let password = '';
    const contentType = String(c.req.header('Content-Type') || '');
    if (contentType.includes('application/json')) {
        const body = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => null);
        username = String(body?.username ?? '');
        password = String(body?.password ?? '');
    } else {
        const form = await c.req.parseBody().catch(() => null) as Record<string, unknown> | null;
        username = String(form?.username ?? '');
        password = String(form?.password ?? '');
    }
    const expected = readAdminCredentials(c.env);
    if (!expected) return c.json({ ok: false, error: 'admin_not_configured' }, 503);
    if (username.trim() !== expected.username || password !== expected.password) {
        return c.json({ ok: false, error: 'invalid_credentials' }, 401);
    }
    const token = await createAdminSession(c.env.FOLIA_SYNC_DB, expected);
    setCookie(c, ADMIN_COOKIE, token, sessionCookieOptions(c));
    return c.json({ ok: true, username: expected.username, usingDefault: false });
});

admin.post('/logout', async (c) => {
    await destroyAdminSession(c.env.FOLIA_SYNC_DB, getCookie(c, ADMIN_COOKIE) || '');
    deleteCookie(c, ADMIN_COOKIE, { path: '/' });
    return c.json({ ok: true });
});

admin.get('/session', async (c) => {
    const username = await readAdminSession(c);
    return c.json({ ok: true, signedIn: Boolean(username), username, usingDefault: false });
});

export default admin;
