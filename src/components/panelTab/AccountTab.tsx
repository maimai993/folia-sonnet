import React, { useEffect } from 'react';
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
import { Select } from '../modal/settings/kit';
import { useKitReducedMotion } from '../modal/settings/kit/motion';
import { GroupLine } from './shell/GroupLine';
import { PanelButton } from './shell/PanelButton';
import { PanelIconButton } from './shell/PanelIconButton';
import { PanelRow } from './shell/PanelRow';
import { Segments } from './shell/Segments';
import { shortAccountId } from '../../utils/accountIdDisplay';
import { isCapacitorAndroid } from '../../platform/runtime';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useVisualizerSettingsStore } from '../../stores/useVisualizerSettingsStore';
import { refreshInstrumentalStatus } from '../../services/playbackEngine/nativeEqualizer';
import { PlaybackSignalPathButton } from '../hifi/PlaybackSignalPathButton';
import BilibiliAccountRows from './BilibiliAccountRows';
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
    /** 打开某个 UP 主的投稿页（关注 / 粉丝列表里点头像）。不给就不可点。 */
    onOpenBilibiliUser?: (mid: number, name: string) => void;
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

/*
 * 视频平台的那几档叫「清晰度」，不叫音质。
 *
 * 同一个 stored 偏好（standard / high / ultra / lossless / hires）在两个世界里意思一样：
 * 更清楚的那一档。只是标签不同 —— 选「标准」在音乐平台是普通音质，在 B 站是 480P。
 *
 * **五档都要有对应**：以前只写了前三档，大会员那两个（lossless / hires）落回音质那套
 * 名字，于是同一行里前三个写着 480P/720P/1080P、后两个写着「无损 / Hi-Res」——
 * 用户报的「音质显示成画质」其实就是这一行自相矛盾。B 站没有「无损」这回事，
 * 它的高阶档是 1080P60 和 4K（见 api.ts 的 qualityToQn）。
 */
const VIDEO_QUALITY_LABEL_KEYS: Record<AudioQualityPreference, string> = {
    standard: 'account.quality480p',
    high: 'account.quality720p',
    ultra: 'account.quality1080p',
    lossless: 'account.quality1080p60',
    hires: 'account.quality4k',
};

/** 视频平台（B 站）：结果是一段视频，这一行说的是清晰度。 */
const isVideoPlatform = (providerId: string | null | undefined): boolean => providerId === 'bilibili';
const selectLogoutPending = (snapshot: LibraryAccountSnapshot) => snapshot.logout.status === 'pending';

const AccountTab: React.FC<AccountTabProps> = ({
    accountController,
    audioQuality,
    onAudioQualityChange,
    onSyncData,
    isSyncing,
    onNavigateHome,
    onOpenBilibiliUser,
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
    const vocalOnlyEnabled = useAudioSettingsStore(state => state.vocalOnlyEnabled);
    const setVocalMode = useAudioSettingsStore(state => state.handleSetVocalMode);
    const vocalCancelState = useAudioSettingsStore(state => state.vocalCancelState);
    const vocalCancelPercent = useAudioSettingsStore(state => state.vocalCancelPercent);
    /*
     * 这一行的说明要跟着「做到哪一步」走：
     *   关着 → 说明它靠中置相消，有个固有代价；
     *   开着且在分离 → 报进度（几十秒，不能让人以为开关坏了）；
     *   开着且就绪 → 播的是离线分离的伴奏，人声真没了；
     *   失败 → 退回实时相消，别让人等一个不会来的结果。
     */
    const anyVocalMode = vocalCancelEnabled || vocalOnlyEnabled;
    // 三态选中值取「用户意图」（两个开关），不取 vocalTrackMode（那是原生实际上报的模式，
    // 分离进行中会滞后，拿它做选中态会跳回旧值）。
    const vocalMode: 'off' | 'vocal' | 'instrumental' = vocalCancelEnabled
        ? 'instrumental'
        : vocalOnlyEnabled ? 'vocal' : 'off';
    const vocalModeLabels: Record<'off' | 'vocal' | 'instrumental', string> = {
        off: t('account.vocalTrackAll'),
        vocal: t('account.vocalTrackVocal'),
        instrumental: t('account.vocalTrackAccompaniment'),
    };
    const vocalCancelHint = !anyVocalMode
        ? t('account.vocalCancelHint')
        : vocalCancelState === 'building'
            ? `${t('account.vocalCancelBuilding')} ${vocalCancelPercent}%`
            : vocalCancelState === 'ready'
                ? (vocalMode === 'vocal' ? t('account.vocalOnlyReady') : t('account.vocalCancelReady'))
                : vocalCancelState === 'failed'
                    ? t('account.vocalCancelFailed')
                    : t('account.vocalCancelHint');

    /*
     * 进这一页问一次真实状态（进度 + 缓存用量）。
     *
     * 开关拨动也问一次 —— 打开时可能刚命中缓存、顺手清了旧的。
     */
    useEffect(() => {
        if (isCapacitorAndroid()) refreshInstrumentalStatus();
    }, [vocalCancelEnabled, vocalOnlyEnabled]);

    /*
     * 开关开着的时候每 1.5 秒自己问一次。
     *
     * 光靠原生推事件不够：事件丢了界面就永远停在「正在分离人声 0%」，
     * 而原生那边可能已经跑完、甚至已经切到伴奏了。轮询是这里唯一的兜底 ——
     * 它读的是原生三个 volatile 字段，不遍历目录、不碰音频线程。
     *
     * 条件写成「开关开着」而不是「状态是 building」：状态本身也靠这条通道回填，
     * 一旦靠状态来开关轮询，通道坏了就再也醒不过来（事件丢了 → 一直 idle → 不轮询）。
     * 只在这一页开着、而且开关开着时才跑，代价是 1.5 秒一次跨桥读三个数。
     */
    useEffect(() => {
        if (!isCapacitorAndroid() || !anyVocalMode) return undefined;
        const timer = window.setInterval(refreshInstrumentalStatus, 1500);
        return () => window.clearInterval(timer);
    }, [anyVocalMode]);

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
            {(() => {
                /*
                 * 这一行叫什么跟两件事走：当前平台是不是视频站、以及 MV 背景开没开。
                 *
                 * B 站登录着（不管放的是什么）是「画质」；别的平台平时是「音质」，
                 * 但壁纸背景选了 MV（或歌词样式选了 MV 款）时，取流那头走的是 B 站的
                 * 清晰度档 —— 那一行也得跟着说「画质」，不然选项写 1080P、行头写
                 * 「音质」，谁也不知道这两件事是一件事。
                 */
                const mvBackground = useVisualizerSettingsStore(state => state.lyricsWallpaperBackground) === 'mv';
                const qualityIsPicture = isVideoPlatform(activeProviderId) || mvBackground;
                const rowLabel = qualityIsPicture ? t('account.videoQuality') : t('account.audioQuality');
                return (
                    <PanelRow label={rowLabel}>
                        <Select
                            name={rowLabel}
                            // The panel sits at the bottom of the window: a list that opens down covers the tab row.
                            preferAbove
                            value={litQuality}
                            options={qualityOptions.map(option => ({
                                value: option.value,
                                // 视频平台（或 MV 背景开着）这一行说的是清晰度（480P / 720P / 1080P），不是音质。
                                label: t((qualityIsPicture && VIDEO_QUALITY_LABEL_KEYS[option.value]) || option.labelKey),
                            }))}
                            // (The lit level is where the stored preference already stands on this provider: choosing it
                            // changes nothing here, and must not lower what is stored for the other providers.)
                            onChange={(quality) => { if (quality !== litQuality) onAudioQualityChange(quality); }}
                        />
                    </PanelRow>
                );
            })()}

            <PlaybackSignalPathButton />

            {/* 三态「全部 / 人声 / 伴奏」：一行三选一，取代原来两个互斥开关。
                只在安卓出现（原生 AudioSink 那条链在，桌面端没有）。
                分离缓存的用量已搬到「设置 → 存储」，与其余缓存并列显示。 */}
            {isCapacitorAndroid() && (
                <PanelRow
                    label={t('account.vocalTrackMode')}
                    hint={vocalCancelHint}
                >
                    <Segments
                        fill
                        value={vocalMode}
                        onChange={setVocalMode}
                        options={(['off', 'vocal', 'instrumental'] as const).map(value => ({ value, label: vocalModeLabels[value] }))}
                    />
                </PanelRow>
            )}

            {/* 投送（DLNA 音响）入口。放在音质页、跟着信号链路 —— 两者都是「这首歌最后怎么出声」
                的事，而播放页上原来那颗悬浮按钮会压住「正在播放」提示卡（issue #279）。 */}
            <LanCastControl variant="tile" isDaylight={isDaylight} />

            {/* B 站特有的那几行：关注 / 粉丝 / 签名。只在登录着、且当前平台就是它时挂出来 ——
                别的平台没有「关注」这种关系，摆一行点了没反应的按钮比不摆更糟。 */}
            {activeUser && activeProviderId === 'bilibili' && (
                <BilibiliAccountRows
                    providerId={activeProviderId}
                    onOpenUser={onOpenBilibiliUser
                        ? user => onOpenBilibiliUser(user.mid, user.name)
                        : undefined}
                />
            )}

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
