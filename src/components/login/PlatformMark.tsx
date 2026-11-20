import React from 'react';
import { omni } from '../../services/onlineMusic/omni';
import type { OnlineProviderId, ProviderUser } from '../../types/onlineMusic';
import { PlatformIcon } from '../shared/platformIcons/PlatformIcon';
import { hasPlatformIcon } from '../shared/platformIcons/registry';
import { onAccentColor } from '../modal/settings/kit/kitTheme';
import { resolvePlatformMark } from './resolvePlatformMark';
import { isCapacitorAndroid } from '../../platform/runtime';

// src/components/login/PlatformMark.tsx
// 平台的记号和账号的头像，登录窗口、主页的登录按钮、切换器和控制面板的账号页都画这两样。
// 记号上的黄点是「这个平台的登录失效了」。角上的小记号和黄点外面那一圈，颜色取所在表面的
// `--login-edge`（没有设就是卡片的颜色）。

const EDGE = '0 0 0 2px var(--login-edge, var(--st-card))';

/** 桌面端（Electron）与安卓（Capacitor）都算「App 里」：两者都不是会被 mixed-content 拦下的普通网页。 */
const isAppRuntime = (): boolean => (
    typeof window !== 'undefined' && (Boolean((window as { electron?: unknown }).electron) || isCapacitorAndroid())
);

/** 一个平台的记号的字和颜色，连同画在这种颜色上的字的颜色。 */
export const platformMarkOf = (providerId: OnlineProviderId, label?: string) => {
    const mark = resolvePlatformMark(omni.getProviderMark(providerId), label ?? omni.getProviderLabel(providerId));
    return { ...mark, onColor: onAccentColor(mark.color) };
};

type PlatformMarkProps = {
    providerId: OnlineProviderId;
    /** 平台的短名；没有声明记号的平台从它取字。 */
    label?: string;
    size: number;
    ranOut?: boolean;
    className?: string;
};

export const PlatformMark: React.FC<PlatformMarkProps> = ({ providerId, label, size, ranOut, className }) => {
    const mark = platformMarkOf(providerId, label);
    /*
     * 有自绘图形的平台亮那颗图形，不画字。
     *
     * 这个记号登录窗口、主页的登录按钮、切换器、控制面板的账号页、资料库的平台徽章都在用。
     * 图形与平台 id 的对应表在 platformIcons/registry（平台自己的那一份），这里只问
     * `hasPlatformIcon`：有图形就画图形，没有才回落「字 + 颜色」的字母徽章
     * （mod 加进来的平台、将来的新平台都走这一条，不会出现空洞）。
     *
     * 注释里不点名平台：这一层要与平台无关（loginModuleKnowsNoPlatform 那条守卫会扫本目录），
     * 平台自己的东西由它自己的 adapter 通过 omni 声明、由 registry 登记。
     */
    const hasArt = hasPlatformIcon(providerId);
    if (hasArt) {
        return (
            <span className={`relative inline-flex shrink-0 ${className ?? ''}`} style={{ width: size, height: size }}>
                <PlatformIcon platformId={providerId} size={size} round className="h-full w-full" />
                {ranOut && (
                    <i className="absolute -right-px -top-px h-2.5 w-2.5 rounded-full bg-[var(--st-warn)]" style={{ boxShadow: EDGE }} />
                )}
            </span>
        );
    }
    return (
        <span
            aria-hidden
            className={`relative inline-grid shrink-0 place-items-center rounded-full font-bold leading-none ${className ?? ''}`}
            style={{
                width: size,
                height: size,
                // 没有图形才需要底色配字。
                background: mark.color,
                color: mark.onColor,
                fontSize: Math.round(size * 0.42),
            }}
        >
            {mark.letter}
            {ranOut && (
                <i className="absolute -right-px -top-px h-2.5 w-2.5 rounded-full bg-[var(--st-warn)]" style={{ boxShadow: EDGE }} />
            )}
        </span>
    );
};

/**
 * 账号头像的地址。网页端把 http 的地址换成 https（https 的页面不让载 http 的图）；App 里原样用，
 * 有的平台的头像只在 http 上。
 *
 * 「App 里」不只是桌面端：安卓 WebView 里页面同样不是那个会被 mixed-content 拦下的普通网页，
 * 而有些平台的头像域名在 https 上未必给得出图 —— 一律改写成 https 就是「头像永远是空的」。
 */
export const accountPictureSrc = (avatarUrl: string, inApp: boolean): string => (
    inApp ? avatarUrl : avatarUrl.replace(/^http:/, 'https:')
);

type AccountPictureProps = {
    user: ProviderUser;
    size: number;
    /** 给了就在角上画这个平台的记号。 */
    providerId?: OnlineProviderId;
    ranOut?: boolean;
    /** 角上那个记号的元素：登录成功的动画让它一路显出来。 */
    cornerRef?: React.Ref<HTMLSpanElement>;
};

export const AccountPicture: React.FC<AccountPictureProps> = ({ user, size, providerId, ranOut, cornerRef }) => {
    const corner = Math.max(14, Math.round(size * 0.44));
    return (
        <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
            {user.avatarUrl ? (
                <img
                    src={accountPictureSrc(user.avatarUrl, isAppRuntime())}
                    alt=""
                    draggable={false}
                    className="h-full w-full rounded-full bg-[var(--st-fill)] object-cover"
                />
            ) : (
                <span
                    aria-hidden
                    className="grid h-full w-full place-items-center rounded-full bg-[var(--st-fill2)] font-semibold leading-none text-[color:var(--st-t1)]"
                    style={{ fontSize: Math.round(size * 0.42) }}
                >
                    {[...user.nickname.trim()][0] ?? ''}
                </span>
            )}
            {providerId && (
                <span ref={cornerRef} className="absolute -bottom-[3px] -right-[3px] inline-flex rounded-full" style={{ boxShadow: EDGE }}>
                    <PlatformMark providerId={providerId} size={corner} ranOut={ranOut} />
                </span>
            )}
        </span>
    );
};
