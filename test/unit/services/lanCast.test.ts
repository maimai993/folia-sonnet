import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// src/services/lanCast.ts 的投送租约与生命周期守卫：全部是合成桥，不发生网络 IO。

// 运行环境是 web（'web'），而投送能力探测要求「原生是安卓」—— 按 runtime.test.ts 的做法
// mock 掉 Capacitor 的平台判定；桥本身仍是下面各用例自己装的合成对象。
const capacitorState = vi.hoisted(() => ({ native: false, platform: 'web' }));

vi.mock('@capacitor/core', async (importOriginal) => {
    // 只换平台判定：其余（registerPlugin 等）保留真实现，别把整张桥打断。
    const actual = await importOriginal<typeof import('@capacitor/core')>();
    return {
        ...actual,
        Capacitor: {
            ...actual.Capacitor,
            isNativePlatform: () => capacitorState.native,
            getPlatform: () => capacitorState.platform,
        },
    };
});

const plugins: Record<string, any> = {};

const installBridge = () => {
    // lanCast.ts 直接用全局 location（Android 上就是 WebView 的地址），
    // 单测环境是 node，没有 location，要一起补上 —— 否则 isLoopbackUrl 会抛进 catch，
    // 把回环转发地址误判成「不是回环」，整条 prepare / 租约路径都被绕过。
    const origin = new URL('https://localhost/');
    vi.stubGlobal('location', origin);
    vi.stubGlobal('window', {
        Capacitor: { Plugins: plugins },
        location: origin,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });
    vi.stubGlobal('document', {
        visibilityState: 'visible',
        // i18n 的启动流程会写 documentElement.lang，这里给个最简形状。
        documentElement: { lang: '', dir: '' },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });
};

type LanCastModule = typeof import('@/services/lanCast');

/**
 * 「重新加载」lanCast 模块：模块里的租约与会话是模块级状态，用例之间要回到干净状态。
 *
 * 不用 `vi.resetModules()`：那会把 @capacitor/core 也重新加载一遍，它顶层的
 * `globalThis.Capacitor.Plugins` 会被重新读一遍，合成桥就丢了 —— 表现是 `cast()` 永远
 * 返回 null、prepare 一次都不调。改成显式收口：收回租约（模块对外暴露了这条路），
 * 再重新 import 拿到同一个模块对象即可 —— 断言看的是行为，不是模块实例身份。
 */
const load = async (): Promise<LanCastModule> => {
    const module = await import('@/services/lanCast');
    module.releaseCastLease();
    return module;
};

beforeEach(() => {
    for (const key of Object.keys(plugins)) delete plugins[key];
    capacitorState.native = true;
    capacitorState.platform = 'android';
    installBridge();
    vi.stubGlobal('localStorage', {
        store: new Map<string, string>(),
        getItem(key: string) { return this.store.get(key) ?? null; },
        setItem(key: string, value: string) { this.store.set(key, value); },
        removeItem(key: string) { this.store.delete(key); },
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('lanCast 投送目标准入', () => {
    it.each([
        ['http://192.168.1.20:49152/AVTransport/control', true],
        ['http://10.0.0.5:8080/desc.xml', true],
        ['http://172.16.4.4:49153/desc.xml', true],
        ['http://speaker.local:49154/desc.xml', true],
        ['http://[fd00::1]:49152/desc.xml', true],
        ['https://192.168.31.9/desc.xml', true],
        // 公网、特殊地址、异常端口、非 http(s)、带凭据，一律不可信。
        ['http://example.com/desc.xml', false],
        ['http://8.8.8.8/desc.xml', false],
        ['http://127.0.0.1:49152/desc.xml', false],
        ['http://192.168.1.20:22/desc.xml', false],
        ['http://192.168.1.20:6379/desc.xml', false],
        ['ftp://192.168.1.20/desc.xml', false],
        ['http://user:pass@192.168.1.20/desc.xml', false],
        ['', false],
    ])('%s → %s', async (url, expected) => {
        const { isTrustedLanTarget } = await load();
        expect(isTrustedLanTarget(url)).toBe(expected);
    });

    it('落盘的上次音响读回来也要过白名单', async () => {
        const { getLastSpeaker, rememberSpeaker } = await load();
        // 被污染的值：不记；就算以前记过，读回来也不认。
        rememberSpeaker({ id: 'x', name: 'x', location: '', controlUrl: 'http://example.com/control', manufacturer: '' });
        expect(getLastSpeaker()).toBeNull();
        localStorage.setItem('lanCastLastSpeaker', JSON.stringify({
            id: 'y', name: 'y', location: '', controlUrl: 'http://8.8.8.8/control', manufacturer: '',
        }));
        expect(getLastSpeaker()).toBeNull();
        rememberSpeaker({ id: 'z', name: 'z', location: '', controlUrl: 'http://192.168.1.20:49152/c', manufacturer: '' });
        expect(getLastSpeaker()?.controlUrl).toBe('http://192.168.1.20:49152/c');
    });

    it('发现结果里不可信的设备被丢掉', async () => {
        plugins.FoliaLanCast = {
            discover: vi.fn(async () => ({
                devices: [
                    { id: 'a', name: '客厅音响', location: 'http://192.168.1.20:49152/desc.xml', controlUrl: 'http://192.168.1.20:49152/c', manufacturer: '' },
                    { id: 'b', name: '伪造', location: 'http://example.com/d.xml', controlUrl: 'http://example.com/c', manufacturer: '' },
                ],
            })),
        };
        const { discoverLanSpeakers } = await load();
        const found = await discoverLanSpeakers(1000);
        expect(found.map(item => item.id)).toEqual(['a']);
    });
});

describe('lanCast 租约与收回路径', () => {
    it('投送时用本次签发的令牌覆盖路径，收回后关闭原生闸门', async () => {
        const release = vi.fn(async () => undefined);
        plugins.FoliaNative = {
            lanCastPrepare: vi.fn(async () => ({
                port: 45678, lanIp: '192.168.1.5', token: 'lc-issued-token', pairCode: 'ABCDEFGH', expiresAt: Date.now() + 3_600_000,
            })),
            lanCastRelease: release,
        };
        const play = vi.fn(async () => ({ ok: true }));
        plugins.FoliaLanCast = { play };
        const lanCast = await load();
        await lanCast.castTrackToSpeaker(
            { id: 'a', name: '客厅音响', location: '', controlUrl: 'http://192.168.1.20:49152/c', manufacturer: '' },
            { url: 'http://127.0.0.1:45678/remote-audio/loopback-token', title: 't', artist: 'a' },
        );
        // 音响拿到的地址：手机 IP + 本次租约的令牌，而不是回环注册表里那个。
        expect(play.mock.calls[0][0].url).toBe('http://192.168.1.5:45678/remote-audio/lc-issued-token');
        expect(lanCast.hasCastLease()).toBe(true);
        lanCast.releaseCastLease();
        expect(release).toHaveBeenCalledTimes(1);
        expect(lanCast.hasCastLease()).toBe(false);
        // 幂等：再收一次不会多打一次桥。
        lanCast.releaseCastLease();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('停止投送会同时收口租约', async () => {
        const release = vi.fn(async () => undefined);
        const stop = vi.fn(async () => ({ ok: true }));
        plugins.FoliaNative = {
            lanCastPrepare: vi.fn(async () => ({ port: 45678, lanIp: '192.168.1.5', token: 'lc-t', expiresAt: Date.now() + 3_600_000 })),
            lanCastRelease: release,
        };
        plugins.FoliaLanCast = { play: vi.fn(async () => ({ ok: true })), stop };
        const lanCast = await load();
        await lanCast.castTrackToSpeaker(
            { id: 'a', name: 'a', location: '', controlUrl: 'http://192.168.1.20:49152/c', manufacturer: '' },
            { url: 'http://127.0.0.1:1/remote-audio/x', title: 't', artist: 'a' },
        );
        await lanCast.stopCastingToSpeaker();
        expect(stop).toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
        expect(lanCast.hasCastLease()).toBe(false);
    });

    it('App 进后台、页面关闭、网络切换都会收回', async () => {
        const release = vi.fn(async () => undefined);
        plugins.FoliaNative = {
            lanCastPrepare: vi.fn(async () => ({ port: 45678, lanIp: '192.168.1.5', token: 'lc-t', expiresAt: Date.now() + 3_600_000 })),
            lanCastRelease: release,
        };
        plugins.FoliaLanCast = { play: vi.fn(async () => ({ ok: true })) };
        const lanCast = await load();
        // 收集守卫注册的监听。
        const handlers = new Map<string, () => void>();
        vi.mocked(document.addEventListener).mockImplementation(((event: string, handler: () => void) => {
            handlers.set(`doc:${event}`, handler);
        }) as any);
        vi.mocked(window.addEventListener).mockImplementation(((event: string, handler: () => void) => {
            handlers.set(`win:${event}`, handler);
        }) as any);
        const uninstall = lanCast.installLanCastLifecycleGuards();

        const castOnce = async () => {
            await lanCast.castTrackToSpeaker(
                { id: 'a', name: 'a', location: '', controlUrl: 'http://192.168.1.20:49152/c', manufacturer: '' },
                { url: 'http://127.0.0.1:1/remote-audio/x', title: 't', artist: 'a' },
            );
        };

        await castOnce();
        (document as any).visibilityState = 'hidden';
        handlers.get('doc:visibilitychange')?.();
        expect(lanCast.hasCastLease()).toBe(false);
        (document as any).visibilityState = 'visible';

        await castOnce();
        handlers.get('win:pagehide')?.();
        expect(lanCast.hasCastLease()).toBe(false);

        await castOnce();
        handlers.get('win:offline')?.();
        expect(lanCast.hasCastLease()).toBe(false);

        expect(release).toHaveBeenCalledTimes(3);
        uninstall();
    });

    it('收回之后迟到的 prepare 会被再关一次并让这次投送失败', async () => {
        let resolvePrepare: ((value: any) => void) | null = null;
        const release = vi.fn(async () => undefined);
        plugins.FoliaNative = {
            lanCastPrepare: vi.fn(() => new Promise<any>(resolve => { resolvePrepare = resolve; })),
            lanCastRelease: release,
        };
        const play = vi.fn(async () => ({ ok: true }));
        plugins.FoliaLanCast = { play };
        const lanCast = await load();
        const pending = lanCast.castTrackToSpeaker(
            { id: 'a', name: 'a', location: '', controlUrl: 'http://192.168.1.20:49152/c', manufacturer: '' },
            { url: 'http://127.0.0.1:1/remote-audio/x', title: 't', artist: 'a' },
        ).then(() => 'ok', (error: Error) => error.message);
        // prepare 还没回来，用户已经退到后台。
        (document as any).visibilityState = 'hidden';
        resolvePrepare!({ port: 45678, lanIp: '192.168.1.5', token: 'lc-t', expiresAt: Date.now() + 3_600_000 });
        await expect(pending).resolves.toContain('后台');
        expect(play).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
        expect(lanCast.hasCastLease()).toBe(false);
    });

    it('租约到点自动收回', async () => {
        const release = vi.fn(async () => undefined);
        plugins.FoliaNative = {
            lanCastPrepare: vi.fn(async () => ({
                port: 45678, lanIp: '192.168.1.5', token: 'lc-t',
                // 只比余量多 2 秒过期：投送成功后 2 秒左右就该兜底收回。
                expiresAt: Date.now() + 5 * 60 * 1000 + 2000,
            })),
            lanCastRelease: release,
        };
        plugins.FoliaLanCast = { play: vi.fn(async () => ({ ok: true })) };
        const lanCast = await load();
        await lanCast.castTrackToSpeaker(
            { id: 'a', name: 'a', location: '', controlUrl: 'http://192.168.1.20:49152/c', manufacturer: '' },
            { url: 'http://127.0.0.1:1/remote-audio/x', title: 't', artist: 'a' },
        );
        expect(lanCast.hasCastLease()).toBe(true);
        await new Promise<void>(resolve => { setTimeout(resolve, 2600); });
        expect(lanCast.hasCastLease()).toBe(false);
        expect(release).toHaveBeenCalledTimes(1);
    });
});
