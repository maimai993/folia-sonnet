// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RhineHome from '@/library/suites/rhine/RhineHome';
import type { LibraryHomeSurfaceProps } from '@/library/core/suite/suite.contract';

// test/unit/library/rhineHome.test.ts
//
// 「莱茵生命」首页换成 RhinE 骨架（res/rhine-theme/）之后，宿主这边只剩三件事要锁住：
//   - iframe 指向骨架的 index.html，配置（语言 / 明暗 / 资源包 / 文案）在 URL 参数里带齐；
//   - 语言、明暗、安全区变了会重新推一份同样的配置，不重载 iframe；
//   - 只认自己那个 iframe 发来的消息，别的窗口发什么都当没发生。

const ports = vi.hoisted(() => ({
    t: (key: string) => key,
    openLoginWindow: vi.fn(),
    insets: { top: 24, bottom: 0, left: 0, right: 0 } as Record<string, number>,
    /** 安全区订阅者：测试里调它模拟转屏 / 状态栏收放。 */
    insetListeners: new Set<() => void>(),
    language: 'en',
    daylight: false,
}));

// 组件把这两个 store 当 hook 用（`useX(select)`）：包成「可调用 + 带 getState」的形状。
const { asHookStore } = vi.hoisted(() => ({
    asHookStore: <T extends object>(state: T) => Object.assign(
        (select: (value: T) => unknown) => select(state),
        { getState: () => state },
    ),
}));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: ports.t, i18n: { language: ports.language } }),
    initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@/stores/useThemeSettingsStore', () => ({
    useThemeSettingsStore: (select: (state: { isDaylight: boolean }) => unknown) => select({ isDaylight: ports.daylight }),
}));
vi.mock('@/stores/useSettingsModalStore', () => ({
    useSettingsModalStore: asHookStore({ openSettings: vi.fn() }),
}));
vi.mock('@/services/phoneInsets', () => ({
    getPhoneInsets: () => ports.insets,
    subscribePhoneInsets: (listener: () => void) => {
        ports.insetListeners.add(listener);
        return () => { ports.insetListeners.delete(listener); };
    },
}));
vi.mock('@/components/login/loginWindowStore', () => ({ openLoginWindow: ports.openLoginWindow }));
vi.mock('@/components/ui/Button', () => ({
    Button: ({ children, onClick }: { children: unknown; onClick?: (event: unknown) => void }) => createElement(
        'button',
        { type: 'button', onClick: () => onClick?.({ currentTarget: null }) },
        children as never,
    ),
}));
vi.mock('lucide-react', async importOriginal => ({ ...(await importOriginal<object>()), LogIn: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null;
let container: HTMLDivElement;
let props: LibraryHomeSurfaceProps;

const render = async (next: LibraryHomeSurfaceProps = props) => {
    props = next;
    await act(async () => { root!.render(createElement(RhineHome, props)); });
};
const iframe = () => container.querySelector('iframe')!;
const frameWindow = () => iframe().contentWindow!;
const srcParams = () => new URL(iframe().getAttribute('src')!, 'https://folia.test/').searchParams;
/** 从宿主 iframe 发一条消息过来。 */
const message = async (data: unknown, source: MessageEventSource | null = frameWindow()) => {
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { data, source })); });
};
/** 取出发给 iframe 的每一条 rhine-config。 */
const configs = (post: { mock: { calls: unknown[][] } }) => post.mock.calls
    .map(([data]) => data as { type?: string; config?: Record<string, unknown> })
    .filter(data => data.type === 'rhine-config')
    .map(data => data.config!);

beforeEach(() => {
    vi.clearAllMocks();
    ports.language = 'en';
    ports.daylight = false;
    ports.t = key => key;
    ports.insets = { top: 24, bottom: 0, left: 0, right: 0 };
    ports.insetListeners.clear();
    props = {
        playlists: [],
        isInteractive: true,
        localSongs: [],
        localLibraryCatalog: {},
        onPlaySong: vi.fn(),
        onAddAllToQueue: vi.fn(),
        onAddSongToQueue: vi.fn(),
    } as unknown as LibraryHomeSurfaceProps;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    if (root) act(() => root!.unmount());
    container.remove();
});

describe('Rhine home frame', () => {
    it('points the iframe at the RhinE skeleton shipped in res/rhine-theme', async () => {
        await render();
        expect(iframe().getAttribute('src')).toContain('res/rhine-theme/index.html');
        // 测试里 BASE_URL 是「/」；桌面包与安卓包是「./」，两种都必须带斜杠再拼路径。
        expect(iframe().getAttribute('src')).toMatch(/^(\.\/|\/)res\/rhine-theme\/index\.html\?/);
    });

    it('carries language, theme, asset state and the host note in the URL', async () => {
        ports.daylight = true;
        ports.language = 'zh-CN';
        await render();
        const params = srcParams();
        expect(params.get('lang')).toBe('zh-CN');
        expect(params.get('theme')).toBe('light');
        // 资源包归 #440：这一轮恒为没有，主题据此走纯色降级。
        expect(params.get('assets')).toBe('0');
        expect(params.get('note')).toBe('libraryRhine.assetsMissing');
    });

    it('pushes the same config to the frame on load and on inset changes', async () => {
        await render();
        await act(async () => { iframe().dispatchEvent(new Event('load')); });
        const post = vi.spyOn(frameWindow(), 'postMessage');
        ports.insets = { top: 48, bottom: 0, left: 0, right: 0 };
        await act(async () => { ports.insetListeners.forEach(listener => listener()); });
        const [config] = configs(post);
        expect(config).toMatchObject({
            language: 'en',
            theme: 'dark',
            assets: 'bundled',
            hasAssetsPackage: false,
            note: 'libraryRhine.assetsMissing',
            insets: { top: 48, bottom: 0, left: 0, right: 0 },
        });
    });

    it('repushes when the language or the daylight setting changes', async () => {
        // 配置是 iframe 的配置：整块重新挂一次（换语言 / 切明暗在宿主那边就是一次重渲染）。
        await render();
        ports.language = 'zh-TW';
        ports.daylight = true;
        await render();
        const post = vi.spyOn(frameWindow(), 'postMessage');
        await message({ type: 'rhine-theme-ready', degraded: true });
        expect(configs(post).at(-1)).toMatchObject({ language: 'zh-TW', theme: 'light' });
        expect(srcParams().get('theme')).toBe('light');
    });

    it('drops the solid cover once the skeleton reports it is ready', async () => {
        await render();
        expect(container.querySelector('[data-rhine-home="1"] > div.pointer-events-none')).not.toBeNull();
        await message({ type: 'rhine-theme-ready', degraded: true, entry: 'boot' });
        expect(container.querySelector('[data-rhine-home="1"] > div.pointer-events-none')).toBeNull();
    });

    it('opens the Folia login window from the host button', async () => {
        await render();
        const button = container.querySelector('button')!;
        await act(async () => { button.click(); });
        expect(ports.openLoginWindow).toHaveBeenCalled();
    });

    it('unsubscribes the inset listener on unmount', async () => {
        await render();
        expect(ports.insetListeners.size).toBe(1);
        act(() => root!.unmount());
        root = null;
        expect(ports.insetListeners.size).toBe(0);
    });
});

describe('Rhine home message boundary', () => {
    it('ignores readiness from any window that is not its own frame', async () => {
        await render();
        const other = document.createElement('iframe');
        document.body.appendChild(other);
        for (const source of [null, window, other.contentWindow]) {
            await message({ type: 'rhine-theme-ready' }, source);
        }
        // 只有自己那一帧能撤掉同色底。
        expect(container.querySelector('[data-rhine-home="1"] > div.pointer-events-none')).not.toBeNull();
        other.remove();
    });

    it('ignores messages that are not object-shaped', async () => {
        await render();
        for (const data of [null, undefined, 'rhine-theme-ready', 42]) {
            await message(data);
        }
        expect(container.querySelector('[data-rhine-home="1"] > div.pointer-events-none')).not.toBeNull();
    });
});
