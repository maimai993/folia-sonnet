import React, { useMemo } from 'react';
import FloatingPlayerControls from '../../FloatingPlayerControls';
import SearchWorkspace from '../search/SearchWorkspace';
import ListeningArchive from '../listeningArchive/ListeningArchive';
import LxWorkspace from '../../lxmusic/LxWorkspace';
import DevDebugOverlay from '../../DevDebugOverlay';
import MemoryMonitorWindow from '../../debug/MemoryMonitorWindow';
import NowPlayingToast from './NowPlayingToast';
import HifiSignalPathPanel from '../../hifi/HifiSignalPathPanel';
import type { AppOverlaysModel } from './buildAppOverlaysModel';
import { countRender } from '../../../dev/renderCount';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';
import { useLxWorkspaceStore } from '../../../stores/useLxWorkspaceStore';
import { useBottomDockStore } from '../../../stores/useBottomDockStore';
import { useBottomLayoutTracking } from '../../../hooks/useBottomLayoutTracking';
import { useNowPlayingCardLayoutStore } from './now-playing-toast/nowPlayingCardLayoutStore';
import { useTrackEndCountdownStore, withTrackEndCountdown } from './now-playing-toast/trackEndCountdownStore';
import { useTransitionBorderCue } from './now-playing-toast/useTransitionBorderCue';

// Centralized app-level overlay renderer so App.tsx does not mount leaf overlays directly.
type AppOverlaysProps = {
    model: AppOverlaysModel;
};

const AppOverlays: React.FC<AppOverlaysProps> = ({ model }) => {
    countRender('AppOverlays');
    const isCurrentSongPosterVisible = useLatticeControlsStore(state => state.isCurrentSongPosterVisible);
    const isLxWorkspaceOpen = useLxWorkspaceStore(state => state.isOpen);
    const closeLxWorkspace = useLxWorkspaceStore(state => state.close);
    // 主窗口按宽度在紧凑档和桌面档之间切换（progress-bar v3）。紧凑档里卡片收进胶囊左端，这里不再单独画它；
    // 拖卡片位置的时候例外（那是给宽屏用的位置，得让人看见卡片才能拖）。
    useBottomLayoutTracking();
    const isCompact = useBottomDockStore(state => state.layout === 'compact');
    const isPositioningCard = useNowPlayingCardLayoutStore(state => state.isPositioning);
    const {
        searchOverlay,
        listeningArchiveOverlay,
        lxWorkspace,
        debugOverlay,
        memoryMonitor,
        floatingControls,
        nowPlayingToast,
    } = model;

    /*
     * 播放头广播：每 250ms 把当前播放时间发到 window 上。
     *
     * 文字PV 的原版编辑台是全屏浮层，它有自己的进度条；不喂时间的话，
     * 它显示的位置和播放页永远是两个数。这里用动作值订阅而不是 React state，
     * 免得每秒 60 次把整棵浮层树重渲染一遍（浮层里还有播放条本身）。
     */
    React.useEffect(() => {
        const time = floatingControls?.currentTime;
        if (!time) return undefined;
        let lastSent = -1;
        const unsubscribe = time.on('change', (value: number) => {
            // 250ms 一档：编辑台的进度条不需要逐帧精度，逐帧发只会空转。
            if (Math.abs(value - lastSent) < 0.25) return;
            lastSent = value;
            window.dispatchEvent(new CustomEvent('kinetic:time', { detail: { time: value } }));
        });
        return () => unsubscribe();
    }, [floatingControls?.currentTime]);

    // 模型里的 isNextUp 只算混音。普通曲末的倒计时每首歌翻两次，放在 App 里每翻一次整棵重渲染一遍，
    // 所以在这里读，合进卡片和胶囊拿到的 props；没在倒计时就原样传下去。
    const isTrackEndCountdownActive = useTrackEndCountdownStore(state => state.active);
    const nowPlayingToastMerged = useMemo(
        () => withTrackEndCountdown(nowPlayingToast, isTrackEndCountdownActive),
        [nowPlayingToast, isTrackEndCountdownActive],
    );
    const floatingControlsMerged = useMemo(() => {
        const controls = floatingControls;
        const card = withTrackEndCountdown(controls?.card, isTrackEndCountdownActive);
        return controls && card !== controls.card ? { ...controls, card } : controls;
    }, [floatingControls, isTrackEndCountdownActive]);

    const showsCapsule = Boolean(floatingControlsMerged)
        && (floatingControlsMerged?.currentView !== 'lattice' || !isCurrentSongPosterVisible);
    // 紧凑档里卡片在胶囊左端；胶囊不在（播放页关掉了进度条、Lattice 上当前歌海报盖着）时卡片退回宽屏的样子，
    // 不能两边都不画。胶囊在但隐身了（播放页控件自动隐藏、纯歌词页）时，卡片必须在场的几种情况（常驻、
    // 预告下一首、混音描边）也退回宽屏的样子；限时显示的那次报幕不退，否则每次控件一隐藏卡片就重新弹一次。
    const transitionCue = useTransitionBorderCue();
    const cardMustStay = nowPlayingToastMerged !== null && nowPlayingToastMerged !== undefined
        && (nowPlayingToastMerged.mode === 'always' || nowPlayingToastMerged.isNextUp === true || transitionCue !== null);
    const capsuleCarriesCard = isCompact && showsCapsule && !floatingControlsMerged?.hideControlBar
        && !(floatingControlsMerged?.isHidden && cardMustStay);

    return (
        <>
            {searchOverlay && <SearchWorkspace {...searchOverlay} />}

            {listeningArchiveOverlay && <ListeningArchive {...listeningArchiveOverlay} />}

            {isLxWorkspaceOpen && lxWorkspace && <LxWorkspace {...lxWorkspace} onClose={closeLxWorkspace} />}

            {debugOverlay && <DevDebugOverlay {...debugOverlay} />}

            {memoryMonitor && <MemoryMonitorWindow {...memoryMonitor} />}

            {floatingControlsMerged && showsCapsule && <FloatingPlayerControls {...floatingControlsMerged} />}

            {nowPlayingToastMerged && (!capsuleCarriesCard || isPositioningCard) && <NowPlayingToast {...nowPlayingToastMerged} />}

            {/* The one HiFi signal-path sheet: the badge, the controls tab tile and the palette command open it through hifiPanelStore. */}
            <HifiSignalPathPanel />
        </>
    );
};

export default React.memo(AppOverlays);
