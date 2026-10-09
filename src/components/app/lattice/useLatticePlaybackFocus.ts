import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useStableCallbacks } from '../../../hooks/useStableCallbacks';
import { useLatticeControlsStore } from '../../../stores/useLatticeControlsStore';
import { useLatticeSettingsStore } from '../../../stores/useLatticeSettingsStore';
import type { SongResult } from '../../../types';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { layoutExpandedBlock, locateNearestInstance, type LatticeGeometry, type QueueInstance, type WallMetrics } from './layout';
import type { LatticeTile } from './latticeModel';

// Follows discrete song changes; per-frame camera movement stays inside useWallCameraPan.

export type ActiveLatticePoster = { instance: QueueInstance; tile: LatticeTile };

type PlaybackFocusOptions = {
    currentSong: SongResult | null;
    /** Held false until the wall has measured itself; centring needs the real viewport. */
    ready: boolean;
    tiles: LatticeTile[];
    /** 当前展开的那张卡。用来避免"换一张重复的海报重新展开"（见 focusCurrentSong）。 */
    activePoster: ActiveLatticePoster | null;
    /** 当前真正挂载着的卡的 id —— 已经展开的那张还在屏幕上才谈得上"别动它"。 */
    renderedInstanceIds: ReadonlySet<string>;
    geometry: LatticeGeometry;
    metrics: WallMetrics;
    getViewportCenter: () => { x: number; y: number };
    setActivePoster: Dispatch<SetStateAction<ActiveLatticePoster | null>>;
    setFocused: (instance: QueueInstance | null) => void;
    panTo: (rect: { x: number; y: number; width: number; height: number }, instant?: boolean) => void;
};

export const useLatticePlaybackFocus = ({
    currentSong,
    ready,
    tiles,
    activePoster,
    renderedInstanceIds,
    geometry,
    metrics,
    getViewportCenter,
    setActivePoster,
    setFocused,
    panTo,
}: PlaybackFocusOptions) => {
    const lastFocusedSongKeyRef = useRef<string | null>(null);
    const autoFocusOnSongChange = useLatticeSettingsStore(state => state.autoFocusOnSongChange);

    const currentSongKey = currentSong ? getPlaybackSongKey(currentSong) : null;
    // Permanent identity, dispatching to this render's closure. The wall publishes this action to
    // a store the palette subscribes to, so re-creating it on every queue or camera change would
    // write to that store — and re-render App, and with it the whole wall — for nothing.
    const { focusCurrentSong } = useStableCallbacks({ focusCurrentSong: (options?: { instant?: boolean }) => {
        if (!currentSongKey) return;
        /*
         * 已经在看着这首歌了就**什么都别做**。
         *
         * 同一首歌在墙上画了很多份（每个格子一份），跟随逻辑挑的是"离屏幕中心最近的
         * 那一份"，而用户点的往往是眼前这一份 —— 两者常常不是同一张卡。
         * 于是点一下会有两次展开：先展开用户点的那张，播放跟随紧接着把展开挪到另一张，
         * 两块 block 跟着一起重排 —— 用户看到的就是"点一下闪一下"。
         * 已经展开的正是这首歌、而且那张卡还在屏幕上时，直接收手。
         */
        if (activePoster
            && activePoster.tile.id === currentSongKey
            && renderedInstanceIds.has(activePoster.instance.instanceId)) {
            return;
        }
        const queueIndex = tiles.findIndex(tile => tile.id === currentSongKey);
        if (queueIndex < 0) return;
        // The song is drawn in every cell; jump to whichever copy is closest to what is on screen.
        const instance = locateNearestInstance(
            geometry,
            tiles.length,
            queueIndex,
            getViewportCenter(),
            metrics,
        );
        if (!instance) return;

        const tile = tiles[queueIndex];
        setFocused(instance);
        setActivePoster({ instance, tile });
        const expandedRect = layoutExpandedBlock(geometry, tiles.length, instance, metrics).get(instance.instanceId);
        if (expandedRect) panTo(expandedRect, options?.instant);
    } });

    useEffect(() => {
        if (!currentSongKey) {
            lastFocusedSongKeyRef.current = null;
            return;
        }
        if (!ready || lastFocusedSongKeyRef.current === currentSongKey || !tiles.some(tile => tile.id === currentSongKey)) return;
        // The wall opens already centred on what is playing; later song changes fly there.
        const isEntry = lastFocusedSongKeyRef.current === null;
        lastFocusedSongKeyRef.current = currentSongKey;
        // Consume the song change while following is disabled. Turning the setting back on should
        // not steal the viewport immediately; the next song change is the next follow opportunity.
        if (!autoFocusOnSongChange) return;
        focusCurrentSong({ instant: isEntry });
    }, [autoFocusOnSongChange, currentSongKey, focusCurrentSong, ready, tiles]);

    const canFocus = Boolean(currentSongKey && tiles.some(tile => tile.id === currentSongKey));
    useEffect(() => useLatticeControlsStore.getState().registerFocus(canFocus ? focusCurrentSong : null), [canFocus, focusCurrentSong]);

};
