import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/mod-system/foliumSecretsChannel.test.ts
// `folium.secrets` 的通道失败不许静默（issue M13）。
//
// 这里只测 folium/secrets.ts 自己：把 ipc 层的 `invokeModSecrets` / `subscribeModSecretChanges` 换成
// 假的，看它拿到 `{ ok: false }` 之后做了什么。issue 里那半截「安卓上每次调用都抛错、而且一句日志
// 都没有」就在这个文件的白名单里 —— 它把 `no-electron-bridge` 从告警里排除了，而安卓当时回的正是
// 「不支持」，另一种说法而已。现在：失败原因照样抛出（模组的行为不变），但要么进日志，要么本身
// 就是可识别的 `no-electron-bridge`（Web 预览根本没有通道，那一条继续不吵）。

const ipc = vi.hoisted(() => ({
    /** 每次 invokeModSecrets 回什么。 */
    replies: [] as Array<{ ok: boolean; result?: unknown; error?: string }>,
    calls: [] as Array<[string, string, unknown, unknown]>,
}));

vi.mock('@/mods/ipc', () => ({
    invokeModSecrets: async (modId: string, operation: string, key?: unknown, value?: unknown) => {
        ipc.calls.push([modId, operation, key, value]);
        return ipc.replies.shift() ?? { ok: true, result: null };
    },
    subscribeModSecretChanges: () => () => {},
}));

import { createFoliumSecrets, declareFoliumSecretKeys, readFoliumSecretsState } from '@/mods/folium/secrets';
import type { FoliumSecretAccess } from '@/mods/folium/contract';

const secrets = (modId = 'm'): FoliumSecretAccess => createFoliumSecrets(modId, 'main', () => {});

/** console.warn 的各个第一参数，排成一行行文本。 */
const warnedLines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((args) => String(args[0]));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    ipc.replies.length = 0;
    ipc.calls.length = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    warn.mockRestore();
});

describe('folium.secrets 的失败不再静默（M13）', () => {
    it('通道给的失败原因照样抛出，同时进一条日志', async () => {
        ipc.replies.push({ ok: false, error: 'mod-not-loaded' });
        await expect(secrets().get('apiKey')).rejects.toThrow('mod-not-loaded');
        const lines = warnedLines(warn);
        expect(lines).toEqual([expect.stringContaining('secrets.get failed: mod-not-loaded')]);
        // 日志里只有原因，没有任何值。
        expect(lines[0]).not.toContain('sk-');
    });

    it('has / set / state 走同一条路，各自记下自己的 operation', async () => {
        ipc.replies.push({ ok: false, error: 'secret-undeclared:apiKey' });
        await expect(secrets().has('apiKey')).rejects.toThrow('secret-undeclared:apiKey');

        ipc.replies.push({ ok: false, error: 'secret-too-large:8192' });
        await expect(secrets().set('apiKey', 'x')).rejects.toThrow('secret-too-large:8192');

        ipc.replies.push({ ok: false, error: 'mod-not-loaded' });
        await expect(readFoliumSecretsState('m')).rejects.toThrow('mod-not-loaded');

        expect(warnedLines(warn)).toEqual([
            expect.stringContaining('secrets.has failed: secret-undeclared:apiKey'),
            expect.stringContaining('secrets.set failed: secret-too-large:8192'),
            expect.stringContaining('secrets.state failed: mod-not-loaded'),
        ]);
    });

    it('没有模组通道（Web 预览）仍然不吵', async () => {
        ipc.replies.push({ ok: false, error: 'no-electron-bridge' });
        await expect(secrets().get('apiKey')).rejects.toThrow('no-electron-bridge');
        expect(warn).not.toHaveBeenCalled();
    });

    it('声明失败时 no-electron-bridge 之外一律上报', async () => {
        ipc.replies.push({ ok: false, error: 'secret-too-many-keys:64' });
        declareFoliumSecretKeys('declare-mod', ['apiKey']);
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        expect(String(warn.mock.calls[0][0])).toContain('could not be declared: secret-too-many-keys:64');
        expect(ipc.calls[0]).toEqual(['declare-mod', 'declare', ['apiKey'], undefined]);
    });

    it('成功时不留日志', async () => {
        ipc.replies.push({ ok: true, result: 'sk-value' });
        await expect(secrets().get('apiKey')).resolves.toBe('sk-value');
        expect(warn).not.toHaveBeenCalled();
    });
});
