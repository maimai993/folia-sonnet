import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../sync-server/src/app';
import { D1Emulator } from '../../../sync-server/src/d1-emulator';
import { cacheDigest } from '../../../sync-server/src/aiCacheDigest';
import { md5 } from '../../../sync-server/src/md5';

// test/unit/sync-server/aiCacheWriteAdmission.test.ts
// AI 云缓存的写入准入、核验与内容摘要（issue C6）。
//
// 这张表是**全局共享**的：一条被冒名写入的条目会喂给所有拉到它的播放器。所以要钉住四件事：
//
//  1. **配了凭证就只认凭证**：配了写入令牌时，没带或带错的 PUT 一律 401；
//     管理员会话是另一条准入。部署方两样都没配时放行并记成 `anonymous` ——
//     云缓存是公开服务，写入还有歌词核验兜底（见下面那条用例）。
//  2. **核验不能降级**：`AI_CACHE_VERIFY=off` 这条关掉核验的开关已经删了；不带 lyricHash
//     不再放行；平台取不到歌词也不再放行。三种以前都能把核验绕过去的路径，现在全部拒。
//  3. **内容有摘要**：写进去的每一版都带一个绑定「写在哪 + 谁写的 + 内容」的 SHA-256。
//  4. **请求体有上限**：超过 128KB 直接 413，连解析都不做。

const WRITE_TOKEN = 'synthetic-cache-write-token';
const db = new D1Emulator(':memory:');
const key = 'c'.repeat(32);

const env = {
    FOLIA_SYNC_DB: db,
    SYNC_TOKEN: 'synthetic-sync-only',
    ADMIN_USERNAME: 'synthetic-admin',
    ADMIN_PASSWORD: 'synthetic-password-only',
    AI_CACHE_WRITE_TOKEN: WRITE_TOKEN,
};

const request = (
    route: string,
    init?: RequestInit,
    environment: Record<string, unknown> = env,
) => app.request(`https://synthetic.invalid${route}`, init, environment as never);

/** 一份「纯音乐」上传：服务端自己就能用歌名重算哈希，不必去问平台（这里 `fetch` 是被禁的）。 */
const purePayload = (songTitle = 'Synthetic Song') => ({
    payload: {
        theme: {
            light: { backgroundColor: '#ffffff', primaryColor: '#111111', accentColor: '#ff0000' },
            dark: { backgroundColor: '#000000', primaryColor: '#eeeeee', accentColor: '#00ffff' },
        },
        decision: { mode: 'classic', reason: '均衡', params: {} },
    },
    songTitle,
    provider: 'synthetic',
    model: 'test',
    platform: 'qq',
    isPureMusic: true,
    lyricHash: md5(songTitle),
});

const put = (
    body: unknown,
    options: { token?: string | null; cacheKey?: string; headers?: Record<string, string> } = {},
) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
    if (options.token !== null) headers['X-Folia-Cache-Token'] = options.token ?? WRITE_TOKEN;
    return request(`/api/ai-cache/stage/${options.cacheKey ?? key}`, {
        method: 'PUT',
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
};

const rowCount = async () => Number(
    (await db.prepare('SELECT COUNT(*) AS n FROM ai_cache').first<{ n: number }>())?.n ?? 0,
);

beforeAll(async () => {
    /*
     * 平台歌词接口在这里一律不可用。这是刻意的：下面的用例要证明「平台取不到歌词时拒写」，
     * 而真的去访问第三方接口会让单测依赖网络。
     */
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network access is forbidden in this suite'); }));
    /* 建表是在第一次请求时懒做的（app.ts 的 ensureSchema），先打一次把它建出来。 */
    expect((await request('/health')).status).toBe(200);
});

beforeEach(async () => {
    await db.prepare('DELETE FROM ai_cache_backups').run();
    await db.prepare('DELETE FROM ai_cache').run();
    await db.prepare('DELETE FROM ai_cache_hits').run();
});

afterAll(() => {
    /*
     * 不在这里断言 fetch 一次都没被调用：上面那条「平台取不到歌词」的用例**故意**会去搜平台
     * （服务端不搜就不知道有没有这首歌），而这里的 fetch 被打成抛错，`fetchText` 把异常吞成
     * null，于是正好表现为「平台不可用」—— 那正是要验的场景。只要每一次都失败即可。
     */
    vi.unstubAllGlobals();
    (db as unknown as { db: { close(): void } }).db.close();
});

describe('写入准入（issue C6）', () => {
    it('没有凭证的 PUT 回 401，且一行都不写', async () => {
        const before = await rowCount();
        const response = await put(purePayload(), { token: null });
        expect(response.status).toBe(401);
        expect((await response.json()).error).toBe('unauthorized');
        expect(await rowCount()).toBe(before);
    });

    it('凭证不对也是 401', async () => {
        const response = await put(purePayload(), { token: 'wrong-token' });
        expect(response.status).toBe(401);
    });

    it('管理员会话也能写（面板登录期间用脚本写照样放行），并记成 admin 来源', async () => {
        const login = await request('/admin/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        const response = await request(`/api/ai-cache/stage/${key}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', Cookie: cookie },
            body: JSON.stringify(purePayload()),
        });
        expect(response.status).toBe(200);
        const row = await db.prepare('SELECT writer FROM ai_cache WHERE cache_key = ?').bind(key).first<{ writer: string }>();
        expect(row?.writer).toBe(`admin:${env.ADMIN_USERNAME}`);
    });

    /*
     * 部署方两样都没配：**放行**，记成 anonymous。
     *
     * 这里原来是 503（「没开门」）。改成放行的理由：云缓存本身是公开服务，读全开放，
     * 写的内容还要过歌词核验与摘要；而 503 让默认部署一点缓存都攒不起来，这个功能等于
     * 不存在。想收紧的部署方配 `AI_CACHE_WRITE_TOKEN` 即可 —— 配了之后没带对令牌一律 401，
     * 上面那两条用例钉的就是那个方向。
     */
    it('连写入凭证都没有配置时放行，并记成 anonymous', async () => {
        const bare = { FOLIA_SYNC_DB: db, SYNC_TOKEN: 'synthetic-sync-only' };
        const response = await app.request(
            `https://synthetic.invalid/api/ai-cache/stage/${key}`,
            { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(purePayload()) },
            bare as never,
        );
        expect(response.status).toBe(200);
        const row = await db.prepare('SELECT writer FROM ai_cache WHERE cache_key = ?').bind(key).first<{ writer: string }>();
        expect(row?.writer).toBe('anonymous');
    });

    /* 放行归放行，歌词核验照旧 —— 开放部署不等于什么都不查。 */
    it('开放部署下，不带 lyricHash 依然拒写', async () => {
        const bare = { FOLIA_SYNC_DB: db, SYNC_TOKEN: 'synthetic-sync-only' };
        const body = purePayload();
        delete (body as { lyricHash?: string }).lyricHash;
        const response = await app.request(
            `https://synthetic.invalid/api/ai-cache/stage/${key}`,
            { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
            bare as never,
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('no_lyric_evidence');
    });
});

describe('核验不可降级（issue C6）', () => {
    /*
     * 以前三条降级路径各放行一次：
     *   · `AI_CACHE_VERIFY=off` 一键关掉核验；
     *   · 不带 lyricHash → 「无从校验，放行」；
     *   · 平台取不到歌词 → 「上游抖动，放行」。
     * 三条都能被一句手写的请求利用，而后果是所有人的主题。现在全部拒。
     */
    it('不带 lyricHash 直接拒（以前是放行）', async () => {
        const before = await rowCount();
        const body = purePayload();
        delete (body as { lyricHash?: string }).lyricHash;
        const response = await put(body);
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('no_lyric_evidence');
        expect(await rowCount()).toBe(before);
    });

    it('平台取不到歌词时拒写，不降级放行（以前是放行）', async () => {
        const before = await rowCount();
        /* 不是纯音乐、又不是歌名能断言的：服务端得去平台搜，而这里搜不到。 */
        const response = await put({
            ...purePayload('Some Song'),
            isPureMusic: false,
            lyricHash: md5('一段谁也没见过的歌词'),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('lyric_unavailable');
        expect(await rowCount()).toBe(before);
    });

    /*
     * 老的那个「关掉核验」环境变量已经不读了。把环境变量设成 `off` 也必须照旧拦下 ——
     * 否则部署方留着一份老配置，就等于忘记关掉一个后门。
     */
    it('设置 AI_CACHE_VERIFY=off 不再能绕开核验', async () => {
        const body = purePayload();
        delete (body as { lyricHash?: string }).lyricHash;
        const response = await request(
            `/api/ai-cache/stage/${key}`,
            {
                method: 'PUT',
                headers: { 'content-type': 'application/json', 'X-Folia-Cache-Token': WRITE_TOKEN },
                body: JSON.stringify(body),
            },
            { ...env, AI_CACHE_VERIFY: 'off' },
        );
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('no_lyric_evidence');
    });

    it('空数据一律拒，且不产生备份', async () => {
        const response = await put({ ...purePayload(), payload: {} });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('empty_payload');
        expect(await rowCount()).toBe(0);
    });
});

describe('内容摘要（issue C6）', () => {
    it('写进去的每一版都带绑定来源与内容的摘要', async () => {
        const response = await put(purePayload());
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.entry.verifyKey).toBe('folia-cache-digest-v1');
        expect(body.entry.writer).toMatch(/^token:/);
        expect(body.entry.payloadDigest).toMatch(/^[a-f0-9]{64}$/);

        /* 库里那一列和响应里那份是同一个值。 */
        const row = await db
            .prepare('SELECT payload_digest, writer, payload_json, kind, cache_key FROM ai_cache WHERE cache_key = ?')
            .bind(key)
            .first<{ payload_digest: string; writer: string; payload_json: string; kind: string; cache_key: string }>();
        expect(row?.payload_digest).toBe(body.entry.payloadDigest);

        /* 照着同一套规则复算一遍能对上 —— 客户端就是这么验的。 */
        const expected = await cacheDigest({
            kind: row!.kind,
            key: row!.cache_key,
            writer: row!.writer,
            payloadJson: row!.payload_json,
        });
        expect(expected).toBe(row!.payload_digest);
    });

    it('读出来的条目带着摘要与来源', async () => {
        expect((await put(purePayload())).status).toBe(200);
        const response = await request(`/api/ai-cache/stage/${key}`);
        const body = await response.json();
        expect(body.hit).toBe(true);
        expect(body.entry.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(body.entry.writer).toMatch(/^token:/);
        expect(body.entry.verifyKey).toBe('folia-cache-digest-v1');
    });

    /*
     * 摘要绑定「写在哪」：同一份内容、同一个写入者，挪到另一个键上就应该是另一个摘要。
     * 否则把 A 歌的答案搬到 B 歌的键下就验不出来了。
     */
    it('同一个内容换个键就是另一个摘要', async () => {
        const other = 'd'.repeat(32);
        expect((await put(purePayload())).status).toBe(200);
        const first = (await (await request(`/api/ai-cache/stage/${key}`)).json()).entry.payloadDigest;
        expect((await put(purePayload(), { cacheKey: other })).status).toBe(200);
        const second = (await (await request(`/api/ai-cache/stage/${other}`)).json()).entry.payloadDigest;
        expect(second).not.toBe(first);
    });

    it('覆盖之后来源与摘要跟着换，旧版整条进备份', async () => {
        expect((await put(purePayload())).status).toBe(200);
        const first = (await (await request(`/api/ai-cache/stage/${key}`)).json()).entry;
        /* 内容真的换一份：同样是纯音乐，但主题配色不同 —— 摘要必须跟着变。 */
        const changed = purePayload();
        changed.payload.theme.light.backgroundColor = '#123456';
        expect((await put(changed)).status).toBe(200);
        const second = (await (await request(`/api/ai-cache/stage/${key}`)).json()).entry;
        expect(second.payloadDigest).not.toBe(first.payloadDigest);

        const backup = await db
            .prepare('SELECT payload_digest, writer FROM ai_cache_backups WHERE cache_key = ?')
            .bind(key)
            .first<{ payload_digest: string; writer: string }>();
        expect(backup?.payload_digest).toBe(first.payloadDigest);
        expect(backup?.writer).toBe(first.writer);
    });
});

describe('请求体上限（issue C6）', () => {
    it('超过 128KB 的请求体直接 413，不解析也不写', async () => {
        const huge = JSON.stringify({ ...purePayload(), filler: 'x'.repeat(200 * 1024) });
        const before = await rowCount();
        const response = await put(huge);
        expect(response.status).toBe(413);
        expect((await response.json()).error).toBe('payload_too_large');
        expect(await rowCount()).toBe(before);
    });

    it('声明了 Content-Length 且超限时连正文都不读', async () => {
        const response = await request(`/api/ai-cache/stage/${key}`, {
            method: 'PUT',
            headers: {
                'content-type': 'application/json',
                'X-Folia-Cache-Token': WRITE_TOKEN,
                'content-length': String(1024 * 1024),
            },
            body: JSON.stringify(purePayload()),
        });
        expect(response.status).toBe(413);
    });
});

describe('公开读不受影响（issue C6 的边界）', () => {
    /* 读这条路必须继续公开：没填 Key 的人拿到的就是别人写好的那份。 */
    it('GET 不需要任何凭证', async () => {
        expect((await put(purePayload())).status).toBe(200);
        const response = await request(`/api/ai-cache/stage/${key}`);
        expect(response.status).toBe(200);
        expect((await response.json()).hit).toBe(true);
    });

    it('按键格式不对仍是 400', async () => {
        const response = await put(purePayload(), { cacheKey: 'not-a-key' });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe('invalid_key');
    });
});
