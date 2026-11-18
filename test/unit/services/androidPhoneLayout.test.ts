import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY,
    applyDeviceProfile,
    applyPhoneOrientation,
    inferDeviceType,
    readStoredAndroidPhoneFitOrientation,
    writeStoredAndroidPhoneFitOrientation,
} from '@/services/androidPhoneLayout';

const storage = new Map<string, string>();

afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
});

describe('android phone orientation', () => {
    // 「手机适配」那套覆盖样式是废弃代码，已经整体删除（见 androidPhoneFit.css 顶部）。
    // 这里只验还活着的那一半：方向。
    it('persists the orientation using the dedicated key', () => {
        const localStorageStub = {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
        };
        vi.stubGlobal('window', { localStorage: localStorageStub });
        vi.stubGlobal('localStorage', localStorageStub);

        writeStoredAndroidPhoneFitOrientation('landscape');
        expect(storage.get(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY)).toBe('landscape');
        expect(readStoredAndroidPhoneFitOrientation()).toBe('landscape');
    });

    it('writes only the orientation attribute at the document root', () => {
        const setAttribute = vi.fn();
        vi.stubGlobal('document', { documentElement: { setAttribute } });

        applyPhoneOrientation('landscape');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-orientation', 'landscape');
        // 废弃的 data-folia-phone-fit 不再写入。
        expect(setAttribute).not.toHaveBeenCalledWith('data-folia-phone-fit', expect.anything());

        setAttribute.mockClear();
        applyPhoneOrientation('portrait');
        expect(setAttribute).toHaveBeenCalledWith('data-folia-phone-orientation', 'portrait');
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
