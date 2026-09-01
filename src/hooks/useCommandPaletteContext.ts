import { useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { CommandPaletteContext } from '../components/command-palette/types';
import {
    buildNavigationCommandContext,
    buildPanelCommandContext,
    buildPlaybackCommandContext,
    buildSharedCommandContext,
    type NavigationCommandContextDeps,
    type PanelCommandContextDeps,
    type PlaybackCommandContextDeps,
    type SharedCommandContextDeps,
} from '../components/app/command-palette-context/buildAppOwnedCommandContext';
import { buildSearchCommandContext, type SearchCommandContextDeps } from '../components/app/command-palette-context/buildSearchCommandContext';
import { buildSettingsCommandContext, type SettingsCommandContextDeps } from '../components/app/command-palette-context/buildSettingsCommandContext';
import { buildVisualizerCommandContext } from '../components/app/command-palette-context/buildVisualizerCommandContext';
import { useAudioSettingsStore } from '../stores/useAudioSettingsStore';
import { useAutomixSettingsStore } from '../stores/useAutomixSettingsStore';
import { useDesktopSettingsStore } from '../stores/useDesktopSettingsStore';
import { useLyricSettingsStore } from '../stores/useLyricSettingsStore';
import { usePersonalFmModeStore } from '../stores/usePersonalFmModeStore';
import { usePlayerChromeSettingsStore } from '../stores/usePlayerChromeSettingsStore';
import { useSleepTimerStore } from '../stores/useSleepTimerStore';
import { useTypographySettingsStore } from '../stores/useTypographySettingsStore';
import { useVisualizerSettingsStore } from '../stores/useVisualizerSettingsStore';

// src/hooks/useCommandPaletteContext.ts
// Assembles the command palette's namespaced context.
//
// This replaces a 218-line useMemo in App.tsx that took 106 hand-written parameters. The
// namespaces whose state lives in a store now read it here; only what genuinely still lives in
// App.tsx is passed in.
//
// The store *values* are subscribed to (not just read via getState) so the context is rebuilt when
// one of them changes — commands' `isAvailable` reads a snapshot, so a stale context would grey the
// wrong entries. The subscriptions are deliberately narrow: only fields the palette actually shows
// or gates on, not whole stores.

export type CommandPaletteContextDeps =
    SharedCommandContextDeps
    & SearchCommandContextDeps
    & PlaybackCommandContextDeps
    & NavigationCommandContextDeps
    & PanelCommandContextDeps
    & SettingsCommandContextDeps;

export const useCommandPaletteContext = (deps: CommandPaletteContextDeps): CommandPaletteContext => {
    // Narrow subscriptions: these are the store fields the palette displays or gates on.
    const settingsSignals = useTypographySettingsStore(useShallow(state => ({
        subtitleContentMode: state.subtitleContentMode,
    })));
    const chromeSignals = usePlayerChromeSettingsStore(useShallow(state => ({
        transparentPlayerBackground: state.transparentPlayerBackground,
    })));
    const desktopSignals = useDesktopSettingsStore(useShallow(state => ({
        modSystemEnabled: state.modSystemEnabled,
        wallpaperMode: state.wallpaperMode,
    })));
    const automixSignals = useAutomixSettingsStore(useShallow(state => ({
        automixEnabled: state.automixEnabled,
        transitionMode: state.transitionMode,
        transitionPerformance: state.transitionPerformance,
    })));
    const sleepTimerSignals = useSleepTimerStore(useShallow(state => ({
        sleepTimerEnabled: state.sleepTimerEnabled,
        sleepTimerHours: state.sleepTimerHours,
        sleepTimerMinutes: state.sleepTimerMinutes,
        sleepTimerDeadlineMs: state.sleepTimerDeadlineMs,
    })));
    const audioSignals = useAudioSettingsStore(useShallow(state => ({
        volume: state.volume,
        isMuted: state.isMuted,
    })));
    const visualizerSignals = useVisualizerSettingsStore(useShallow(state => ({
        visualizerMode: state.visualizerMode,
        visualizerBackgroundMode: state.visualizerBackgroundMode,
        randomVisualizerModePerSong: state.randomVisualizerModePerSong,
    })));
    const lyricStaffPolicy = useLyricSettingsStore(state => state.lyricStaffPolicy);
    const personalFmSelection = usePersonalFmModeStore(state => state.selection);

    // App.tsx recreates several of these callbacks on every render (handleSaveLyricFilterPattern
    // is not memoised, and the toggles close over it), so keying the memo on `deps` identity would
    // rebuild the context every render — and with it useCommandPalette's 120-command availability
    // filter. Callbacks are therefore reached through a latest-ref, which is safe because commands
    // invoke them at execute time, never during render; only the *values* drive re-memoisation.
    const depsRef = useRef(deps);
    depsRef.current = deps;

    const stableCallbacks = useMemo(() => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(depsRef.current)) {
            if (typeof (depsRef.current as Record<string, unknown>)[key] === 'function') {
                out[key] = (...args: unknown[]) => (
                    (depsRef.current as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args)
                );
            }
        }
        return out;
    }, []);

    const valueDeps = Object.entries(deps)
        .filter(([, value]) => typeof value !== 'function')
        .map(([, value]) => value);

    return useMemo(() => {
        const stableDeps = { ...deps, ...stableCallbacks } as CommandPaletteContextDeps;
        return {
            shared: buildSharedCommandContext(stableDeps),
            search: buildSearchCommandContext(stableDeps),
            playback: buildPlaybackCommandContext(stableDeps),
            navigation: buildNavigationCommandContext(stableDeps),
            panel: buildPanelCommandContext(stableDeps),
            settings: buildSettingsCommandContext(stableDeps),
            visualizer: buildVisualizerCommandContext(),
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value list is derived, shape is fixed
    }, [
        ...valueDeps,
        settingsSignals, chromeSignals, desktopSignals, automixSignals,
        sleepTimerSignals, audioSignals, visualizerSignals,
        lyricStaffPolicy, personalFmSelection,
    ]);
};
