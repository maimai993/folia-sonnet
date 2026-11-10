import React from 'react';
import { LogOut, RefreshCw, Crown, User as UserIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioQualityPreference } from '../../types/onlineMusic';
import type { LibraryAccountController, LibraryAccountSnapshot } from '../../library/core/account/account.contract';
import { useLibraryAccountProviders, useLibraryAccountSelector } from '../../library/core/account/useLibraryAccount';
import { canLogoutProvider } from '../../library/core/account/accountRules';
import { omni } from '../../services/onlineMusic/omni';
import { providerDisplayName } from '../../i18n/providerName';
import { openLoginWindow } from '../login/loginWindowStore';
import { PlatformMark } from '../login/PlatformMark';
import { Select, Toggle } from '../modal/settings/kit';
import { useKitReducedMotion } from '../modal/settings/kit/motion';
import { GroupLine } from './shell/GroupLine';
import { PanelButton } from './shell/PanelButton';
import { PanelIconButton } from './shell/PanelIconButton';
import { PanelRow } from './shell/PanelRow';
import { shortAccountId } from '../../utils/accountIdDisplay';
import { isCapacitorAndroid } from '../../platform/runtime';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { PlaybackSignalPathButton } from '../hifi/PlaybackSignalPathButton';
import LanCastControl from '../lan-cast/LanCastControl';

// src/components/panelTab/AccountTab.tsx
// The panel's account tab: who is signed in on the active platform (or that nobody is, or that the
// sign-in ran out, with the way to the home page and its sign-in window), the default audio quality as one row with a pick list, and the
// button that syncs the account's data. The platform, its account and the sign-out come from the
// account controller (library/core/account/providerAccountController.service.ts), which asks first.

interface AccountTabProps {
    /** 在线账户 controller：当前平台、它的账号与登出都经它（与登录窗口同一条路）。 */
    accountController: LibraryAccountController;
    audioQuality: AudioQualityPreference;
    onAudioQualityChange: (quality: AudioQualityPreference) => void;
    onSyncData: () => void;
    isSyncing: boolean;
    onNavigateHome: () => void;
    /** 投送浮层按日间/夜间取配色（和播放页那颗旧按钮一致）。 */
    isDaylight: boolean;
}

const AUDIO_QUALITY_OPTIONS: Array<{
    value: AudioQualityPreference;
    labelKey: string;
}> = [
    { value: 'standard', labelKey: 'account.qualityStandard' },
    { value: 'high', labelKey: 'account.qualityExhigh' },
    { value: 'ultra', labelKey: 'account.qualityUltra' },
    { value: 'lossless', labelKey: 'account.qualityLossless' },
    { value: 'hires', labelKey: 'account.qualityHires' },
];

const selectLogoutPending = (snapshot: LibraryAccountSnapshot) => snapshot.logout.status === 'pending';

const AccountTab: React.FC<AccountTabProps> = ({
    accountController,
    audioQuality,
    onAudioQualityChange,
    onSyncData,
    isSyncing,
    onNavigateHome,
    isDaylight,
}) => {
    const { t } = useTranslation();
    const reduced = useKitReducedMotion();
    // 当前平台取 controller 快照里回落过的那个，账号是它自己的（不拿别的平台的账号顶上）。
    const { providers, activeProviderId } = useLibraryAccountProviders(accountController);
    const activeSummary = providers.find(provider => provider.providerId === activeProviderId);
    const activeUser = activeSummary?.user || null;
    // 登出按钮只在 controller 会接受时可用（账号已经显示、平台却还没确认登录着的那一会儿不可用），登出进行中同样不可用。
    const logoutPending = useLibraryAccountSelector(accountController, selectLogoutPending);
    const canLogout = !logoutPending && canLogoutProvider(activeSummary);
    // Only the levels the active provider tells apart are offered. The stored preference is one
    // value for every provider: where this one does not list it, the level it stands for here is lit.
    const qualityLevels = omni.getAudioQualityLevels(activeProviderId);
    const qualityOptions = AUDIO_QUALITY_OPTIONS.filter(option => qualityLevels.includes(option.value));
    const litQuality = omni.resolveAudioQuality(activeProviderId, audioQuality);

    const handleLogout = () => accountController.logout(activeProviderId);
    // The sign-in of the platform in use ran out: the account has left, and the row says so.
    const ranOut = !activeUser && activeSummary?.error === 'auth-required';
    // To the home page, with the sign-in window open there: on that platform when its sign-in ran out.
    const signInOnHome = () => {
        openLoginWindow(ranOut ? activeProviderId : null);
        onNavigateHome();
    };
    /*
     * 关闭人声（中置相消）。
     *
     * 只出现在安卓：它靠原生 AudioSink 那条链实时处理（VocalCancelProcessor.kt），
     * 桌面端的出声不经过那条链，放一颗点了没反应的开关比不放更糟。
     */
    const vocalCancelEnabled = useAudioSettingsStore(state => state.vocalCancelEnabled);
    const toggleVocalCancel = useAudioSettingsStore(state => state.handleToggleVocalCancel);

    return (
        <div>
            {activeUser ? (
                <div className="flex min-h-14 items-center gap-3 py-1 pl-1">
                    <span className="relative shrink-0">
                        {activeUser.avatarUrl ? (
                            <img
                                src={activeUser.avatarUrl.replace('http:', 'https:')}
                                className="h-10 w-10 rounded-full bg-[var(--st-fill)] object-cover"
                                alt={activeUser.nickname}
                            />
                        ) : (
                            <span className="grid h-10 w-10 place-items-center rounded-full bg-[var(--st-fill)] text-[color:var(--st-t3)]">
                                <UserIcon size={18} />
                            </span>
                        )}
                        {/* The platform's mark, on the corner of the picture. */}
                        <span className="absolute -bottom-[3px] -right-[3px] inline-flex rounded-full shadow-[0_0_0_2px_var(--st-win)]">
                            <PlatformMark providerId={activeProviderId} size={16} />
                        </span>
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-semibold leading-5">
                            <span className="truncate">{activeUser.nickname}</span>
                            {Boolean(activeUser.vipType && activeUser.vipType !== 0) && (
                                <Crown size={14} className="shrink-0 text-[color:var(--st-warn)]" />
                            )}
                        </div>
                        <div className="truncate text-xs leading-[18px] text-[color:var(--st-t2)]">
                            {activeSummary ? providerDisplayName(t, activeSummary, activeProviderId) : activeProviderId} · ID: {shortAccountId(String(activeUser.id))}
                        </div>
                    </div>
                    <PanelIconButton label={t('account.logout')} disabled={!canLogout} onClick={() => void handleLogout()}>
                        <LogOut size={17} />
                    </PanelIconButton>
                </div>
            ) : (
                <PanelRow label={ranOut ? t('status.loginExpired') : t('account.guestMode')}>
                    <PanelButton onClick={signInOnHome}>{t('account.loginOnHome')}</PanelButton>
                </PanelRow>
            )}

            <GroupLine />

            {/* Provider-independent audio quality preference; each online provider maps these semantic presets. */}
            <PanelRow label={t('account.audioQuality')}>
                <Select
                    name={t('account.audioQuality')}
                    // The panel sits at the bottom of the window: a list that opens down covers the tab row.
                    preferAbove
                    value={litQuality}
                    options={qualityOptions.map(option => ({ value: option.value, label: t(option.labelKey) }))}
                    // (The lit level is where the stored preference already stands on this provider: choosing it
                    // changes nothing here, and must not lower what is stored for the other providers.)
                    onChange={(quality) => { if (quality !== litQuality) onAudioQualityChange(quality); }}
                />
            </PanelRow>

            <PlaybackSignalPathButton />

            {/* 关闭人声：只在安卓（原生 AudioSink 那条链在，桌面端没有）。
                ★ 目前不挂在音频链上：这个处理器的透传分支连续两版都把样本写坏
                （开不开都是滋滋声），已从 FoliaAudioSinkFactory 摘掉。开关保留，
                但打开不会有任何效果 —— 恢复前必须先在设备上逐样本验证透传无损。 */}
            {isCapacitorAndroid() && (
                <PanelRow
                    label={t('account.vocalCancel')}
                    hint={t('account.vocalCancelHint')}
                >
                    <Toggle
                        checked={vocalCancelEnabled}
                        onChange={toggleVocalCancel}
                        label={t('account.vocalCancel')}
                    />
                </PanelRow>
            )}

            {/* 投送（DLNA 音响）入口。放在音质页、跟着信号链路 —— 两者都是「这首歌最后怎么出声」
                的事，而播放页上原来那颗悬浮按钮会压住「正在播放」提示卡（issue #279）。 */}
            <LanCastControl variant="tile" isDaylight={isDaylight} />

            {activeUser && (
                <div className="flex px-1 py-2">
                    <PanelButton grow disabled={isSyncing} onClick={onSyncData}>
                        <RefreshCw size={14} className={isSyncing && !reduced ? 'animate-spin' : undefined} />
                        {isSyncing ? t('account.syncing') : t('account.syncData')}
                    </PanelButton>
                </div>
            )}
        </div>
    );
};

export default AccountTab;
