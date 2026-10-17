import { usePlaybackStore } from '../stores/usePlaybackStore';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { currentTime } from '../stores/motionSignals';
import { PlayerState, type SongResult } from '../types';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../utils/appPlaybackGuards';
import { resolvePlaybackNeighbors } from '../utils/playbackNeighbors';
import { requestStage, setProtectedStageKeys } from './aiStage';
import { normalizeStageIdentity } from './stageCache/identity';
import { resolveStageCloudNamespace } from './stageCache/cloud';
import { AI_SETTINGS_CHANGED_EVENT } from './aiSettings';
import { useAutomixSettingsStore } from '../stores/useAutomixSettingsStore';
import { planForMode } from './automix/transitionStrategy';
import { getTrackProfile } from './automix/profileService';
import { omni } from './onlineMusic/omni';
import { getPrefetchedData } from './prefetchService';
import { readDirectorSettings, subscribeDirectorState } from './lyricDirector/state';
import { readStoredThemeAutoGenerateEnabled } from './themePreferences';
import { directorLyricLinesOf, directorSongInfoOf } from './lyricDirector/director';

// src/services/stagePlaybackCoordinator.ts
// Playback subscriptions only: continuous position never enters React state.
export const STAGE_NEXT_LEAD_SECONDS = 45;
const CACHE_WINDOW_SIZE = 10;
const CACHE_CONCURRENCY = 2;

/** Follow the queue controller's committed order; a future reshuffle has no known target yet. */
export function upcomingStageSongs(
    state: ReturnType<typeof usePlaybackStore.getState>,
    loopMode: ReturnType<typeof useAudioSettingsStore.getState>['loopMode'],
): SongResult[] {
    if (!state.currentSong || loopMode === 'one') return [];
    const seen = new Set([getPlaybackSongKey(state.currentSong)]);
    const result: SongResult[] = [];
    let currentSong = state.currentSong;
    while (result.length < CACHE_WINDOW_SIZE) {
        const { next } = resolvePlaybackNeighbors({
            playQueue: state.playQueue, currentSong, loopMode,
            isFmMode: state.isFmMode, isStageActive: getPlaybackSourceRef(state.currentSong).kind === 'stage',
        });
        if (!next.key || seen.has(next.key)) break;
        const song = state.playQueue.find(entry => getPlaybackSongKey(entry) === next.key);
        if (!song) break;
        result.push(song);
        seen.add(next.key);
        currentSong = song;
    }
    return result;
}

/** Own and dispose every subscription and request for this mounted playback consumer. */
export function startStagePlaybackCoordinator(): () => void {
    let disposed = false;
    let revision = 0;
    let windowKey = '';
    let songs: SongResult[] = [];
    let controllers = new Set<AbortController>();
    let nextController: AbortController | null = null;
    let submittedNext = '';
    let lastProgressSecond = -1;
    const enabled = () => {
        const settings = readDirectorSettings();
        return settings.prefetchNext && settings.rememberPerSong
            && (settings.autoOnSongChange || readStoredThemeAutoGenerateEnabled());
    };
    const request = (song: SongResult, controller: AbortController, cacheOnly: boolean, isCurrent: () => boolean, lines = directorLyricLinesOf(null)) => requestStage({
        song: directorSongInfoOf(song), songTitle: song.name, lines,
        isPureMusic: Boolean(song.isPureMusic), priority: 'next', cacheOnly,
        publicEligible: song.onlineLyricsState?.lyricsSource !== 'imported' && !song.onlineLyricsState?.hasOnlineOverride,
        signal: controller.signal, isCurrent, require: 'both',
        hint: readDirectorSettings().userHint, blockedModes: readDirectorSettings().blockedModes,
    });
    const checkProgress = () => {
        const position = currentTime.get();
        if (disposed || Math.floor(position) === lastProgressSecond) return;
        lastProgressSecond = Math.floor(position);
        const state = usePlaybackStore.getState();
        if (!enabled() || state.playerState !== PlayerState.PLAYING
            || state.transitionDisplay || state.duration <= 0 || !songs[0]) return;
        const song = songs[0];
        const mix = useAutomixSettingsStore.getState();
        let switchAt = state.duration;
        if (mix.automixEnabled && state.currentSong) {
            const plan = planForMode({ mode: mix.transitionMode, crossfadeMaxSec: mix.crossfadeMaxSec, performance: mix.transitionPerformance },
                { duration: state.duration, lines: state.lyrics?.lines ?? null, profile: getTrackProfile(state.currentSong) },
                { duration: song.durationMs / 1000, lines: getPrefetchedData(song)?.lyrics?.lines ?? null, profile: getTrackProfile(song) });
            if (plan.kind === 'fade') switchAt = plan.outStart;
        }
        if (switchAt - position > STAGE_NEXT_LEAD_SECONDS) return;
        const key = `${revision}:${getPlaybackSongKey(song)}`;
        if (submittedNext === key) return;
        submittedNext = key;
        nextController?.abort();
        const controller = new AbortController();
        nextController = controller;
        const isCurrent = () => !disposed && !controller.signal.aborted && submittedNext === key && enabled();
        void (async () => {
            try {
                // Recheck cache before obtaining lyrics or making a generation candidate.
                await request(song, controller, true, isCurrent);
            } catch (error) {
                if ((error as Error)?.name !== 'StageCacheMissError' || !isCurrent()) return;
                try {
                    const prefetched = getPrefetchedData(song);
                    const lyrics = prefetched?.lyrics ?? (song.isPureMusic ? null : (await omni.getLyrics(song)).lyrics);
                    if (!isCurrent()) return;
                    await request(song, controller, false, isCurrent, directorLyricLinesOf(lyrics));
                } catch { /* A failed background candidate must not interrupt playback. */ }
            }
        })();
    };
    const refresh = () => {
        const state = usePlaybackStore.getState();
        const loopMode = useAudioSettingsStore.getState().loopMode;
        const protectedSongs = [state.currentSong, state.transitionDisplay?.song].filter((song): song is SongResult => Boolean(song));
        const upcoming = enabled() ? upcomingStageSongs(state, loopMode) : [];
        setProtectedStageKeys(new Set([...protectedSongs, ...upcoming].flatMap(song => {
            const info = directorSongInfoOf(song);
            const identity = info && normalizeStageIdentity(info);
            return identity ? [identity.key] : [];
        })));
        lastProgressSecond = -1;
        const key = JSON.stringify([resolveStageCloudNamespace(), state.currentSong ? getPlaybackSongKey(state.currentSong) : null, loopMode, upcoming.map(getPlaybackSongKey)]);
        if (key !== windowKey) {
            windowKey = key;
            revision += 1;
            const epoch = revision;
            controllers.forEach(controller => controller.abort());
            controllers = new Set();
            nextController?.abort();
            submittedNext = '';
            songs = upcoming;
            let cursor = 0;
            const worker = async () => {
                while (!disposed && revision === epoch && cursor < upcoming.length) {
                    const song = upcoming[cursor++];
                    const controller = new AbortController();
                    controllers.add(controller);
                    try {
                        await request(song, controller, true, () => !disposed && revision === epoch && enabled());
                    } catch { /* Cache misses and network failures never become generation here. */ }
                    finally { controllers.delete(controller); }
                }
            };
            for (let index = 0; index < CACHE_CONCURRENCY; index += 1) void worker();
        }
        checkProgress();
    };
    const offPlayback = usePlaybackStore.subscribe((state, previous) => {
        if (state.currentSong !== previous.currentSong || state.playQueue !== previous.playQueue
            || state.isFmMode !== previous.isFmMode || state.playerState !== previous.playerState
            || state.duration !== previous.duration || state.transitionDisplay !== previous.transitionDisplay) refresh();
    });
    const offSettings = useAudioSettingsStore.subscribe((state, previous) => {
        if (state.loopMode !== previous.loopMode) refresh();
    });
    const offTime = currentTime.on('change', checkProgress);
    const offDirector = subscribeDirectorState(refresh);
    const offMix = useAutomixSettingsStore.subscribe(refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener(AI_SETTINGS_CHANGED_EVENT, refresh);
    // HTML media timeupdate remains the existing background clock source on Android.
    document.addEventListener('timeupdate', checkProgress, true);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener('focus', refresh);
    refresh();
    return () => {
        disposed = true;
        controllers.forEach(controller => controller.abort());
        nextController?.abort();
        setProtectedStageKeys(new Set());
        offPlayback(); offSettings(); offTime(); offDirector(); offMix();
        window.removeEventListener('storage', refresh);
        window.removeEventListener(AI_SETTINGS_CHANGED_EVENT, refresh);
        document.removeEventListener('timeupdate', checkProgress, true);
        document.removeEventListener('visibilitychange', refresh);
        window.removeEventListener('pageshow', refresh);
        window.removeEventListener('focus', refresh);
    };
}
