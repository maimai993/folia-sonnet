import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// test/unit/mod-system/androidHostSecrets.test.ts
// 安卓宿主里 `secrets` op 的全表（issue M13）。
//
// 以前这一支只认 get / has / set / declare：`state` 落到 `secrets-unknown-operation:state`，
// 而设置表单读的正是它（哪些键有值、值能不能跨运行）。渲染端转发修好之后，这是最后一块
// 拼图。这里不改 host.js，直接用同一份 modSystem/modSecrets.cjs、按 op 表的形状驱动，
// 断言五支都对得上桌面端 electron/modSystem/modSystem.cjs 的实现。

const assetRoot = path.resolve('android/app/src/main/assets/folia-node');

type Secrets = {
    get: (modId: string, key: string) => Promise<string | null>;
    has: (modId: string, key: string) => Promise<boolean>;
    set: (modId: string, key: string, value: string | null) => Promise<void>;
    declare: (modId: string, keys: string[]) => number;
    state: (modId: string) => Promise<{ persistent: boolean; stored: string[] }>;
};

// 与 host.js 里那一份配置逐字同义：安卓没有 safeStorage，值只活在内存里。
const createHostSecrets = (userDataDir: string): Secrets => {
    const { createModSecrets } = require(path.join(assetRoot, 'modSystem/modSecrets.cjs')) as {
        createModSecrets: (options: Record<string, unknown>) => Secrets;
    };
    return createModSecrets({
        userDataDir,
        safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: () => {
                throw new Error('safeStorage-unavailable');
            },
            decryptString: () => {
                throw new Error('safeStorage-unavailable');
            },
        },
        platform: 'android',
        warn: () => {},
        log: () => {},
        onChange: () => {},
    });
};

/** host.js 里 `operations.secrets` 的那张 switch。 */
const secretsOperation = (secrets: Secrets) => async ({ modId, op, key, value }: {
    modId: string;
    op: string;
    key?: string;
    value?: unknown;
}) => {
    try {
        // 宿主的真身是 host.js 里那张 switch；这里对着它实际认的 op 走（`state` 以前落到默认分支）。
        if (op === 'state') {
            return { ok: true, result: await secrets.state(modId) };
        }
        switch (op) {
            case 'get':
                return { ok: true, result: await secrets.get(modId, key!) };
            case 'has':
                return { ok: true, result: await secrets.has(modId, key!) };
            case 'set':
                await secrets.set(modId, key!, (value ?? null) as string | null);
                return { ok: true, result: null };
            case 'declare':
                secrets.declare(modId, Array.isArray(value) ? value as string[] : []);
                return { ok: true, result: null };
            default:
                return { ok: false, error: `secrets-unknown-operation:${op}` };
        }
    } catch (caught) {
        return { ok: false, error: String((caught as Error)?.message ?? caught) };
    }
};

/**
 * host.js 自己那一张 op 表认不认 `state`。
 *
 * 上面那个镜头是照抄，改坏 host.js 它不会红；这一条直接读源文件，钉住 `secrets` 那一支里
 * 有没有 `state`（issue M13 里漏的正是这一支）。
 */
const hostSecretsOperations = (): string[] => {
    const source = fs.readFileSync(path.join(assetRoot, 'host.js'), 'utf8');
    const start = source.indexOf('secrets: async ({ modId, op, key, value }) =>');
    expect(start).toBeGreaterThan(-1);
    // 这一支到下一个顶层操作（`'net-fetch'`）为止。
    const end = source.indexOf("'net-fetch':", start);
    expect(end).toBeGreaterThan(start);
    return Array.from(source.slice(start, end).matchAll(/case '([a-z]+)':/g), (match) => match[1]);
};

let userDataDir: string;

beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-secrets-'));
});

afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('安卓宿主的 secrets op（M13）', () => {
    it('host.js 的 secrets 支认全五个 op，与桌面端一致', () => {
        expect(hostSecretsOperations()).toEqual(['get', 'has', 'set', 'declare', 'state']);
    });

    it('declare 之后能存能读，state 说得出哪些键有值、且只活本次运行', async () => {
        const secrets = createHostSecrets(userDataDir);
        const run = secretsOperation(secrets);
        expect(await run({ modId: 'm', op: 'declare', value: ['apiKey'] })).toEqual({ ok: true, result: null });
        expect(await run({ modId: 'm', op: 'set', key: 'apiKey', value: 'sk-live' })).toEqual({ ok: true, result: null });
        expect(await run({ modId: 'm', op: 'get', key: 'apiKey' })).toEqual({ ok: true, result: 'sk-live' });
        expect(await run({ modId: 'm', op: 'has', key: 'apiKey' })).toEqual({ ok: true, result: true });
        // 关键：state 不再落到 unknown-operation，表单据此画「已设置」与「仅本次运行」。
        expect(await run({ modId: 'm', op: 'state' })).toEqual({
            ok: true,
            result: { persistent: false, stored: ['apiKey'] },
        });
    });

    it('进程重启后读回 null、has 为 false，不抛异常', async () => {
        const before = secretsOperation(createHostSecrets(userDataDir));
        await before({ modId: 'm', op: 'declare', value: ['apiKey'] });
        await before({ modId: 'm', op: 'set', key: 'apiKey', value: 'sk-live' });

        const after = secretsOperation(createHostSecrets(userDataDir));
        expect(await after({ modId: 'm', op: 'get', key: 'apiKey' })).toEqual({ ok: true, result: null });
        expect(await after({ modId: 'm', op: 'has', key: 'apiKey' })).toEqual({ ok: true, result: false });
        // 明文没有落到盘上：整个数据目录里找不到那个值。
        const found = fs.readdirSync(userDataDir, { recursive: true, encoding: 'utf8' })
            .filter((entry) => fs.statSync(path.join(userDataDir, entry)).isFile())
            .some((entry) => fs.readFileSync(path.join(userDataDir, entry), 'utf8').includes('sk-live'));
        expect(found).toBe(false);
    });

    it('未声明的键写进去会被拒绝，原因可读', async () => {
        const run = secretsOperation(createHostSecrets(userDataDir));
        await run({ modId: 'm', op: 'declare', value: ['apiKey'] });
        const refused = await run({ modId: 'm', op: 'set', key: 'other', value: 'x' });
        expect(refused).toEqual({ ok: false, error: 'secret-undeclared:other' });
    });
});
