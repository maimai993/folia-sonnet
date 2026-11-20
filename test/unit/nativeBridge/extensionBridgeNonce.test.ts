// test/unit/nativeBridge/extensionBridgeNonce.test.ts
//
// M2：页面与桥之间的 postMessage 通道不再只凭一个公开字符串认身份。
//
// 改动之前，`foliaExtensionBridge` 发给桥的消息只带 `source: 'folia-web-page'`（一个谁都能
// 写死的字符串），认响应只看 `source: 'folia-extension-bridge'` + `id`。同页任何脚本都能
// 监听 postMessage 拿到 id，然后抢先发一条伪响应 —— 页面就会拿攻击者的数据完成登录 / 歌单
// 请求，或者用 ok:false 让取数稳定失败。
//
// 现在：页面在模块加载时生成一个随机 nonce，握手（PING）带过去，桥在 PONG / READY 里回显，
// 此后每一条响应都必须带同一个 nonce，否则直接丢掉。没有 crypto.getRandomValues 时判桥不可用。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: MessageEvent) => void;

/** 一个够用的 window：postMessage 把消息派给同页监听器，并记下 targetOrigin。 */
const installWindow = () => {
    const listeners: Listener[] = [];
    const postMessage = vi.fn((data: unknown, targetOrigin: string) => {
        posted.push({ data: data as Record<string, any>, targetOrigin });
        // 同页派发：桥（以及伪造者）都会收到。
        window.setTimeout(() => {
            listeners.forEach((listener) => listener({ source: window, data } as unknown as MessageEvent));
        }, 0);
    });
    const posted: Array<{ data: Record<string, any>; targetOrigin: string }> = [];
    const win: any = {
        location: { origin: 'https://localhost' },
        addEventListener: (type: string, listener: Listener) => {
            if (type === 'message') listeners.push(listener);
        },
        removeEventListener: (type: string, listener: Listener) => {
            if (type !== 'message') return;
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
        },
        postMessage,
        setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms) as unknown as number,
        clearTimeout: (handle: number) => clearTimeout(handle),
        open: () => null,
    };
    // event.source 必须等于 window 本身才被认，所以派发时用这个同一个对象。
    vi.stubGlobal('window', win);
    vi.stubGlobal('crypto', {
        getRandomValues: (bytes: Uint8Array) => {
            for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7 + 3) & 0xff;
            return bytes;
        },
        randomUUID: () => '11111111-2222-3333-4444-555555555555',
    });
    return { posted, listeners, win };
};

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** 这一会话的 nonce（从 PING 里取，模拟「桥收到并记下来了」）。 */
const nonceFromPing = (posted: Array<{ data: Record<string, any> }>): string => {
    const ping = posted.find((entry) => entry.data.type === 'FOLIA_BRIDGE_PING');
    if (!ping) throw new Error('no PING was posted');
    return String(ping.data.nonce);
};

/** 替身桥：收到 PING 就回带 nonce 的 PONG（真实的桥/扩展就是这么做的）。 */
const answerPing = async (posted: Array<{ data: Record<string, any> }>) => {
    await vi.waitFor(() => {
        expect(posted.some((entry) => entry.data.type === 'FOLIA_BRIDGE_PING')).toBe(true);
    });
    window.postMessage({
        source: 'folia-extension-bridge',
        type: 'FOLIA_BRIDGE_PONG',
        version: '0.0.1',
        nonce: nonceFromPing(posted),
    }, 'https://localhost');
};

describe('页面与桥的会话 nonce（M2）', () => {
    it('握手必须带回这一会话的 nonce，否则不算桥就绪', async () => {
        const { posted } = installWindow();
        const bridge = await import('../../../src/services/foliaExtensionBridge.js');

        const ready = bridge.isFoliaExtensionBridgeAvailable();
        await Promise.resolve();
        // PING 里带了 nonce，而且 targetOrigin 收窄到了本页 origin。
        expect(posted[0].data.type).toBe('FOLIA_BRIDGE_PING');
        expect(typeof posted[0].data.nonce).toBe('string');
        expect(posted[0].data.nonce.length).toBe(32);
        expect(posted[0].targetOrigin).toBe('https://localhost');

        // 伪造的 PONG：source 与 type 都对，就是没有（或换了一个）nonce。
        window.postMessage({ source: 'folia-extension-bridge', type: 'FOLIA_BRIDGE_PONG', version: '0.0.1' }, 'https://localhost');
        await vi.waitFor(() => {
            expect(posted.length).toBeGreaterThan(0);
        });
        // 再等一小会儿，确认它没有把桥判成就绪。
        await new Promise((resolve) => setTimeout(resolve, 20));
        const settledEarly = await Promise.race([ready, Promise.resolve('pending')]);
        expect(settledEarly).toBe('pending');
    });

    it('带对 nonce 的响应才算数，伪造的响应被丢弃', async () => {
        const { posted } = installWindow();
        const bridge = await import('../../../src/services/foliaExtensionBridge.js');

        // 桥先握手成功（真实桥会回显 nonce）。
        const readiness = bridge.isFoliaExtensionBridgeAvailable();
        await answerPing(posted);
        await expect(readiness).resolves.toBe(true);

        const pending = bridge.requestFoliaExtension({ platform: 'netease', action: 'ping' } as any);
        pending.catch(() => undefined);
        await vi.waitFor(() => {
            expect(posted.some((entry) => entry.data.type === 'FOLIA_API_REQUEST')).toBe(true);
        });
        const request = posted.find((entry) => entry.data.type === 'FOLIA_API_REQUEST')!;
        const nonce = request.data.nonce;
        expect(typeof nonce).toBe('string');

        // 伪造者知道 id 与 source，但不知道 nonce：这条响应必须被丢掉。
        window.postMessage({
            source: 'folia-extension-bridge',
            type: 'FOLIA_API_RESPONSE',
            id: request.data.id,
            ok: true,
            data: { forged: true },
        }, 'https://localhost');
        await new Promise((resolve) => setTimeout(resolve, 20));
        const afterForgery = await Promise.race([pending, Promise.resolve('pending')]);
        expect(afterForgery).toBe('pending');

        // 真的桥带着 nonce 回来，这条才被认。
        window.postMessage({
            source: 'folia-extension-bridge',
            type: 'FOLIA_API_RESPONSE',
            id: request.data.id,
            nonce,
            ok: true,
            data: { genuine: true },
        }, 'https://localhost');
        await expect(pending).resolves.toEqual({ genuine: true });
    });
});
