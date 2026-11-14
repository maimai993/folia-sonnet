import {
    applyAndroidPhoneFit,
    readStoredAndroidPhoneFitOrientation,
    syncAndroidPhoneFitNative,
    writeStoredAndroidPhoneFitOrientation,
    type AndroidPhoneFitOrientation,
} from './androidPhoneLayout';
import { setDisplayBoost, type DisplayBoostResult } from '../platform/foliaNative';

// src/services/hdrProjection.ts
// 「HUD 投影」：手机横过来、亮度顶满、整屏左右镜像 —— 屏幕朝上躺在仪表台上，
// 画面经挡风玻璃反射进眼里才是正的。
//
// 为什么是镜像：挡风玻璃是一面镜子，屏幕上「正的」字反射到眼里是反的。所以先把
// 画面翻一次，反射回来就正了。这也是为什么它只在**投射到玻璃**这个用法下才开 ——
// 平时开着只会得到一个左右颠倒的播放器。
//
// 三件事里只有亮度与色彩模式要原生（那是 Activity 窗口的属性，WebView 改不动）；
// 横屏走现成的方向锁，镜像是纯 CSS —— 所以插件不可用时这两半照样生效。

export const HDR_PROJECTION_STORAGE_KEY = 'folia_hdr_projection';

/** 打开之后留给用户的准备时间：把手机放稳，别在翻屏那一刻正拿着它。 */
export const HDR_PROJECTION_COUNTDOWN_SECONDS = 5;

/**
 * 「点空白退出」那句提示的有效期。
 *
 * 投到挡风玻璃上时屏幕是反的，误触的概率比平时高得多 —— 点一下只弹提示，多久之内再点
 * 一次才算数。过了这个窗口就当那一下是误触，回到「第一次点」的状态。
 */
export const HDR_EXIT_CONFIRM_WINDOW_MS = 3000;

export const readStoredHdrProjection = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return localStorage.getItem(HDR_PROJECTION_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
};

export const writeStoredHdrProjection = (enabled: boolean): void => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(HDR_PROJECTION_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
        // 存不下也要让这一趟生效：投影是临时用法，重开一次拨一下就行。
    }
};

/* ---------------------------------------------------------------------------
 * 亮度那一半落地的结果
 * -------------------------------------------------------------------------
 *
 * 「顶到最亮」有两条路：窗口覆盖（不用权限，总能做）与真的改系统亮度（要 WRITE_SETTINGS，
 * 特殊权限，得用户在系统设置里给过）。只有前一条时，设置里那个滑块不动，带自动亮度的
 * ROM 还可能把它压回去 —— 用户看到的就是「开了 HDR，屏幕一点没亮」。所以结果留一份，
 * 面板上那行说明好据此提示去授权。
 */

let lastDisplayBoostResult: DisplayBoostResult = { systemBrightness: false, canWriteSettings: false };
const boostListeners = new Set<(result: DisplayBoostResult) => void>();

const setLastDisplayBoostResult = (result: DisplayBoostResult): void => {
    lastDisplayBoostResult = result;
    boostListeners.forEach((listener) => listener(result));
};

/** 上一次亮度落地的结果（组件挂载时靠它接上已经发生过的那一趟）。 */
export const readDisplayBoostResult = (): DisplayBoostResult => lastDisplayBoostResult;

export const subscribeDisplayBoostResult = (
    listener: (result: DisplayBoostResult) => void,
): (() => void) => {
    boostListeners.add(listener);
    return () => {
        boostListeners.delete(listener);
    };
};

/**
 * 打开之前的方向。
 *
 * 横屏写的是「强制横屏」那一个设置（见下），关掉时得知道该还回什么 —— 用户自己原本就
 * 锁着横屏的话，一律还成竖屏等于顺手把他的设置改了。开的时候记一份，关的时候照原样还。
 */
const HDR_PREVIOUS_ORIENTATION_KEY = 'folia_hdr_previous_orientation';

const readPreviousOrientation = (): AndroidPhoneFitOrientation => {
    if (typeof window === 'undefined') return 'portrait';
    try {
        return localStorage.getItem(HDR_PREVIOUS_ORIENTATION_KEY) === 'landscape'
            ? 'landscape'
            : 'portrait';
    } catch {
        return 'portrait';
    }
};

const writePreviousOrientation = (orientation: AndroidPhoneFitOrientation | null): void => {
    if (typeof window === 'undefined') return;
    try {
        if (orientation === null) localStorage.removeItem(HDR_PREVIOUS_ORIENTATION_KEY);
        else localStorage.setItem(HDR_PREVIOUS_ORIENTATION_KEY, orientation);
    } catch {
        // 记不下就按竖屏还：横屏是我们自己翻的，还错了也比一直卡在横屏好。
    }
};

/**
 * 真正落地。
 *
 * 横屏那一份**写进「强制横屏」那个设置**而不是另存一份：那是同一个 Activity 方向锁，
 * 存两份就会互相覆盖（关掉 HDR 时到底该听谁的）；写进去还顺带让设置页那一行跟着变，
 * 用户不会看见「设置里说竖屏、屏幕却是横的」这种自相矛盾。
 */
export const applyHdrProjection = async (enabled: boolean): Promise<DisplayBoostResult> => {
    let orientation: AndroidPhoneFitOrientation;
    if (enabled) {
        orientation = 'landscape';
        writePreviousOrientation(readStoredAndroidPhoneFitOrientation());
    } else {
        orientation = readPreviousOrientation();
        writePreviousOrientation(null);
    }
    writeStoredAndroidPhoneFitOrientation(orientation);
    applyAndroidPhoneFit(false, orientation);
    syncAndroidPhoneFitNative(true, orientation);

    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-folia-mirror', enabled ? 'true' : 'false');
    }

    /*
     * 先通知再等亮度。通知是「开关现在是开还是关」，界面拿它决定要不要收 UI、要不要
     * 二次确认 —— 不该被原生那一趟卡住（老版本 App 没有这个方法，那一趟会更慢或者
     * 根本不回来）。亮度只是「亮不亮得起来」，晚一点到没关系。
     */
    notifyEnabled();

    // 老版本原生没有这个方法（或返回空），结果按「什么都没做成」算 —— 横屏与镜像照旧。
    const brightness: DisplayBoostResult = (await setDisplayBoost(enabled))
        ?? { systemBrightness: false, canWriteSettings: false };
    setLastDisplayBoostResult(enabled
        ? brightness
        : { systemBrightness: false, canWriteSettings: brightness.canWriteSettings });
    return brightness;
};

/**
 * 关掉：取消还没走完的倒计时 + 落盘 + 整条还原（方向、镜像、亮度）。
 *
 * 收在这里是因为**关掉有两条路** —— 控制面板那颗开关，和 HDR 下「点两次空白退出」。
 * 两条各写一遍的话，早晚会有一次只做了其中一半（比如关了开关却没人去还原亮度）。
 */
export const disableHdrProjection = (): void => {
    cancelHdrProjectionCountdown();
    writeStoredHdrProjection(false);
    void applyHdrProjection(false);
};

/* ---------------------------------------------------------------------------
 * 「现在是不是 HUD 投影」
 * -------------------------------------------------------------------------
 *
 * App 那一层（点空白要不要二次确认）要知道，但它离这个开关很远：面板那颗开关在
 * 控制面板里，App 拿不到它的 props。所以这里留一份订阅 —— 谁都能问，改了也会通知。
 */

const enabledListeners = new Set<(enabled: boolean) => void>();

export const subscribeHdrProjection = (listener: (enabled: boolean) => void): (() => void) => {
    enabledListeners.add(listener);
    return () => {
        enabledListeners.delete(listener);
    };
};

const notifyEnabled = (): void => {
    const enabled = readStoredHdrProjection();
    enabledListeners.forEach((listener) => listener(enabled));
};

/* ---------------------------------------------------------------------------
 * 倒计时
 * -------------------------------------------------------------------------
 *
 * 只有一个。手动拨开关与「启动时上次还开着」这两条路都要它 —— 各跑一个的话，
 * 启动那一个会在用户已经拨掉之后照样翻一次屏。所以定时器收在这里，谁都能取消。
 */

let countdownTimer: number | null = null;
let countdownRemaining = 0;
const countdownListeners = new Set<(remaining: number) => void>();

const notifyCountdown = (): void => {
    countdownListeners.forEach((listener) => listener(countdownRemaining));
};

/** 现在还剩几秒（0 = 没有在跑）。组件挂载时靠它接上已经在跑的那一个。 */
export const readHdrProjectionCountdown = (): number => countdownRemaining;

export const subscribeHdrProjectionCountdown = (
    listener: (remaining: number) => void,
): (() => void) => {
    countdownListeners.add(listener);
    return () => {
        countdownListeners.delete(listener);
    };
};

export const cancelHdrProjectionCountdown = (): void => {
    if (countdownTimer !== null) {
        window.clearInterval(countdownTimer);
        countdownTimer = null;
    }
    countdownRemaining = 0;
    notifyCountdown();
};

/** 起一次倒计时：到点写盘并生效。已经在跑的会被顶掉（重新数 5 秒）。 */
export const startHdrProjectionCountdown = (): void => {
    cancelHdrProjectionCountdown();
    countdownRemaining = HDR_PROJECTION_COUNTDOWN_SECONDS;
    notifyCountdown();
    countdownTimer = window.setInterval(() => {
        countdownRemaining -= 1;
        if (countdownRemaining > 0) {
            notifyCountdown();
            return;
        }
        cancelHdrProjectionCountdown();
        writeStoredHdrProjection(true);
        void applyHdrProjection(true);
    }, 1000);
};

/**
 * 启动时：**不恢复**。
 *
 * 「投到挡风玻璃」是一次性的用法 —— 手机摆好、投一会儿、拿走。上一次开着不该让下一次
 * 开屏就自动横过来；更要紧的是，这个开关一手管着屏幕方向、整屏镜像和窗口亮度三件事，
 * 任何一件在某台机器上出了岔子（早先的色彩模式就是把整屏压成黑的那一件），用户唯一
 * 能做的就是重启 —— 而一旦自动恢复，重启也回不来，等于把自己锁死在一块黑屏里。
 *
 * 所以每次开 app 一律回到关，要投再拨一下：5 秒倒计时照旧，留时间把手机摆稳。
 */
export const installHdrProjectionPreference = (): void => {
    cancelHdrProjectionCountdown();
    const leftOn = readStoredHdrProjection();
    writeStoredHdrProjection(false);
    if (typeof document !== 'undefined') {
        document.documentElement.setAttribute('data-folia-mirror', 'false');
    }
    notifyEnabled();
    /*
     * 上一趟是开着退出的（进程被杀、或者直接从后台划掉）：落盘的三样都还在 ——
     * 强制横屏那份设置、整屏镜像、以及系统亮度（那一条是全局的，进程死了它还在）。
     * 这里把它们收回去，但**不再进入投影**。
     */
    if (leftOn) void applyHdrProjection(false);
};
