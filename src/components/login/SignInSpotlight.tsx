import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LibraryAccountController } from '../../library/core/account/account.contract';
import { useLibraryAccountProviders } from '../../library/core/account/useLibraryAccount';
import { KIT_EASE, KIT_MOTION, kitMotionTokens, useKitReducedMotion } from '../modal/settings/kit/motion';
import { settingsTokens, useSettingsKitTheme } from '../modal/settings/kit/kitTheme';
import { openLoginWindow } from './loginWindowStore';
import { PlatformMark } from './PlatformMark';
import { orderRows, rowStatus } from './platformRows';
import { Button } from '../ui/Button';
import './login.css';

// src/components/login/SignInSpotlight.tsx
// 首启最后一步：把首页那个登录按钮送到脸上去。
//
// 为什么非得有它：登录按钮在主页「没有人登录」那一屏上，而那一屏在许多人的首页序列里靠后
// —— 于是「装好、点开、看见空空的资料库、不知道要先登录」这条路上一直有人走不到那一步。
// 提示也写在那一屏上了，但看不见那一屏的人同样看不见提示。所以等首启该确认的都确认完，
// 这一层直接盖上来：屏幕上只有那一个按钮。
//
// 为什么不让关：能被随手关掉的东西等于没有。它没有关闭按钮、点背后不关、Esc 与安卓返回键
// 都不关（返回键那一下是派发在 window 上的 Escape —— 见 useNativeBackButton —— 所以这里
// 在 window 上接住并 preventDefault，这一层才算真的留得住）。唯一的出路是点它：点了就
// 打开登录窗口，这一层收掉，并且从此不再出现（标记在 useStartupExperienceGate）。
//
// 位置和大小是量出来的，但不写回 React state：量 → state → 重渲染 → 再量是个没有尽头的圈
// （平板上点进汽水登录时整屏黑在那儿，就是那个圈）。这里量一次、把数直接交给 Web Animations，
// 之后不再有人问。

/** 首页上那个登录按钮：飞行的起点在它身上。 */
const HOME_BUTTON = '[data-ponder="sign-in"]';
/** 起飞到落位要多久。 */
const FLY_MS = Math.round(KIT_MOTION.show * 1000);
/** 落位之后一直轻轻起伏：让人看见它在这里，是要点的那一个。 */
const BREATHE_MS = 1800;

type SignInSpotlightProps = {
    isOpen: boolean;
    account: LibraryAccountController;
    /** 点了那个按钮：这一层收掉，从此不再出现。 */
    onPressed: () => void;
};

const SignInSpotlight: React.FC<SignInSpotlightProps> = ({ isOpen, account, onPressed }) => {
    const { t } = useTranslation();
    const { isDaylight, theme } = useSettingsKitTheme();
    const reduced = useKitReducedMotion();
    const { providers, activeProviderId } = useLibraryAccountProviders(account);
    // 按钮前面那几个记号：与首页那个按钮同一个来路（排好序、去掉不能登录的、取前三家）。
    const rows = orderRows(providers, activeProviderId);
    const marks = rows.filter(row => rowStatus(row) !== 'off').slice(0, 3);
    const buttonRef = useRef<HTMLButtonElement>(null);

    /*
     * 从首页那个按钮飞到屏幕正中。
     *
     * 量两次：那一头的中心在哪、这一头（落位之后的按钮）的中心在哪，差就是这一趟的位移；
     * 两个的宽高一比就是起手的缩放。首页那一屏没画出来时（比如首启落到了别的界面）不飞，
     * 直接在正中长出来 —— 目的地是中央，起点只是让它认出「就是这个按钮」。
     */
    useLayoutEffect(() => {
        const button = buttonRef.current;
        if (!isOpen || !button || reduced || typeof button.animate !== 'function') return undefined;
        const away = document.querySelector<HTMLElement>(HOME_BUTTON)?.getBoundingClientRect();
        const here = button.getBoundingClientRect();
        if (!away || away.width === 0 || here.width === 0) return undefined;
        const dx = away.left + away.width / 2 - (here.left + here.width / 2);
        const dy = away.top + away.height / 2 - (here.top + here.height / 2);
        const scale = Math.max(0.1, Math.min(away.width / here.width, away.height / here.height));
        const easing = `cubic-bezier(${KIT_EASE.inOut.join(', ')})`;
        const flight = button.animate(
            [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 }, { transform: 'none', opacity: 1 }],
            // backwards：动画还没开始就把起手那一帧摆上，不然第一帧会先在中央闪一下。
            { duration: FLY_MS, easing, fill: 'backwards' },
        );
        // 落位之后再起伏：两段不叠在一起，也不与按钮自己的 ::after 光晕抢 transform。
        const breathe = button.animate(
            [{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }],
            { duration: BREATHE_MS, iterations: Infinity, easing: 'ease-in-out', delay: FLY_MS },
        );
        return () => { flight.cancel(); breathe.cancel(); };
    }, [isOpen, reduced]);

    // 打开就把焦点给那个按钮：键盘上按回车与点它是同一件事。
    useEffect(() => {
        if (isOpen) buttonRef.current?.focus();
    }, [isOpen]);

    /*
     * 不点不许关：Esc 和安卓返回键（它变成 Escape 派发在 window 上）都在这里被吃掉。
     * 这一层是首启的最后一道，后面没有别的层等着接这一下，所以吃掉就是留住。
     */
    useEffect(() => {
        if (!isOpen) return undefined;
        const swallow = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
        };
        window.addEventListener('keydown', swallow, true);
        return () => window.removeEventListener('keydown', swallow, true);
    }, [isOpen]);

    if (!isOpen) return null;
    /** 点它：打开登录窗口，然后这一层让位（窗口自己会有一趟从这儿起飞的动画）。 */
    const press = () => {
        openLoginWindow(null, buttonRef.current);
        onPressed();
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex flex-col items-center justify-center px-6 text-center text-[color:var(--st-t1)]"
            style={{ ...settingsTokens(isDaylight, theme), ...kitMotionTokens(reduced), background: 'rgba(0, 0, 0, 0.62)' }}
            data-login-still={reduced || undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sign-in-spotlight-title"
        >
            <h2 id="sign-in-spotlight-title" className="login-rise max-w-[520px] text-[19px] font-semibold leading-7 [text-wrap:balance]">
                {t('login.spotlightTitle')}
            </h2>
            <p
                className="login-rise mt-2 max-w-[520px] text-[13px] leading-5 text-white/70"
                style={{ animationDelay: '40ms' }}
            >
                {t('login.spotlightNote')}
            </p>
            <Button
                ref={buttonRef}
                variant="bare"
                onClick={press}
                className="login-cta mt-8 inline-flex h-14 max-w-full items-center gap-3 rounded-2xl bg-[var(--st-accent)] pl-3 pr-6 text-[16px] font-semibold text-[color:var(--st-on-accent)] transition-[opacity,transform] hover:opacity-90 active:scale-[0.98]"
                style={{ '--login-halo': 'var(--st-accent)' } as React.CSSProperties}
            >
                <span className="flex shrink-0">
                    {marks.map((row, index) => (
                        <span key={row.providerId} className={`inline-flex rounded-full shadow-[0_0_0_2px_var(--st-accent)] ${index > 0 ? '-ml-2' : ''}`}>
                            <PlatformMark providerId={row.providerId} label={row.shortName} size={32} />
                        </span>
                    ))}
                </span>
                <span className="truncate">{t('home.login')}</span>
            </Button>
            <p className="mt-4 text-[12px] leading-4 text-white/45">{t('login.spotlightFootnote')}</p>
        </div>,
        document.body,
    );
};

export default SignInSpotlight;
