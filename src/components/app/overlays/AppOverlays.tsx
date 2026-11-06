import React from 'react';
import FloatingPlayerControls from '../../FloatingPlayerControls';
import SearchWorkspace from '../search/SearchWorkspace';
import ListeningArchive from '../listeningArchive/ListeningArchive';
import LxWorkspace from '../../lxmusic/LxWorkspace';
import DevDebugOverlay from '../../DevDebugOverlay';
import MemoryMonitorWindow from '../../debug/MemoryMonitorWindow';
import NowPlayingToast from './NowPlayingToast';
import type { AppOverlaysModel } from './buildAppOverlaysModel';
import { countRender } from '../../../dev/renderCount';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';
import { useLxWorkspaceStore } from '../../../stores/useLxWorkspaceStore';

// Centralized app-level overlay renderer so App.tsx does not mount leaf overlays directly.
type AppOverlaysProps = {
    model: AppOverlaysModel;
};

const AppOverlays: React.FC<AppOverlaysProps> = ({ model }) => {
    countRender('AppOverlays');
    const isCurrentSongPosterVisible = useLatticeControlsStore(state => state.isCurrentSongPosterVisible);
    const isLxWorkspaceOpen = useLxWorkspaceStore(state => state.isOpen);
    const closeLxWorkspace = useLxWorkspaceStore(state => state.close);
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

    /*
     * 把「播放器的 seek / 播放暂停 / 音量」暴露成全局事件。
     *
     * 为什么要有这一条：文字PV 的原版编辑台是全屏浮层，它挂在设置面板那一层，
     * 拿不到播放器的 seek 与 currentTime（那些都是 App.tsx 内部的 ref）。
     * 编辑台需要「拖它的进度条 → 播放器跟着跳」「在里面按播放 → 播放器跟着动」，
     * 唯一不必改动整条 ref 链的办法就是在这里把控制能力挂到 window 上。
     *
     * 事件名带 kinetic 前缀，说明它只服务于这个样式，不会被别处误用。
     */
    // 回调放进 ref：监听器只注册一次，但要始终调到最新的实现。
    const controlsRef = React.useRef(floatingControls);
    controlsRef.current = floatingControls;

    React.useEffect(() => {
        const handleSeek = (event: Event) => {
            const time = (event as CustomEvent<{ time?: number }>).detail?.time;
            const controls = controlsRef.current;
            if (!controls || typeof time !== 'number' || !Number.isFinite(time)) return;
            console.log('[Kinetic] 编辑台请求跳转，交给播放器', { time });
            controls.onSeek(Math.max(0, time));
        };
        const handleToggle = (event: Event) => {
            const wanted = (event as CustomEvent<{ playing?: boolean }>).detail?.playing;
            const controls = controlsRef.current;
            if (!controls || typeof wanted !== 'boolean') {
                console.warn('[Kinetic] 播放控制当前不可用，忽略切换请求', {
                    hasControls: Boolean(controls),
                    wanted,
                });
                return;
            }
            // onTogglePlay 是「切换」语义：只有目标状态与当前不同才发一次。
            const currentlyPlaying = controls.playerState === 'PLAYING';
            if (wanted !== currentlyPlaying) {
                console.log('[Kinetic] 编辑台请求切换播放状态', { from: currentlyPlaying, to: wanted });
                controls.onTogglePlay();
            }
        };

        window.addEventListener('kinetic:seek', handleSeek);
        window.addEventListener('kinetic:toggle-play', handleToggle);
        return () => {
            window.removeEventListener('kinetic:seek', handleSeek);
            window.removeEventListener('kinetic:toggle-play', handleToggle);
        };
    }, []);

    return (
        <>
            {searchOverlay && <SearchWorkspace {...searchOverlay} />}

            {listeningArchiveOverlay && <ListeningArchive {...listeningArchiveOverlay} />}

            {/* 洛雪工作台：入口在登录页（选洛雪音源那一行），播放器回调只有这一层拿得到。 */}
            {isLxWorkspaceOpen && lxWorkspace && <LxWorkspace {...lxWorkspace} onClose={closeLxWorkspace} />}

            {debugOverlay && <DevDebugOverlay {...debugOverlay} />}

            {memoryMonitor && <MemoryMonitorWindow {...memoryMonitor} />}

            {floatingControls
                && (floatingControls.currentView !== 'lattice' || !isCurrentSongPosterVisible)
                && <FloatingPlayerControls {...floatingControls} />}

            {nowPlayingToast && <NowPlayingToast {...nowPlayingToast} />}
        </>
    );
};

export default React.memo(AppOverlays);
