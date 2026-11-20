import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/mod-system/androidModsBridgeSecrets.test.ts
// 安卓桥上的 `invokeModSecrets`（issue M13）。
//
// 症状：安卓插件的 24 个 `@PluginMethod` 里没有 `invokeModSecrets`，shim 恒回
// `unsupported-on-android`，而 `folium/secrets.ts` 把每个失败转成异常 —— 于是文档里写着的
// `folium.secrets` 在安卓上「每次调用都抛错」，且被那句告警的 no-electron-bridge 白名单静默吞掉。
// 这里钉住两件事：shim 真的把调用转给插件（而不是一如既往地回 unsupported），
// 以及插件的失败原因原样回到调用方（不被兜成 node-unavailable）。

type Call = { modId: string; operation: string; key?: unknown; value?: unknown };

const native = vi.hoisted(() => {
    const state = {
        ready: true,
        calls: [] as Call[],
        // 宿主那一层怎么答：按 operation 给出信封，测试用例自己覆盖。
        answer: (_call: Call): Promise<unknown> => Promise.resolve({ ok: true, result: null }),
        rejects: null as Error | null,
    };
    return state;
});

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
    },
    registerPlugin: () => ({
        getNodeState: async () => ({ ready: native.ready, failure: null }),
        invokeModSecrets: async (call: Call) => {
            native.calls.push(call);
            if (native.rejects) throw native.rejects;
            return native.answer(call);
        },
        // 用不到，但 shim 会引用 addListener 的插件名表之外的方法时会炸得莫名其妙，给个空实现。
        addListener: async () => ({ remove: () => {} }),
        call: async () => ({ ok: true, result: null }),
    }),
}));

import { createAndroidModsBridge } from '@/mods/android/androidModsBridge';

// 渲染端 shim 的类型按 Electron preload 写，安卓这份只实现了一部分；这里只取用得上的方法。
type SecretsBridge = {
    invokeModSecrets: (
        modId: string,
        operation: string,
        key?: string | readonly string[],
        value?: string | null,
    ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
};

const bridge = () => (createAndroidModsBridge() as unknown as SecretsBridge);

beforeEach(() => {
    native.ready = true;
    native.calls.length = 0;
    native.rejects = null;
    native.answer = () => Promise.resolve({ ok: true, result: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('安卓桥的 invokeModSecrets（M13）', () => {
    it('把调用转给原生插件，不再回 unsupported-on-android', async () => {
        native.answer = () => Promise.resolve({ ok: true, result: 'sk-stored' });
        const settled = await bridge().invokeModSecrets('m', 'get', 'apiKey');
        expect(settled).toEqual({ ok: true, result: 'sk-stored' });
        expect(native.calls).toEqual([{ modId: 'm', operation: 'get', key: 'apiKey', value: null }]);
    });

    it('declare 的键原样交出去，state 的结果原样拿回来', async () => {
        native.answer = () => Promise.resolve({ ok: true, result: { persistent: false, stored: ['apiKey'] } });
        const declared = await bridge().invokeModSecrets('m', 'declare', ['apiKey', 'token']);
        expect(declared).toEqual({ ok: true, result: { persistent: false, stored: ['apiKey'] } });
        expect(native.calls[0]).toEqual({ modId: 'm', operation: 'declare', key: ['apiKey', 'token'], value: null });

        const state = await bridge().invokeModSecrets('m', 'state');
        expect(state).toEqual({ ok: true, result: { persistent: false, stored: ['apiKey'] } });
    });

    it('写值把 value 带过去，清空就是 null', async () => {
        await bridge().invokeModSecrets('m', 'set', 'apiKey', 'sk-new');
        await bridge().invokeModSecrets('m', 'set', 'apiKey', null);
        expect(native.calls.map(({ key, value }) => [key, value])).toEqual([
            ['apiKey', 'sk-new'],
            ['apiKey', null],
        ]);
    });

    it('宿主的拒绝原因原样回给调用方，不被兜成 node-unavailable', async () => {
        // Capacitor 在 ok:false 时让 Promise reject，宿主那层最后也变成抛出的 message。
        native.rejects = new Error('secret-undeclared:apiKey');
        const settled = await bridge().invokeModSecrets('m', 'set', 'apiKey', 'x');
        expect(settled).toEqual({ ok: false, error: 'secret-undeclared:apiKey' });
    });

    it('Node 未就绪时才回 node-unavailable', async () => {
        native.ready = false;
        // waitForNode 轮询 40 次 × 100ms；把定时器换成立刻返回，用例才不会真的等 4 秒。
        // 用 vi.stubGlobal 而不是直接赋值：Node 的 setTimeout 是写死的 getter，直接赋会静默失败。
        vi.stubGlobal('setTimeout', (fn: () => void) => {
            fn();
            return 0;
        });
        try {
            const settled = await bridge().invokeModSecrets('m', 'get', 'apiKey');
            expect(settled).toEqual({ ok: false, error: 'node-unavailable' });
            expect(native.calls).toEqual([]);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
