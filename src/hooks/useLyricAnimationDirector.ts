import { useEffect } from 'react';
import { selectDisplayLyrics, selectDisplaySong, usePlaybackStore } from '../stores/usePlaybackStore';
import { startStagePlaybackCoordinator } from '../services/stagePlaybackCoordinator';
import { subscribeStageUpdates } from '../services/aiStage';
import { AI_SETTINGS_CHANGED_EVENT } from '../services/aiSettings';
import {
    abortLyricDirectorRequests,
    applyCurrentStageUpdate,
    notifyLyricDirectorLyricsLoaded,
    notifyLyricDirectorSongChanged,
    refreshDirectorAiStatus,
    scheduleLyricDirectorDecision,
} from '../services/lyricDirector/director';

// src/hooks/useLyricAnimationDirector.ts
// Wires the director to playback: a new track (or an automix handover) schedules
// a decision, and lyrics arriving cut the wait short.
//
// It reads the store with subscribe instead of taking props so the panel, the
// commands and this hook all see the same song: the display layer
// (selectDisplaySong) is the only place that knows what is actually on screen.

export const useLyricAnimationDirector = (): void => {
    useEffect(() => {
        refreshDirectorAiStatus();
        // Enabling the feature with a song already loaded is the common case, and
        // the subscription below only fires on a *change*.
        scheduleLyricDirectorDecision();
    }, []);

    useEffect(() => usePlaybackStore.subscribe((state, previous) => {
        if (selectDisplaySong(state) !== selectDisplaySong(previous)) {
            notifyLyricDirectorSongChanged();
            return;
        }
        if (selectDisplayLyrics(state) !== selectDisplayLyrics(previous)) {
            notifyLyricDirectorLyricsLoaded();
        }
    }), []);

    // Settings → AI is where the credential lives, and it can change under us.
    useEffect(() => {
        const onAiSettingsChanged = () => refreshDirectorAiStatus();
        window.addEventListener(AI_SETTINGS_CHANGED_EVENT, onAiSettingsChanged);
        return () => window.removeEventListener(AI_SETTINGS_CHANGED_EVENT, onAiSettingsChanged);
    }, []);

    useEffect(() => subscribeStageUpdates(applyCurrentStageUpdate), []);
    useEffect(() => startStagePlaybackCoordinator(), []);
    useEffect(() => () => abortLyricDirectorRequests(), []);
};
