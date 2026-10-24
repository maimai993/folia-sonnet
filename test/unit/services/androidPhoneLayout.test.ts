import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ANDROID_AUTO_LANDSCAPE_STORAGE_KEY,
    ANDROID_PHONE_FIT_STORAGE_KEY,
    ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY,
    applyAndroidPhoneFit,
    applyDeviceProfile,
    inferDeviceType,
    readStoredAndroidPhoneFitOrientation,
    readStoredAndroidPhoneFit,
    readStoredAutoLandscapeForVisualizer,
    syncAndroidOrientationOverride,
    writeStoredAndroidPhoneFitOrientation,
    writeStoredAndroidPhoneFit,
    writeStoredAutoLandscapeForVisualizer,
} from '@/services/androidPhoneLayout';

// 真机上安卓 WebView 的 UA：`; wv)` 是 Chromium 给套壳 WebView 打的标记，
// 手机浏览器访问真实站点没有它（见 platform/runtime 的 isAndroidAppShell）。
const ANDROID_WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP1A.240405.002; wv) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36';

const storage = new Map<string, string>();

afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
});

describe('android phone layout preference', () => {
    it('persists the switch using the dedicated key', () => {
        const localStorageStub = {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        };
        vi.stubGlobal('window', { localStorage: localStorageStub });
        vi.stubGlobal('localStorage', localStorageStub);

        writeStoredAndroidPhoneFit(true);
        expect(storage.get(ANDROID_PHONE_FIT_STORAGE_KEY)).toBe('true');
        expect(readStoredAndroidPhoneFit()).toBe(true);

        writeStoredAndroidPhoneFit(false);
        expect(readStoredAndroidPhoneFit()).toBe(false);

        writeStoredAndroidPhoneFitOrientation('landscape');
        expect(storage.get(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY)).toBe('landscape');
        expect(readStoredAndroidPhoneFitOrientation()).toBe('landscape');
    });

    it('gates CSS through the document root attribute', () => {
        const setAttribute = vi.fn();
        vi.stubGlobal('document', { documentElement: { setAttribute } });

        applyAndroidPhoneFit(true, 'landscape');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-fit', 'true');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-orientation', 'landscape');

        applyAndroidPhoneFit(false, 'portrait');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-fit', 'false');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-orientation', 'portrait');
    });
});

describe('auto-landscape for the visualizer', () => {
    // 开关落盘、覆盖不落盘 —— 覆盖每次运行都要由 Web 层重压一次，而最早那次可能早于
    // Capacitor 桥就绪（插件还不存在，调用会被静默丢掉，屏幕就永远不转）。
    it('keeps the switch under its own key, off until asked', () => {
        const localStorageStub = {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        };
        vi.stubGlobal('window', { localStorage: localStorageStub });
        vi.stubGlobal('localStorage', localStorageStub);

        expect(readStoredAutoLandscapeForVisualizer()).toBe(false);
        writeStoredAutoLandscapeForVisualizer(true);
        expect(storage.get(ANDROID_AUTO_LANDSCAPE_STORAGE_KEY)).toBe('true');
        expect(readStoredAutoLandscapeForVisualizer()).toBe(true);
        writeStoredAutoLandscapeForVisualizer(false);
        expect(readStoredAutoLandscapeForVisualizer()).toBe(false);
    });

    it('hands the override to the native plugin, auto meaning "take it away"', () => {
        const setPhoneFitOrientationOverride = vi.fn(() => Promise.resolve());
        vi.stubGlobal('window', {
            Capacitor: { Plugins: { FoliaNative: { setPhoneFitOrientationOverride } } },
        });

        syncAndroidOrientationOverride('landscape');
        expect(setPhoneFitOrientationOverride).toHaveBeenCalledWith({ mode: 'landscape' });
        syncAndroidOrientationOverride('portrait');
        expect(setPhoneFitOrientationOverride).toHaveBeenLastCalledWith({ mode: 'portrait' });
        // 撤掉覆盖走 auto：方向回到 setPhoneFitLayout 那一份落盘的选择。
        syncAndroidOrientationOverride(null);
        expect(setPhoneFitOrientationOverride).toHaveBeenLastCalledWith({ mode: 'auto' });
    });

    it('re-sends the override on deviceready while the plugin is still missing', () => {
        const addEventListener = vi.fn();
        vi.stubGlobal('navigator', { userAgent: ANDROID_WEBVIEW_UA });
        vi.stubGlobal('window', { location: { href: 'https://localhost/' } });
        vi.stubGlobal('document', { addEventListener });

        syncAndroidOrientationOverride('landscape');
        expect(addEventListener).toHaveBeenCalledWith('deviceready', expect.any(Function), { once: true });

        // 桥就绪后插件才出现：补发那一下要照着同一个覆盖值送过去。
        const setPhoneFitOrientationOverride = vi.fn(() => Promise.resolve());
        (window as unknown as { Capacitor: unknown }).Capacitor = {
            Plugins: { FoliaNative: { setPhoneFitOrientationOverride } },
        };
        const send = addEventListener.mock.calls[0][1] as () => void;
        send();
        expect(setPhoneFitOrientationOverride).toHaveBeenCalledWith({ mode: 'landscape' });
    });

    it('attaches nothing where there is no Android shell to talk to', () => {
        const addEventListener = vi.fn();
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150' });
        vi.stubGlobal('window', { location: { href: 'https://folia.example/' } });
        vi.stubGlobal('document', { addEventListener });

        syncAndroidOrientationOverride('landscape');
        expect(addEventListener).not.toHaveBeenCalled();
    });
});

describe('device profile', () => {
    // 手机横过来时短边（也就是高度）常见 360~480 CSS px，平板再小也多在 600 以上。
    const stubDevice = (width: number, height: number, userAgent = 'Mozilla/5.0 (Linux; Android 14)') => {
        vi.stubGlobal('window', { innerWidth: width, innerHeight: height });
        vi.stubGlobal('navigator', { userAgent });
    };
    const attributesOf = (calls: unknown[][]) => Object.fromEntries(calls as [string, string][]);

    afterEach(() => { vi.unstubAllGlobals(); });

    it('infers a phone from the short edge when the type was never chosen', () => {
        stubDevice(844, 390);
        expect(inferDeviceType()).toBe('phone');
        stubDevice(1600, 900);
        expect(inferDeviceType()).toBe('tablet');
        // 桌面浏览器不问也不缩：窗口多宽自己说了算。
        stubDevice(844, 390, 'Mozilla/5.0 (Windows NT 10.0)');
        expect(inferDeviceType()).toBe('tablet');
    });

    it('lets the explicit choice override the inference', () => {
        stubDevice(844, 390);
        const setAttribute = vi.fn();
        // applyDeviceProfile 除了属性还会往根节点写 `--folia-ui-scale-*` CSS 变量，
        // stub 里少了 style 就会在 setProperty 上炸掉。
        const setProperty = vi.fn();
        vi.stubGlobal('document', { documentElement: { setAttribute, style: { setProperty } } });

        applyDeviceProfile('tablet');
        expect(attributesOf(setAttribute.mock.calls)).toMatchObject({ 'data-folia-ui-scale': 'normal' });

        setAttribute.mockClear();
        applyDeviceProfile('phone');
        // 竖屏时不缩，只有横屏才需要让路 —— 这里是 node 环境，没有 matchMedia，按非横屏处理。
        expect(attributesOf(setAttribute.mock.calls)).toMatchObject({ 'data-folia-device': 'phone' });

        setAttribute.mockClear();
        // 没选过 → 自动判定为手机（短边 390）。
        applyDeviceProfile(null);
        expect(attributesOf(setAttribute.mock.calls)).toMatchObject({ 'data-folia-device': 'auto' });
    });
});
