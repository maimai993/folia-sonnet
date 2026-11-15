import { AnimatePresence, motion } from 'framer-motion';
import { Gift, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox } from '../ui';
import { useThemeSettingsStore } from '../../stores/useThemeSettingsStore';
import { openNativeUrl } from '../../platform/foliaNative';
import type { Theme } from '../../types';

// src/components/bilibili/BilibiliVipPromoModal.tsx
//
// 「BLG 夺冠 · 免费领大会员」的限时弹窗。
//
// 只在这个窗口里出现：系统本地时间 11 月 15 日 12:00 —— 11 月 16 日 12:00。
// 关掉过一次就不再烦人（记在 localStorage），窗口过后根本不会挂出来。
//
// 按钮不是在应用里内嵌那个活动页：那个页面本身是「全屏唤端」组件，正事要在
// bilibili App 里领（活动页的 OpenAppVue 就是这么设计的 —— 见下方活动地址）。
// 所以这里直接把 bilibili:// 交给系统 intent；没装那个 App 才退回用浏览器开活动页。

/** 活动页。领奖、看规则都在这儿；唤端失败时也用它兜底。 */
const ACTIVITY_URL = 'https://www.bilibili.com/blackboard/era/0DufCikfqU75HfsE.html?spm_id_from=333.337.0.0';

/*
 * 唤端地址。
 *
 * 别用 `bilibili://root`：那是活动页 OpenAppVue 的**兜底值**，落到 App 里就是首页，
 * 用户看到的是「打开了 B 站但没有活动页」。
 *
 * 活动页真正用的是它组件里的这行（见 OpenAppVue 的 rn 函数）：
 *   `bilibili://browser/?url=${encodeURIComponent(httpUrl)}`
 * 也就是把活动页地址塞进 App 内置浏览器 —— 打开后直接停在这个活动上，
 * 而且是 App 自己的 WebView，才是「在 B 站里领」。
 */
const APP_SCHEME = `bilibili://browser/?url=${encodeURIComponent(ACTIVITY_URL)}`;

/** 关过就不再弹：这是本地偏好，不该跟着账号走。 */
const DISMISSED_KEY = 'folia:blgVipPromoDismissed';

/*
 * 活动窗口（系统本地时间）。
 *
 * 用本地时间而不是 UTC：用户说的「11.15 12点」就是他手机上看到的钟点。
 * 月份从 0 起，所以 10 = 11 月。
 */
const WINDOW_START = new Date(2026, 10, 15, 12, 0, 0, 0);
const WINDOW_END = new Date(2026, 10, 16, 12, 0, 0, 0);

/** 现在是不是在窗口里。导出是为了让「什么时候弹」这件事可以被测试直接问。 */
export const isBilibiliVipPromoWindow = (now: Date = new Date()): boolean => (
    now >= WINDOW_START && now < WINDOW_END
);

const wasDismissed = (): boolean => {
    try {
        return window.localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
        // 隐私模式 / 存储被禁：当作没关过，宁可多弹一次也别让活动彻底看不到。
        return false;
    }
};

const rememberDismissed = (): void => {
    try {
        window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
        // 存不下就算了：这一次关掉仍然生效。
    }
};

export const BilibiliVipPromoModal: React.FC<{ theme?: Theme | null }> = ({ theme }) => {
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const [isOpen, setIsOpen] = useState(false);
    /*
     * 「不再提示」的勾选状态。
     *
     * 每次挂出来都从「没勾」开始：记忆是用户**这次**的选择，不该替他把下一次也决定掉。
     * 关窗和勾选是两件事 —— 只关窗只是这一次不看了，下次进来（或重新打开）还会提醒。
     */
    const [dontRemind, setDontRemind] = useState(false);
    /*
     * 这次挂载里已经被关掉了。
     *
     * 没有它的话，每秒分钟那次 sync 会在关窗之后又把 isOpen 重新算成 true ——
     * 用户点掉一个弹窗，一分钟后它自己又冒出来，这是最招人烦的那种 bug。
     */
    const closedThisMount = useRef(false);

    /*
     * 窗口按「每次挂载 + 每分钟」重算。
     *
     * 定时而不是只在挂载时算一次：App 可能就停在后台跨过 12:00，回来时窗口才刚开，
     * 那一次挂载早就过去了。一分钟一次足够，也不是什么贵的东西。
     */
    useEffect(() => {
        const sync = () => setIsOpen(
            !closedThisMount.current && isBilibiliVipPromoWindow() && !wasDismissed(),
        );
        sync();
        const timer = window.setInterval(sync, 60_000);
        return () => window.clearInterval(timer);
    }, []);

    /*
     * 关掉。只有勾了「不再提示」才写进本地 —— 没勾就只是这一次收起，
     * 下次进 App（或这个组件重新挂出来）还会照常提醒。
     */
    const close = useCallback(() => {
        closedThisMount.current = true;
        if (dontRemind) rememberDismissed();
        setIsOpen(false);
    }, [dontRemind]);

    const openApp = useCallback(() => {
        void openNativeUrl(APP_SCHEME, ACTIVITY_URL);
        // 领完不必再弹：用户已经表示对这个活动有兴趣，关掉这一次即可。
        close();
    }, [close]);

    const accent = theme?.accentColor || '#fb7299';

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    data-folia-keyboard-window="true"
                    data-testid="bilibili-vip-promo"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[210] flex items-center justify-center bg-black/65 p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="bilibili-vip-promo-title"
                    onClick={close}
                >
                    <motion.div
                        initial={{ scale: 0.96, opacity: 0, y: 16 }}
                        animate={{ scale: 1, opacity: 1, y: 0 }}
                        exit={{ scale: 0.96, opacity: 0 }}
                        className={`w-full max-w-sm rounded-[2rem] border p-7 text-center shadow-2xl ${
                            isDaylight ? 'border-zinc-200 bg-white text-zinc-900' : 'border-zinc-800 bg-[#18181b] text-zinc-50'
                        }`}
                        onClick={event => event.stopPropagation()}
                    >
                        <Button
                            onClick={close}
                            aria-label="关闭"
                            className="ml-auto flex h-8 w-8 items-center justify-center rounded-full opacity-50 transition-opacity hover:opacity-100"
                        >
                            <X size={16} aria-hidden="true" />
                        </Button>

                        <span
                            className="mx-auto -mt-2 mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-current/5"
                            style={{ color: accent }}
                        >
                            <Gift size={26} aria-hidden="true" />
                        </span>

                        <h2 id="bilibili-vip-promo-title" className="text-xl font-bold">
                            免费领 bilibili 大会员
                        </h2>
                        <p className="mx-auto mt-3 max-w-xs text-sm leading-6 opacity-65">
                            恭喜 BLG 夺冠！限时赠送大会员，点下面的按钮去哔哩哔哩领取。
                        </p>

                        <Button
                            data-testid="bilibili-vip-promo-open"
                            onClick={openApp}
                            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-white transition-transform active:scale-95"
                            style={{ background: accent }}
                        >
                            <Gift size={17} aria-hidden="true" />
                            免费 bili 大会员
                        </Button>

                        <div className="mt-4 flex items-center justify-between gap-3">
                            {/*
                             * 「不再提示」是给不想再看见的人的出口：勾上再关，这次的窗口里
                             * 就不会再冒出来；不勾就直接关，只是这一次不看。
                             * 用真的 checkbox（不是纯文字按钮），点标签也能切换。
                             */}
                            <label className="flex cursor-pointer items-center gap-2 text-xs opacity-60">
                                <Checkbox
                                    data-testid="bilibili-vip-promo-dont-remind"
                                    checked={dontRemind}
                                    onChange={event => setDontRemind(event.target.checked)}
                                    className="h-3.5 w-3.5 cursor-pointer accent-current"
                                />
                                不再提示
                            </label>
                            <Button
                                onClick={close}
                                className="text-xs opacity-45 transition-opacity hover:opacity-70"
                            >
                                以后再说
                            </Button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
