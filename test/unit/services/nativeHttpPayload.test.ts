// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/nativeHttpPayload.test.ts
// 原生桥的响应体有**两种形状**（#262）：文本类回 bodyText，二进位回 bodyBase64。
// 这里钉三件事：
//   1. 两条读取 helper 对两种形状都给出正确字节 / 文本，且 bodyText 优先；
//   2. `createNativeFetch` 会把上限（#261 的 maxBytes）传给原生，默认值就是 8MiB；
//   3. 原生只回 base64 的旧版本（bodyText 缺席）照样能读 —— 新 JS 要能配旧原生。

const { calls } = vi.hoisted(() => ({
    calls: {
        response: null as null | Record<string, unknown>,
        lastRequest: null as null | Record<string, unknown>,
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
    },
    registerPlugin: () => ({
        httpRequest: async (options: Record<string, unknown>) => {
            calls.lastRequest = options;
            return calls.response ?? {};
        },
    }),
}));

const { decodeNativeBody, decodeNativePayload, nativePayloadBytes } = await import('@/platform/foliaNative');
const { NATIVE_HTTP_MAX_RESPONSE_BYTES, createNativeFetch } = await import('@/services/nativeHttpFetch');

const utf8 = (value: string): number[] => Array.from(new TextEncoder().encode(value));
const base64Of = (bytes: number[]): string => btoa(String.fromCharCode(...bytes));

describe('原生响应体的两种形状', () => {
    it('bodyText 直接编回字节，不经过 base64', () => {
        expect(Array.from(nativePayloadBytes({ status: 200, bodyText: '世界' }))).toEqual(utf8('世界'));
    });

    it('bodyBase64 解回字节（旧原生只回这一种）', () => {
        const bytes = [0x68, 0x69, 0xff, 0x00];
        expect(Array.from(nativePayloadBytes({ status: 200, bodyBase64: base64Of(bytes) }))).toEqual(bytes);
    });

    it('两种都缺席时给空数组，不是异常', () => {
        expect(nativePayloadBytes({ status: 204 }).length).toBe(0);
        expect(nativePayloadBytes(null).length).toBe(0);
        expect(decodeNativePayload(undefined)).toBe('');
    });

    it('bodyText 与 bodyBase64 同时存在时以 bodyText 为准', () => {
        const payload = { status: 200, bodyText: 'hello', bodyBase64: base64Of([0x41, 0x41]) };
        expect(decodeNativePayload(payload)).toBe('hello');
        expect(Array.from(nativePayloadBytes(payload))).toEqual(utf8('hello'));
    });

    it('decodeNativeBody 仍按 base64 解（旧调用点兼容）', () => {
        expect(decodeNativeBody(base64Of(utf8('怪天气')))).toBe('怪天气');
        expect(decodeNativeBody(undefined)).toBe('');
    });

    /*
     * 原生用 CharsetDecoder 严格解码，它**不剥** BOM；走 base64 的旧路径由 TextDecoder 剥。
     * 不补这一刀，带 BOM 的 JSON（更新清单、资料库接口）会 JSON.parse 失败。
     */
    it('bodyText 开头的 BOM 会被剥掉', () => {
        expect(decodeNativePayload({ status: 200, bodyText: '\uFEFF{"a":1}' })).toBe('{"a":1}');
        expect(Array.from(nativePayloadBytes({ status: 200, bodyText: '\uFEFFhi' }))).toEqual(utf8('hi'));
        // 中间和结尾的 U+FEFF 不是 BOM，不许动。
        expect(decodeNativePayload({ status: 200, bodyText: 'a\uFEFFb' })).toBe('a\uFEFFb');
    });
});

describe('createNativeFetch 的上限与读取', () => {
    beforeEach(() => {
        calls.response = null;
        calls.lastRequest = null;
        (globalThis as unknown as { window: { Capacitor: unknown } }).window.Capacitor = {
            isNativePlatform: () => true,
            getPlatform: () => 'android',
            isPluginAvailable: () => true,
            Plugins: {
                FoliaNative: {
                    httpRequest: async (options: Record<string, unknown>) => {
                        calls.lastRequest = options;
                        return calls.response ?? {};
                    },
                },
            },
        };
    });

    it('默认把 8MiB 上限交给原生', async () => {
        calls.response = { status: 200, bodyText: 'ok' };
        await createNativeFetch(1000)('https://example.com/api');
        expect(calls.lastRequest?.maxBytes).toBe(NATIVE_HTTP_MAX_RESPONSE_BYTES);
        expect(NATIVE_HTTP_MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
    });

    it('调用方可以显式放宽上限（字体本体那条）', async () => {
        calls.response = { status: 200, bodyText: 'ok' };
        await createNativeFetch(1000, 24 * 1024 * 1024)('https://example.com/font.ttf');
        expect(calls.lastRequest?.maxBytes).toBe(24 * 1024 * 1024);
    });

    it('文本响应按 bodyText 还原成 Response', async () => {
        calls.response = { status: 200, bodyText: '{"hello":"世界"}' };
        const response = await createNativeFetch(1000)('https://example.com/api');
        expect(await response.text()).toBe('{"hello":"世界"}');
    });

    it('二进位响应按 bodyBase64 还原成 Response', async () => {
        const bytes = [0x89, 0x50, 0x4e, 0x47];
        calls.response = { status: 200, bodyBase64: base64Of(bytes) };
        const response = await createNativeFetch(1000)('https://example.com/a.png');
        expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(bytes);
    });

    /*
     * 超上限时原生直接 reject（#261）。这里钉两件事：错误照原样抛给调用方，
     * 以及留一条能定位「哪台主机的响应太大」的日志（不记查询串）。
     */
    it('超上限的错误照原样抛出，并记一条带主机名的日志', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const plugin = (globalThis as unknown as {
            window: { Capacitor: { Plugins: { FoliaNative: { httpRequest: () => Promise<unknown> } } } };
        }).window.Capacitor.Plugins.FoliaNative;
        const original = plugin.httpRequest;
        plugin.httpRequest = async () => {
            throw new Error('Native HTTP response exceeds the bridge size limit');
        };
        try {
            await expect(
                createNativeFetch(1000)('https://sync.example.com/themes/list?token=secret'),
            ).rejects.toThrow('bridge size limit');
            expect(warn).toHaveBeenCalledTimes(1);
            const logged = JSON.stringify(warn.mock.calls[0]);
            expect(logged).toContain('sync.example.com');
            // 查询串里的凭据不许进日志。
            expect(logged).not.toContain('secret');
        } finally {
            plugin.httpRequest = original;
            warn.mockRestore();
        }
    });
});
