import { setSafeAreaBypass } from './phoneInsets';
import { setSystemBarsAlwaysHidden } from '../platform/foliaNative';

/*
 * 「手机适配」那套覆盖样式（styles/androidPhoneFit.css 里 data-folia-phone-fit 那一半）
 * 是废弃代码，已经整体删掉：它恒为 false，从来没有真正生效过，留着只会让「设置了却没效果」
 * 这类问题反复出现。这里只剩**方向**（竖屏 / 横屏），「强制横屏」与 HDR 投影的镜像读它。
 */
export const ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY = 'folia_android_phone_fit_orientation';

/*
 * 废弃开关留下的那把键。
 *
 * 开关本身已经删了，但这把键是**发布过的**存储键（D507：已发布的键不改名、不删），所以它
 * 还留在 dev/dedicatus/storageKeys.mjs 的登记表里。启动时顺手把它清掉：老用户机器上那份
 * `true/false` 再没有任何代码会读，留着只是让「手机适配」看起来还在。
 */
export const LEGACY_ANDROID_PHONE_FIT_STORAGE_KEY = 'folia_android_phone_fit';

export type AndroidPhoneFitOrientation = 'portrait' | 'landscape';

export const readStoredAndroidPhoneFitOrientation = (): AndroidPhoneFitOrientation => {
    if (typeof window === 'undefined') return 'portrait';
    try {
        return localStorage.getItem(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY) === 'landscape'
            ? 'landscape'
            : 'portrait';
    } catch {
        return 'portrait';
    }
};

export const writeStoredAndroidPhoneFitOrientation = (orientation: AndroidPhoneFitOrientation): void => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(ANDROID_PHONE_FIT_ORIENTATION_STORAGE_KEY, orientation);
    } catch {
        // A storage failure must not make the switch unusable for the current session.
    }
};

/**
 * 把方向写到文档根上。横屏那套缩放、「强制横屏」与 HDR 镜像都读它。
 *
 * 这里原来还有一个「手机适配」总开关，写 `data-folia-phone-fit`；那套覆盖样式是废弃代码，
 * 见 styles/androidPhoneFit.css 顶部说明，已整体删除。
 */
export const applyPhoneOrientation = (
    orientation: AndroidPhoneFitOrientation = readStoredAndroidPhoneFitOrientation(),
): void => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-folia-phone-orientation', orientation);
};

/** 启动时在首帧之前把方向落上去（「强制横屏」从上次的选择恢复）。 */
export const installPhoneOrientationPreference = (): void => {
    // 废弃开关留下的那份值顺手清掉（键名仍登记在 storageKeys.mjs，见上面的注释）。
    if (typeof window !== 'undefined') {
        try {
            localStorage.removeItem(LEGACY_ANDROID_PHONE_FIT_STORAGE_KEY);
        } catch {
            // 存储不可用就算了：那里本来也没有可清的东西。
        }
    }
    applyPhoneOrientation(readStoredAndroidPhoneFitOrientation());
};

/**
 * Synchronizes the JS setting with the Android orientation lock. Web and plugin-less runtimes
 * simply keep using the CSS attribute above.
 */
/* ---------------------------------------------------------------------------
 * 设备类型（手机 / 平板）
 * -------------------------------------------------------------------------
 *
 * 平板的屏幕够宽，桌面那套布局直接铺上去就行；手机横过来的时候宽度跟桌面差了一个量级，
 * 同一屏塞不下同样的东西，控件会互相压住。所以问一次是手机还是平板，是手机的话横屏时把
 * 整屏缩一点 —— 东西变小，同一块屏就显示得下了。
 */

export const DEVICE_TYPE_STORAGE_KEY = 'folia_device_type';

export type DeviceType = 'phone' | 'tablet';

export const readStoredDeviceType = (): DeviceType | null => {
    if (typeof window === 'undefined') return null;
    try {
        const stored = localStorage.getItem(DEVICE_TYPE_STORAGE_KEY);
        return stored === 'phone' || stored === 'tablet' ? stored : null;
    } catch {
        return null;
    }
};

export const writeStoredDeviceType = (deviceType: DeviceType | null): void => {
    if (typeof window === 'undefined') return;
    try {
        if (deviceType) {
            localStorage.setItem(DEVICE_TYPE_STORAGE_KEY, deviceType);
        } else {
            localStorage.removeItem(DEVICE_TYPE_STORAGE_KEY);
        }
    } catch {
        // A storage failure must not make the choice unusable for the current session.
    }
};

/* ---------------------------------------------------------------------------
 * 界面缩放（用户可调）
 * -------------------------------------------------------------------------
 *
 * 手机该缩多少，机器之间差别太大（6 寸到 7 寸、系统字号调到最大的都有），写死一个数
 * 必然两头不讨好 —— 早先写死 86%，用户原话「缩出来的只有一点点，没什么区别」。
 * 所以把这一档交给滑条：默认值仍按设备类型给，调过之后一律以调的为准。
 */

export const UI_SCALE_STORAGE_KEY = 'folia_ui_scale';

/** 滑条范围与步长（百分比）。 */
export const UI_SCALE_MIN = 60;
export const UI_SCALE_MAX = 110;
export const UI_SCALE_STEP = 2;

/** 没调过时的默认值：手机缩一档，平板不缩。 */
export const UI_SCALE_DEFAULT_PHONE = 86;
export const UI_SCALE_DEFAULT_TABLET = 100;

/** 横屏（compact）在竖屏那档上再收多少：手机横过来高度只剩 360~400，同一档还是互相压。 */
const UI_SCALE_COMPACT_OFFSET = 10;
/** 横屏档的下限：滑条拉到最低也不至于小到读不出来。 */
const UI_SCALE_COMPACT_MIN = 55;

export const readStoredUiScale = (): number | null => {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(UI_SCALE_STORAGE_KEY);
        if (raw === null || raw === '') return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? clampUiScale(parsed) : null;
    } catch {
        return null;
    }
};

export const writeStoredUiScale = (scale: number | null): void => {
    if (typeof window === 'undefined') return;
    try {
        if (scale === null) {
            localStorage.removeItem(UI_SCALE_STORAGE_KEY);
        } else {
            localStorage.setItem(UI_SCALE_STORAGE_KEY, String(scale));
        }
    } catch {
        // A storage failure must not make the slider unusable for the current session.
    }
};

/** 夹到滑条范围内并按步长对齐。存进去与读出来的都过这一道，脏值不会带进样式。 */
export const clampUiScale = (scale: number): number => {
    const snapped = Math.round(scale / UI_SCALE_STEP) * UI_SCALE_STEP;
    return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped));
};

/** 没调过时按设备类型取默认：手机缩一档，平板不缩。 */
export const defaultUiScaleFor = (deviceType: DeviceType | null): number => (
    resolveDeviceType(deviceType) === 'phone' ? UI_SCALE_DEFAULT_PHONE : UI_SCALE_DEFAULT_TABLET
);

/** 生效值：调过以调的为准（并夹回范围），没调过按设备类型取默认。 */
export const resolveUiScale = (stored: number | null, deviceType: DeviceType | null): number => (
    stored === null ? defaultUiScaleFor(deviceType) : clampUiScale(stored)
);

/** 横屏那一档：在竖屏基础上再收一档，但不低于下限。 */
export const compactUiScaleFor = (normal: number): number => (
    Math.max(UI_SCALE_COMPACT_MIN, normal - UI_SCALE_COMPACT_OFFSET)
);

const isLandscapeNow = (): boolean => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(orientation: landscape)').matches
);

/**
 * 手机短边的上限（CSS px）。手机横过来时短边就是高度，常见 360~480；平板再小也多在 600 以上。
 * 这里只用来在「没选过」的时候兜个底，选过的一律以选择为准。
 */
const PHONE_SHORT_EDGE_MAX_PX = 520;

/**
 * 没选过设备类型时的自动判断。
 *
 * 引导没答、或者答完又清空的都走这条路 —— 否则这类用户横屏就完全不会出现压缩,而他们恰恰是
 * 最需要它的人。Web / Electron 不在安卓 WebView 里，窗口多宽自己说了算，一律不缩。
 */
export const inferDeviceType = (): DeviceType => {
    if (typeof window === 'undefined') return 'tablet';
    if (typeof navigator === 'undefined' || !/Android/.test(navigator.userAgent)) return 'tablet';
    const shortEdge = Math.min(window.innerWidth, window.innerHeight);
    return shortEdge > 0 && shortEdge <= PHONE_SHORT_EDGE_MAX_PX ? 'phone' : 'tablet';
};

/** 选择优先，没选就自动判断。 */
export const resolveDeviceType = (deviceType: DeviceType | null): DeviceType => (
    deviceType ?? inferDeviceType()
);

/**
 * 把设备类型与「要不要缩」写到 `<html>`：样式全在 androidPhoneFit.css 里读这几个属性，
 * 组件不需要知道自己是跑在手机还是平板上。
 *
 * 两个属性是分开的，别合并：
 * · `data-folia-device` 记的是**用户的选择** —— 没选过就是 `auto`；
 * · `data-folia-device-resolved` 记的是**实际生效的类型** —— `auto` 会先推断再落到这里。
 *
 * 缩一档的样式挂在 resolved 上：这样没答过引导、但机器本来就是手机的人
 * 竖屏也能缩 —— 他们恰恰是最需要它的一批。挂在 device 上的话，这批人竖屏不缩、
 * 横屏却缩，同一个界面转一下屏尺度就跳一档。
 *
 * 缩多少不再写死在样式里 —— 由滑条给（见上面的「界面缩放」），这里只负责把数字写进
 * `--folia-ui-scale-*` 两个变量：**是否**缩放仍由样式表按属性决定，数值由 JS 给。
 * 直接写 inline font-size 也行，但那样样式表就再也管不了了，转屏那一下会漏。
 */
export const applyDeviceProfile = (
    deviceType: DeviceType | null,
    uiScale: number | null = readStoredUiScale(),
): void => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    // 没选过也照样生效：那批人恰恰是最需要它的（引导没答、或者答完又清了）。
    const resolved = resolveDeviceType(deviceType);
    root.setAttribute('data-folia-device', deviceType ?? 'auto');
    root.setAttribute('data-folia-device-resolved', resolved);
    // 平板横屏本来就够宽，只有手机才需要让路。
    const landscape = isLandscapeNow();
    root.setAttribute('data-folia-ui-scale', resolved === 'phone' && landscape ? 'compact' : 'normal');
    const scale = resolveUiScale(uiScale, deviceType);
    root.style.setProperty('--folia-ui-scale-normal', `${scale}%`);
    root.style.setProperty('--folia-ui-scale-compact', `${compactUiScaleFor(scale)}%`);
    /*
     * 平板与手机横屏都不再做安全区避让，状态栏也一并常驻收起。
     *
     * 只有手机**竖屏**才需要让：顶上状态栏、底下手势条都实实在在压在内容上。
     *   平板：屏一直够宽，让出来的那一条纯属浪费；
     *   手机横屏：高度本来就只有 360~400，再让掉状态栏 + 手势条，内容区就没什么了。
     *
     * 两条结论都跟着设备类型与朝向走，所以挂在这里 —— 这里已经在
     * orientationchange / resize 上装了监听，不用再各自装一套。
     */
    const roomy = resolved === 'tablet' || (resolved === 'phone' && landscape);
    setSafeAreaBypass(roomy);
    void setSystemBarsAlwaysHidden(roomy);
};

let deviceProfileListenerInstalled = false;

export const installDeviceProfilePreference = (): void => {
    applyDeviceProfile(readStoredDeviceType(), readStoredUiScale());
    if (deviceProfileListenerInstalled || typeof window === 'undefined') return;
    deviceProfileListenerInstalled = true;
    // 转屏要立刻重算：属性不跟着变的话，横过来那一刻布局还是按竖屏那套铺的。
    const update = () => applyDeviceProfile(readStoredDeviceType(), readStoredUiScale());
    window.addEventListener('orientationchange', update);
    window.addEventListener('resize', update);
    if (typeof window.matchMedia === 'function') {
        window.matchMedia('(orientation: landscape)').addEventListener?.('change', update);
    }
};

export const syncAndroidPhoneFitNative = (
    enabled: boolean,
    orientation: AndroidPhoneFitOrientation,
): void => {
    if (typeof window === 'undefined') return;
    const plugin = (window as unknown as {
        Capacitor?: {
            getPlatform?: () => string;
            Plugins?: {
                FoliaNative?: {
                    setPhoneFitLayout?: (options: {
                        enabled: boolean;
                        orientation: AndroidPhoneFitOrientation;
                    }) => Promise<unknown>;
                };
            };
        };
    }).Capacitor?.Plugins?.FoliaNative;
    if (typeof plugin?.setPhoneFitLayout !== 'function') return;
    void plugin.setPhoneFitLayout({ enabled, orientation }).catch(() => undefined);
};
