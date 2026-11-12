import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plug } from 'lucide-react';
import type { BravaisHomeAccount } from './bravaisHomeModels';
import BravaisProviderAvatar from './BravaisProviderAvatar';
import './bravaisAccount.css';
import { Button } from '../../../components/ui';

// src/library/suites/bravais/BravaisSeamAccountSwitcher.tsx
// 首页在线页签窄缝里的账户入口，和 grid 主页右下角的切换器（SwitcherPill）一样：一个按钮，点了打开共用的登录窗口。
// 已登录时按钮是头像 + 昵称，窗口开在正在用的平台上；无需登录的平台是记号 + 平台名；没有人登录时是连接图标 +
// 「连接在线平台」，窗口不替用的人选平台。换平台、登录、退出登录都在那个窗口里（平台再多也只是窗口左边那一列长一些）。
// 平台名与账户状态进 aria-label / title。书脊上只留一个图标按钮，点它也直接打开窗口。
// 未登录时这颗「连接」图标和 grid 主页的登录按钮（.login-cta）一样带一圈呼吸的光晕，图标上面还有一行字
// 说登录是为了什么 —— 见 bravaisAccount.css。字和光晕都只画在「真的没人登录」上：登录失效那一档
// （is-expired）不画，和 HomeLoginPanel 的 nudge 同一个判断。书脊上的 compact 也走同一套（只是没有那行字：
// 64px 的书脊只有一颗图标，写不下），否则缝收起来时提示就没了。
// data-bravais-account：已登录 signed-in，未登录 guest，正在确认 checking。

const BravaisSeamAccountSwitcher: React.FC<{
    account: BravaisHomeAccount;
    compact: boolean;
    /** 横的首页窄缝的测量副本：同样的尺寸，不带按钮、data 属性与可访问名（BravaisSeamHomeRow 量宽度用）。 */
    measure?: boolean;
}> = ({ account, compact, measure = false }) => {
    const { t } = useTranslation();
    const nudge = account.guest && !account.expired;
    const status = [account.providerLabel, account.detail].filter(Boolean).join(' · ');
    const label = `${account.guest ? account.connectLabel : account.toggleLabel} · ${status}`;
    const state = account.guest ? (account.expired ? ' is-guest is-expired' : ' is-guest') : '';
    const picture = account.guest
        ? <span className="bravais-account-avatar is-connect" aria-hidden data-bravais-account-avatar="connect"><Plug /></span>
        : <BravaisProviderAvatar providerId={account.providerId} name={account.providerLabel} avatarUrl={account.avatarUrl} />;
    const open = (event: React.MouseEvent<HTMLButtonElement>) => account.onOpen(event.currentTarget);

    if (measure) {
        // 头像 / 徽章 / 连接图标都是同一个尺寸的圆，占位 span 就够量宽度。
        return compact ? (
            <span className="bravais-account-switcher is-compact">
                <span className="bravais-seam-icon bravais-account-spine"><span className="bravais-account-avatar" /></span>
            </span>
        ) : (
            <span className="bravais-account-switcher">
                <span className={`bravais-account-entry ${account.guest ? 'bravais-account-connect' : 'bravais-account-toggle'}`}>
                    <span className="bravais-account-avatar" />
                    <span className="is-name">{account.checking ? account.detail : account.guest ? account.connectLabel : account.nickname ?? account.providerLabel}</span>
                </span>
            </span>
        );
    }

    if (compact) {
        return (
            <div className={`bravais-account-switcher is-compact${state}`} data-bravais-account={account.guest ? 'guest' : 'signed-in'}>
                <Button className="bravais-seam-icon bravais-account-spine" data-bravais-account-toggle="compact"
                    aria-haspopup="dialog" aria-label={label} title={label} onClick={open}>
                    {picture}
                </Button>
            </div>
        );
    }

    return (
        <div className={`bravais-account-switcher${state}`} data-bravais-account={account.checking ? 'checking' : account.guest ? 'guest' : 'signed-in'}>
            <Button className={`bravais-account-entry ${account.guest ? 'bravais-account-connect' : 'bravais-account-toggle'}`}
                data-bravais-account-toggle={account.guest ? 'connect' : 'strip'} aria-haspopup="dialog" aria-label={label} title={label} onClick={open}>
                {nudge && <span className="is-nudge">{t('home.guestCta')}</span>}
                {picture}
                <span className="is-name">{account.checking ? account.detail : account.guest ? account.connectLabel : account.nickname ?? account.providerLabel}</span>
            </Button>
        </div>
    );
};

export default BravaisSeamAccountSwitcher;
