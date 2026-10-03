import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Loader2, Settings, PanelsTopLeft } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { resolveSearchSource, useSearchNavigationStore } from '../../../../stores/useSearchNavigationStore';
import { useShallow } from 'zustand/react/shallow';
import { SongResult, LocalSong, LocalPlaylist, LocalLibraryGroup, Theme, type StatusMessage } from '../../../../types';
import LocalGrid3DView from './LocalGrid3DView';
import NavidromeGrid3DView from './NavidromeGrid3DView';
import DesktopGrid3DSurface from './DesktopGrid3DSurface';
import { useOnlineProviderQrLogin } from '../../../../hooks/useOnlineProviderQrLogin';
import type { OnlineProviderPlatformState } from '../../../../hooks/useOnlineProviderPlatform';
import { omni } from '../../../../services/onlineMusic/omni';
import OnlineProviderSwitcher from '../../../../components/app/home/OnlineProviderSwitcher';
import OnlineProviderConnectPanel from '../../../../components/app/home/OnlineProviderConnectPanel';
import OnlineProviderAccountlessPanel from '../../../../components/app/home/OnlineProviderAccountlessPanel';
import OnlineProviderLoginModal from '../../../../components/app/home/OnlineProviderLoginModal';
import { buildQrLoginDiagnosticsProps } from '../../../../components/app/home/buildQrLoginDiagnosticsProps';
import { canSwitchToProviderDirectly } from '../../../core/model/onlineProviderAccountView';
import type { ProviderAccountSummary, ProviderCollection, ProviderUser } from '../../../../types/onlineMusic';
import qqIcon from '../../../../assets/providers/qq.svg';
import wechatIcon from '../../../../assets/providers/wechat.svg';
import { useNeteaseApiStatusStore } from '../../../../stores/useNeteaseApiStatusStore';
import { useThemeSettingsStore } from '../../../../stores/useThemeSettingsStore';
import { countRender } from '../../../../dev/renderCount';
import type { LibraryDirectoryBatchController } from '../../../core/contracts/directory';
import type { LibraryLocalCatalogSnapshot } from '../../../core/contracts/home';
import type { LibraryHomeResources } from '../../../core/contracts/homeModel';
import type { LibraryDeclaredActions } from '../../../core/contracts/suite';
import type { LibraryHomeCard, LibraryHomeListState } from '../../../core/contracts/homeModel';
import { useLibraryHomeSources } from '../../../core/bindings/useLibraryHomeSources';
import { useLibraryHomeOnline } from '../../../core/bindings/useLibraryHomeOnline';
import { useLibraryHomeActions } from '../../../core/bindings/useLibraryHomeActions';
import { useLibraryHomeDirectory } from '../../../core/bindings/useLibraryHomeDirectory';
import { useLibraryHomeListRegistration, useLibraryHomeTabsRegistration } from '../../../core/bindings/useLibraryHomeSurfaceRegistration';

// src/library/suites/grid/home/Grid3D.tsx
// Glassmorphic interactive desktop home view replacing the legacy 3D carousel.
// Supports cover sliding with auto-fading header controls and delegates GridView opening upward.

// Each provider scans from its own app, so the modal copy is keyed here instead of nested in the JSX.
const LOGIN_COPY_BY_PROVIDER: Record<string, { title: string; note: string }> = {
    kugou: { title: 'home.loginTitleKugou', note: 'home.loginNoteKugou' },
    qq: { title: 'home.loginTitleQq', note: 'home.loginNoteQq' },
    bodian: { title: 'home.loginTitleBodian', note: 'home.loginNoteBodian' },
};
const NETEASE_LOGIN_COPY = { title: 'home.loginTitle', note: 'home.loginNote' };

// provider 只声明 iconKey 字符串，静态资源的映射留在 UI 层，services 层不碰 .svg。
const LOGIN_METHOD_ICONS: Record<string, string> = {
    qq: qqIcon,
    wechat: wechatIcon,
};

interface Grid3DProps {
    onlineProviderPlatform?: OnlineProviderPlatformState;
    onPlaySong: (song: SongResult, playlistCtx?: SongResult[], isFmCall?: boolean) => void;
    onBackToPlayer: () => void;
    onRefreshUser: () => void;
    user: ProviderUser | null;
    playlists: ProviderCollection[];
    cloudPlaylist?: ProviderCollection | null;
    currentTrack?: SongResult | null;
    localSongs: LocalSong[];
    localLibraryCatalog: LibraryLocalCatalogSnapshot;
    localPlaylists: LocalPlaylist[];
    onRefreshLocalSongs: () => Promise<void> | void;
    localMusicState: {
        activeRow: 0 | 1 | 2 | 3;
        selectedGroup: LocalLibraryGroup | null;
        detailStack: LocalLibraryGroup[];
        detailOriginView: 'home' | 'player' | null;
        focusedFolderIndex: number;
        focusedAlbumIndex: number;
        focusedArtistIndex: number;
        focusedPlaylistIndex: number;
    };
    setLocalMusicState: React.Dispatch<React.SetStateAction<{
        activeRow: 0 | 1 | 2 | 3;
        selectedGroup: LocalLibraryGroup | null;
        detailStack: LocalLibraryGroup[];
        detailOriginView: 'home' | 'player' | null;
        focusedFolderIndex: number;
        focusedAlbumIndex: number;
        focusedArtistIndex: number;
        focusedPlaylistIndex: number;
    }>>;
    navidromeFocusedAlbumIndex?: number;
    setNavidromeFocusedAlbumIndex?: (index: number) => void;
    onSearchCommitted: (query: string, sourceTab: any, replace?: boolean) => void;
    theme: Theme;
    onOpenSettings?: (initialTab?: 'help' | 'options') => void;
    onOpenLattice?: () => void;
    navidromeEnabled?: boolean;
    onPlayAll?: (songs: SongResult[]) => void;
    onAddAllToQueue?: (songs: SongResult[]) => void;
    onStatusMessage?: (message: StatusMessage) => void;
    onOpenGridView?: (collection: any) => void;
    stageEnabled?: boolean;
    stageIsActive?: boolean;
    onOpenStagePlayer?: () => void;
    isInteractive?: boolean;
    /** 本地目录的批量动作控制器（宿主创建，见 LibraryHomeSurfaceProps）。 */
    directoryActions?: LibraryDirectoryBatchController;
    /** 首页资源（在线收藏专辑、电台 feed；宿主创建，见 library/app/useLibraryHomeResources）。 */
    homeResources: LibraryHomeResources;
    /** 网格 suite 在 entry 里声明的首页动作（宿主经 registry 传入）：GridMap 的目录 surface 只发布声明 ∩ core 判定。 */
    declaredActions?: LibraryDeclaredActions;
}

export const Grid3D: React.FC<Grid3DProps> = (props) => {
    countRender('Grid3D');
    const {
        onBackToPlayer,
        onRefreshUser,
        user,
        playlists,
        cloudPlaylist = null,
        currentTrack,
        localSongs,
        localLibraryCatalog,
        localPlaylists,
        localMusicState,
        setLocalMusicState,
        navidromeFocusedAlbumIndex = 0,
        setNavidromeFocusedAlbumIndex,
        onSearchCommitted,
        theme,
        onOpenSettings,
        onOpenLattice,
        navidromeEnabled = false,
        onOpenGridView,
        stageEnabled = false,
        stageIsActive = false,
        onOpenStagePlayer,
        onlineProviderPlatform,
        isInteractive = true,
        directoryActions,
        homeResources,
        declaredActions,
    } = props;

    const { t } = useTranslation();
    const {
        isDaylight,
    } = useThemeSettingsStore(useShallow(state => ({
        isDaylight: state.isDaylight,
    })));
    const {
        searchQuery,
        setSearchQuery,
        isSearching,
        submitSearch,
    } = useSearchNavigationStore(useShallow(state => ({
        searchQuery: state.searchQuery,
        setSearchQuery: state.setSearchQuery,
        isSearching: state.isSearching,
        submitSearch: state.submitSearch,
    })));

    // 来源、页签与在线列表都来自 Library Core 的首页模型（core/model/homeSources、homeCards 与首页资源）；
    // 这里只剩展示：布局、二维码登录、更新徽标、扫描进度胶囊。
    const homeSources = useLibraryHomeSources({
        platform: onlineProviderPlatform,
        user,
        playlists,
        cloudPlaylist,
        navidromeEnabled,
    });
    const { tab: homeViewTab, setTab: setHomeViewTab, isOnlineTab, online, tabs: homeTabs } = homeSources;
    const activeProviderId = online.providerId;
    const activeProviderSummary = online.provider;
    const activeProviderLabel = online.providerLabel;
    const activeUser = online.user;
    const activeAccountView = online.accountView;
    const activeProviderNeedsRelogin = online.needsRelogin;
    const onlineList = useLibraryHomeOnline(homeResources, homeSources);
    const homeActions = homeResources.actions;
    const { snapshot: homeActionState, scanPercent: scanProgressPercent } = useLibraryHomeActions(homeActions);
    const scanProgress = homeActionState.scan;
    // 当前列表的目录会话 key 与隐藏作用域只在首页模型里算一次（core/model/homeSources），交给三个列表视图。
    const { directoryKey, hiddenScope } = useLibraryHomeDirectory({
        tab: homeViewTab,
        providerId: activeProviderId,
        localRow: localMusicState.activeRow,
    });
    // 在线列表只在账户已就绪时显示（无账户 / 解析中 / 未登录各有面板）。
    const showOnlineList = isOnlineTab
        && activeAccountView !== 'accountless'
        && activeAccountView !== 'resolving'
        && activeAccountView !== 'guest';

    const [focusedIndex, setFocusedIndex] = useState(0);
    const gridRootRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [scanDetailsExpanded, setScanDetailsExpanded] = useState(false);

    const [updateStatus, setUpdateStatus] = useState<any>(null);

    useEffect(() => {
        if (!window.electron?.getUpdateStatus) {
            return;
        }

        let disposed = false;

        window.electron.getUpdateStatus().then((status) => {
            if (!disposed) {
                setUpdateStatus(status);
            }
        }).catch(() => {
            if (!disposed) {
                setUpdateStatus(null);
            }
        });

        const unsubscribe = window.electron.onUpdateStatusChanged?.((status) => {
            setUpdateStatus(status);
        });

        return () => {
            disposed = true;
            unsubscribe?.();
        };
    }, []);

    const showUpdateIndicator = Boolean(
        updateStatus?.updateCheckEnabled &&
        updateStatus.availableVersion &&
        !updateStatus.updateSeen
    );

    // Reset focused index when switching tabs.
    useEffect(() => {
        setFocusedIndex(0);
    }, [homeViewTab]);

    // Login QR State
    const [showLoginModal, setShowLoginModal] = useState(false);
    const [loginProviderId, setLoginProviderId] = useState(activeProviderId);
    // 泛型：provider 声明了多种扫码登录方式才走两步式，没声明的回空数组、维持单步流程。
    const [selectedLoginMethodId, setSelectedLoginMethodId] = useState<string | null>(null);
    const [loginMethodOptions, setLoginMethodOptions] = useState(() => omni.getQrLoginMethods(activeProviderId));
    const loginAttemptIdRef = useRef(0);
    const {
        qrCodeImg,
        qrState,
        qrStatusText,
        failure: qrLoginFailure,
        buildDiagnosticReport: buildQrDiagnosticReport,
        start: startQrLogin,
        stop: stopQrLogin,
    } = useOnlineProviderQrLogin({
        providerId: loginProviderId,
        t,
        onConfirmed: async (confirmedProviderId) => {
            setShowLoginModal(false);
            if (!onlineProviderPlatform) {
                onRefreshUser();
                return true;
            }
            const outcome = await onlineProviderPlatform.completeLogin(confirmedProviderId);
            // 扫码确认了却没拿到登录态：把弹窗重新打开，让用户看到失败和诊断入口，而不是静默停在未登录。
            if (outcome === 'refresh-failed') {
                setShowLoginModal(true);
                return false;
            }
            return true;
        },
    });

    const initLogin = async (providerId = activeProviderId) => {
        const summary = onlineProviderPlatform?.providers.find(provider => provider.providerId === providerId);
        if (summary && !summary.availability.configured) return;
        const attemptId = ++loginAttemptIdRef.current;
        // 等待远端能力发现，并把同一份结果同时用于流程分支与弹窗，避免异步结果让两者错位。
        const methods = await omni.resolveQrLoginMethods(providerId);
        if (attemptId !== loginAttemptIdRef.current) return;
        setLoginProviderId(providerId);
        setLoginMethodOptions(methods);
        setShowLoginModal(true);
        setSelectedLoginMethodId(null);
        // 有多种登录方式时先停在步骤一，选定之前不向后端要二维码。
        if (methods.length > 0) return;
        await startQrLogin(providerId);
    };

    // Shared by the switcher and the connect panel: switch now when there is nothing to sign in to.
    const selectProvider = (provider: ProviderAccountSummary) => {
        if (canSwitchToProviderDirectly(provider)) {
            void onlineProviderPlatform?.switchProvider(provider.providerId);
        } else {
            void initLogin(provider.providerId);
        }
    };

    // 网易云的本地后端起不来时，二维码请求必然失败；弹窗改为直接暴露原因和重启入口。
    const neteaseApiSupported = useNeteaseApiStatusStore(state => state.supported);
    const neteaseApiStatus = useNeteaseApiStatusStore(state => state.status);
    const neteaseApiRestarting = useNeteaseApiStatusStore(state => state.restarting);
    const restartNeteaseApi = useNeteaseApiStatusStore(state => state.restart);
    const neteaseBackendFailed = neteaseApiSupported
        && loginProviderId === 'netease'
        && neteaseApiStatus?.status === 'error';

    const handleRestartNeteaseApi = async () => {
        await restartNeteaseApi();
        // 重启成功后直接把二维码要回来，省掉一次手动刷新。
        if (useNeteaseApiStatusStore.getState().status?.status === 'running') {
            await startQrLogin('netease');
        }
    };

    const selectLoginMethod = (methodId: string) => {
        setSelectedLoginMethodId(methodId);
        void startQrLogin(loginProviderId, methodId);
    };

    useEffect(() => {
        setFocusedIndex(0);
    }, [activeProviderId, activeUser?.id]);

    // Delegate GridView opening to the app-level host so Grid3D remains only the home surface.
    // If Personal FM is clicked, it plays Personal FM directly instead of opening GridView.
    const handleSelectCollectionCard = (card: LibraryHomeCard) => {
        void homeActions.openOnlineCard(card, activeProviderId, collection => onOpenGridView?.(collection));
    };

    // 首页模型交给 core 的首页 surface 句柄：页签条，以及在线页签的列表（本地与 Navidrome 由各自的视图注册）。
    useLibraryHomeTabsRegistration({
        getState: () => ({ active: homeViewTab, tabs: homeTabs }),
        setTab: tab => {
            const target = homeTabs.find(candidate => candidate.key === tab);
            if (!target || target.disabledReason) return false;
            setHomeViewTab(tab);
            return true;
        },
    });
    useLibraryHomeListRegistration({
        enabled: showOnlineList,
        getState: (): LibraryHomeListState => ({
            tab: homeViewTab,
            directoryKey,
            hiddenScope,
            sections: [],
            items: onlineList.items,
            isLoading: onlineList.isLoading,
            actions: [],
            batchSelectionType: null,
        }),
        setSection: () => false,
        runAction: () => false,
    });

    // Search committed callback
    const handleSearch = async (e?: React.FormEvent) => {
        e?.preventDefault();
        const query = searchQuery.trim();
        if (!query) return;

        const searchSource = isOnlineTab ? activeProviderId : resolveSearchSource(homeViewTab);
        const didSearch = await submitSearch({
            query,
            sourceTab: searchSource,
            deps: {
                localSongs,
                localLibraryCatalog,
                t: (key, fallback) => t(key, fallback ?? ''),
            },
        });

        if (didSearch) {
            onSearchCommitted(query, searchSource);
        }
    };

    const isSearchingActive = isSearching;

    // Background style mappings
    const mainBg = isDaylight ? 'bg-white/40' : 'bg-black/20';
    const inputBg = isDaylight ? 'bg-black/5 focus:bg-black/10' : 'bg-white/5 focus:bg-white/10';
    const navPillBg = isDaylight ? 'bg-black/5' : 'bg-white/10';
    const navPillInactiveText = isDaylight ? 'text-black/60 hover:text-black' : 'text-white/60 hover:text-white';
    const activeTabBg = isDaylight ? 'text-black font-bold' : 'text-black';

    const bottomPadding = currentTrack ? 'pb-28 md:pb-32' : '';

    const focusActiveSlider = () => {
        requestAnimationFrame(() => {
            gridRootRef.current
                ?.querySelector<HTMLElement>('[data-grid3d-slider]')
                ?.focus({ preventScroll: true });
        });
    };

    return (
        <div
            ref={gridRootRef}
            data-ponder-page-scope="grid-page"
            className={`relative w-full h-full flex flex-col font-sans overflow-hidden ${mainBg} pointer-events-auto backdrop-blur-sm ${bottomPadding}`}
        >

            {/* Main Header Container (Fades out when sliding/interacting) */}
            <div className="transition-opacity duration-300 ease-in-out z-20 opacity-100 select-none">
                <div className="grid grid-cols-2 md:grid-cols-3 items-center w-full max-w-7xl mx-auto p-4 md:p-8 gap-y-4 md:gap-y-0">
                    {/* Left title and settings */}
                    <div className="flex items-center justify-start order-1 md:order-none">
                        <h1 className="text-2xl font-bold tracking-tight opacity-90 flex items-center gap-3">
                            Folia
                        </h1>
                        <button
                            onClick={() => onOpenSettings?.('help')}
                            className={`relative flex items-center gap-1.5 p-2 rounded-full hover:bg-white/10 transition-all ml-4 ${showUpdateIndicator
                                    ? 'opacity-90 hover:opacity-100'
                                    : 'opacity-40 hover:opacity-100'
                                }`}
                            title={t('ui.options')}
                        >
                            <Settings size={20} style={{ color: 'var(--text-primary)' }} />
                            {showUpdateIndicator && (
                                <span className="text-[10px] font-medium text-zinc-800 dark:text-zinc-200 opacity-80 whitespace-nowrap bg-zinc-200/50 dark:bg-white/10 px-2 py-0.5 rounded-md">
                                    {t('options.updateAvailable')}
                                </span>
                            )}
                        </button>
                        {scanProgress?.active && (
                            <div
                                className="relative ml-3"
                                onMouseEnter={() => setScanDetailsExpanded(true)}
                                onMouseLeave={() => setScanDetailsExpanded(false)}
                            >
                                <button
                                    onClick={() => setScanDetailsExpanded(prev => !prev)}
                                    className="relative rounded-full p-px transition-all"
                                    style={{
                                        background: `conic-gradient(from -90deg, ${isDaylight ? (theme?.accentColor || 'rgba(17,24,39,0.92)') : 'rgba(255,255,255,0.98)'} 0deg ${scanProgressPercent * 3.6}deg, ${isDaylight ? 'rgba(24,24,27,0.16)' : 'rgba(255,255,255,0.14)'} ${scanProgressPercent * 3.6}deg 360deg)`,
                                        borderRadius: '999px'
                                    }}
                                    title={t('options.scanProgress')}
                                >
                                    <div
                                        className={`relative flex items-center justify-center min-w-[56px] h-7 px-2.5 rounded-full backdrop-blur-md ${isDaylight ? 'bg-white/95 text-zinc-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]' : 'bg-zinc-950/92 text-zinc-100'
                                            }`}
                                    >
                                        <span className="relative z-10 text-[10px] font-semibold tabular-nums leading-none">
                                            {scanProgressPercent}%
                                        </span>
                                    </div>
                                </button>
                                <AnimatePresence>
                                    {scanDetailsExpanded && (
                                        <motion.div
                                            initial={{ opacity: 0, y: -6 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            exit={{ opacity: 0, y: -6 }}
                                            className={`absolute left-0 top-full mt-2 w-72 p-4 rounded-2xl border backdrop-blur-xl shadow-xl ${isDaylight ? 'bg-white/85 border-black/10 text-zinc-800' : 'bg-black/60 border-white/10 text-zinc-100'
                                                }`}
                                        >
                                            <div className="text-sm font-semibold truncate">
                                                {t('options.scanningFolder', { folderName: scanProgress.folderName })}
                                            </div>
                                            <div className={`text-xs mt-1 ${isDaylight ? 'text-zinc-600' : 'text-zinc-300/70'}`}>
                                                {t('options.scanProgressDesc')}
                                            </div>
                                            <div className="mt-3 flex items-center justify-between text-xs font-mono">
                                                <span>{t('ui.progress')}</span>
                                                <span>{Math.min(scanProgress.completedSongs, scanProgress.totalSongs)} / {scanProgress.totalSongs}</span>
                                            </div>
                                            <div className={`mt-2 w-full h-2 rounded-full overflow-hidden ${isDaylight ? 'bg-black/10' : 'bg-white/10'}`}>
                                                <div
                                                    className="h-full rounded-full transition-[width] duration-300 ease-out"
                                                    style={{
                                                        width: `${scanProgress.totalSongs > 0 ? (scanProgress.completedSongs / scanProgress.totalSongs) * 100 : 0}%`,
                                                        backgroundColor: theme?.accentColor || 'var(--text-primary)'
                                                    }}
                                                />
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        )}
                    </div>

                    {/* Center Tab Switcher */}
                    <div className="flex justify-center order-3 md:order-none col-span-2 md:col-span-1">
                        <div className={`relative ${navPillBg} backdrop-blur-md p-1 rounded-full scale-90 md:scale-100 origin-center`}>
                            <div className="inline-flex items-center gap-0">
                                {homeTabs.map((tab) => {
                                    const isActive = homeViewTab === tab.key;
                                    return (
                                        <span
                                            key={tab.key}
                                            title={tab.disabledReason || tab.label}
                                            className="inline-flex"
                                        >
                                            <button
                                                disabled={Boolean(tab.disabledReason)}
                                                aria-label={tab.disabledReason || tab.label}
                                                onClick={() => {
                                                    setHomeViewTab(tab.key);
                                                    focusActiveSlider();
                                                }}
                                                className={`relative inline-flex items-center justify-center px-4 py-1.5 rounded-full text-xs md:text-sm font-medium transition-colors duration-300 whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-35 ${isActive ? activeTabBg : navPillInactiveText}`}
                                            >
                                                {isActive && (
                                                    <motion.span
                                                        layoutId="home-active-tab-pill-desktop"
                                                        className="absolute inset-0 rounded-full bg-white shadow-sm"
                                                        transition={{ type: 'spring', stiffness: 460, damping: 36, mass: 0.9 }}
                                                    />
                                                )}
                                                <span className="relative z-10">{tab.label}</span>
                                            </button>
                                        </span>
                                    );
                                })}
                                {stageEnabled && (
                                    <button
                                        onClick={() => onOpenStagePlayer?.()}
                                        data-stage-active={stageIsActive ? 'true' : 'false'}
                                        className={`relative inline-flex items-center justify-center px-4 py-1.5 rounded-full text-xs md:text-sm font-medium transition-colors duration-300 whitespace-nowrap ${navPillInactiveText}`}
                                    >
                                        <span className="relative z-10">{t('home.stage')}</span>
                                    </button>
                                )}
                                {/* 播放队列的海报视图和 Stage 一样属于「去哪儿」，所以它在这一排，
                                    而不是标题旁的工具图标。没有在播歌曲时队列也是空的，直接不出现。
                                    平时只占一个图标的宽度，指针悬停或键盘聚焦时才展开文字——这一排
                                    已经有五个内容 tab，多一个常驻文字就把胶囊撑得太长。点击始终直达。 */}
                                {onOpenLattice && currentTrack && (
                                    <button
                                        onClick={onOpenLattice}
                                        data-testid="home-lattice-pill"
                                        title={t('home.lattice')}
                                        aria-label={t('home.lattice')}
                                        className={`group relative inline-flex items-center justify-center px-3 py-1.5 rounded-full text-xs md:text-sm font-medium transition-colors duration-300 whitespace-nowrap ${navPillInactiveText}`}
                                    >
                                        <PanelsTopLeft size={14} className="relative z-10 shrink-0" />
                                        <span
                                            aria-hidden="true"
                                            className="relative z-10 max-w-0 overflow-hidden opacity-0 transition-all duration-300 ease-out group-hover:ml-1.5 group-hover:max-w-28 group-hover:opacity-100 group-focus-visible:ml-1.5 group-focus-visible:max-w-28 group-focus-visible:opacity-100"
                                        >
                                            {t('home.latticeLabel')}
                                        </span>
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Right Search Bar */}
                    <div className="flex justify-end order-2 md:order-none">
                        <form onSubmit={handleSearch} className="relative w-full md:w-56 transition-all focus-within:md:w-72">
                            {isSearchingActive ? (
                                <Loader2 className="absolute left-3 top-1/2 w-4 h-4 animate-spin opacity-40 -mt-2" />
                            ) : (
                                <Search
                                    className="absolute left-3 top-1/2 -translate-y-1/2 opacity-40 w-4 h-4 cursor-pointer hover:opacity-100 transition-opacity"
                                    onClick={() => handleSearch()}
                                />
                            )}
                            <input
                                ref={searchInputRef}
                                type="text"
                                placeholder={homeViewTab === 'local' ? t('home.searchLocal') : homeViewTab === 'navidrome' ? t('home.searchNavidrome') : t('home.searchDatabase')}
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className={`w-full ${inputBg} border border-white/10 rounded-full py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-white/20 transition-all placeholder:text-current placeholder:opacity-40 select-text`}
                                style={{ color: 'var(--text-primary)' }}
                            />
                        </form>
                    </div>
                </div>
            </div>

            {/* Desktop Canvas Surface */}
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center relative">
                {isOnlineTab && activeAccountView === 'accountless' ? (
                    <OnlineProviderAccountlessPanel
                        providerLabel={activeProviderLabel}
                        isDaylight={isDaylight}
                        onSearch={() => searchInputRef.current?.focus()}
                    />
                ) : isOnlineTab && activeAccountView === 'resolving' ? (
                    <div className="flex flex-1 w-full items-center justify-center" aria-busy="true">
                        <Loader2 className="animate-spin opacity-30" size={28} />
                    </div>
                ) : isOnlineTab && activeAccountView === 'guest' ? (
                    <OnlineProviderConnectPanel
                        providers={onlineProviderPlatform?.providers || omni.getProviderSummaries()}
                        isDaylight={isDaylight}
                        title={activeProviderNeedsRelogin ? t('status.loginExpired') : t('home.guestTitle')}
                        prompt={activeProviderNeedsRelogin
                            ? t('home.guestPromptProvider', {
                                provider: activeProviderSummary?.shortName || activeProviderSummary?.displayName || activeProviderId,
                            })
                            : t('home.guestPrompt')}
                        getActionLabel={provider => canSwitchToProviderDirectly(provider)
                            ? t('home.switchToProvider', { provider: provider.shortName || provider.displayName })
                            : t('home.loginToProvider', { provider: provider.shortName || provider.displayName })}
                        onSelect={selectProvider}
                    />
                ) : showOnlineList ? (
                    <DesktopGrid3DSurface
                        focusMemoryScope={JSON.stringify(['online', activeProviderId, activeUser?.id ?? null, homeViewTab])}
                        title={onlineList.title}
                        mapButtonLabel={t('home.allAlbums')}
                        items={onlineList.items}
                        focusedIndex={focusedIndex}
                        onFocusedIndexChange={setFocusedIndex}
                        onSelect={item => handleSelectCollectionCard(item as LibraryHomeCard)}
                        isLoading={onlineList.isLoading}
                        emptyMessage={onlineList.emptyMessage}
                        theme={theme}
                        isDaylight={isDaylight}
                        isInteractive={isInteractive}
                        hasFloatingPlayer={Boolean(currentTrack)}
                        playlistVisibilityScope={hiddenScope}
                        directoryKey={directoryKey}
                        declaredHomeActions={declaredActions}
                    />
                ) : homeViewTab === 'local' ? (
                    <div className="w-full h-full flex-1">
                        <LocalGrid3DView
                            localSongs={localSongs}
                            localPlaylists={localPlaylists}
                            localLibraryCatalog={localLibraryCatalog}
                            activeRow={localMusicState.activeRow}
                            setActiveRow={(row) => setLocalMusicState(prev => ({ ...prev, activeRow: row }))}
                            focusedFolderIndex={localMusicState.focusedFolderIndex}
                            setFocusedFolderIndex={(index) => setLocalMusicState(prev => ({ ...prev, focusedFolderIndex: index }))}
                            focusedAlbumIndex={localMusicState.focusedAlbumIndex}
                            setFocusedAlbumIndex={(index) => setLocalMusicState(prev => ({ ...prev, focusedAlbumIndex: index }))}
                            focusedArtistIndex={localMusicState.focusedArtistIndex}
                            setFocusedArtistIndex={(index) => setLocalMusicState(prev => ({ ...prev, focusedArtistIndex: index }))}
                            focusedPlaylistIndex={localMusicState.focusedPlaylistIndex}
                            setFocusedPlaylistIndex={(index) => setLocalMusicState(prev => ({ ...prev, focusedPlaylistIndex: index }))}
                            homeActions={homeActions}
                            directoryTreesResource={homeResources.localDirectoryTrees}
                            directoryKey={directoryKey}
                            theme={theme}
                            isDaylight={isDaylight}
                            isInteractive={isInteractive}
                            hasFloatingPlayer={Boolean(currentTrack)}
                            onOpenGridView={onOpenGridView}
                            directoryActions={directoryActions}
                            declaredHomeActions={declaredActions}
                        />
                    </div>
                ) : (
                    <div className="w-full h-full flex-1">
                        <NavidromeGrid3DView
                            theme={theme}
                            isDaylight={isDaylight}
                            isInteractive={isInteractive}
                            focusedAlbumIndex={navidromeFocusedAlbumIndex}
                            setFocusedAlbumIndex={setNavidromeFocusedAlbumIndex ?? (() => { })}
                            hasFloatingPlayer={Boolean(currentTrack)}
                            homeActions={homeActions}
                            overview={homeResources.navidromeOverview}
                            directoryKey={directoryKey}
                            declaredHomeActions={declaredActions}
                            onOpenSettings={() => onOpenSettings?.('help')}
                            onOpenGridView={onOpenGridView}
                        />
                    </div>
                )}
            </div>

            {/* Login Modal */}
            <AnimatePresence>
                {showLoginModal && (
                    <OnlineProviderLoginModal
                        title={t((LOGIN_COPY_BY_PROVIDER[loginProviderId] || NETEASE_LOGIN_COPY).title)}
                        note={t((LOGIN_COPY_BY_PROVIDER[loginProviderId] || NETEASE_LOGIN_COPY).note)}
                        qrCodeImg={qrCodeImg}
                        statusText={qrStatusText}
                        state={qrState}
                        retryLabel={t('home.retryQr')}
                        closeLabel={t('home.closeLogin')}
                        loginMethods={loginMethodOptions.length > 0
                            ? {
                                title: t('home.qqLoginMethodTitle'),
                                hint: t('home.qqLoginMethodHint'),
                                pendingText: t('home.qqLoginMethodPending'),
                                currentText: selectedLoginMethodId
                                    ? t('home.qqLoginMethodCurrent', {
                                        method: t(loginMethodOptions.find(option => option.id === selectedLoginMethodId)?.labelKey || ''),
                                    })
                                    : '',
                                options: loginMethodOptions.map(option => ({
                                    id: option.id,
                                    label: t(option.labelKey),
                                    iconUrl: LOGIN_METHOD_ICONS[option.iconKey] || '',
                                })),
                                selectedId: selectedLoginMethodId,
                                onSelect: selectLoginMethod,
                            }
                            : undefined}
                        backendFailure={neteaseBackendFailed
                            ? {
                                title: t('home.loginBackendDown'),
                                detail: neteaseApiStatus?.error ?? null,
                                restartLabel: t('home.restartBackend'),
                                restartingLabel: t('home.restartingBackend'),
                                restarting: neteaseApiRestarting,
                                onRestart: () => void handleRestartNeteaseApi(),
                            }
                            : undefined}
                        diagnostics={qrLoginFailure
                            ? buildQrLoginDiagnosticsProps({
                                t,
                                providerId: loginProviderId,
                                failure: qrLoginFailure,
                                buildReport: buildQrDiagnosticReport,
                            })
                            : undefined}
                        // 刷新时保留已选的登录方式，否则用户会被踢回步骤一。
                        onRetry={() => void startQrLogin(loginProviderId, selectedLoginMethodId ?? undefined)}
                        onClose={() => {
                            setShowLoginModal(false);
                            stopQrLogin();
                        }}
                    />
                )}
            </AnimatePresence>

            {onlineProviderPlatform && (
                <OnlineProviderSwitcher
                    providers={onlineProviderPlatform.providers}
                    activeProviderId={activeProviderId}
                    isDaylight={isDaylight}
                    onBackToPlayer={onBackToPlayer}
                    onSelect={selectProvider}
                    onLogout={provider => {
                        void onlineProviderPlatform.logoutProvider(provider.providerId);
                    }}
                />
            )}

        </div>
    );
};

export default Grid3D;
