import { create } from 'zustand';
import type React from 'react';
import type { PanelTab } from '../components/UnifiedPanel';

// src/stores/useAppViewStore.ts
// Which surface the app is showing, and the unified panel's own open/tab state.
//
// `view` was a useState inside useAppNavigation and reached ~25 places in App.tsx; the panel state
// was two more useStates in App.tsx handed down through the player-panel model. Both are read far
// from where they were declared, which is exactly what a store is for.
//
// The navigation *actions* deliberately stay in useAppNavigation: they drive window.history and
// carry refs, and nothing outside that hook should be able to move the view without going through
// them. This store is the readable truth about where the app is, not a second way to navigate.

export type AppView = 'home' | 'player';

type AppViewState = {
    view: AppView;
    isPanelOpen: boolean;
    panelTab: PanelTab;
    /** The home surface has finished animating out, so it can stop rendering entirely. */
    isHomeFullyHidden: boolean;

    /** Written only by useAppNavigation, which owns the history transitions. */
    setView: (view: AppView) => void;
    setIsPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setPanelTab: React.Dispatch<React.SetStateAction<PanelTab>>;
    setIsHomeFullyHidden: React.Dispatch<React.SetStateAction<boolean>>;
};

const resolve = <T,>(next: React.SetStateAction<T>, previous: T): T => (
    typeof next === 'function' ? (next as (prev: T) => T)(previous) : next
);

export const useAppViewStore = create<AppViewState>((set, get) => ({
    view: 'home',
    isPanelOpen: false,
    panelTab: 'cover',
    isHomeFullyHidden: false,

    setView: (view) => set({ view }),
    setIsPanelOpen: (next) => set({ isPanelOpen: resolve(next, get().isPanelOpen) }),
    setPanelTab: (next) => set({ panelTab: resolve(next, get().panelTab) }),
    setIsHomeFullyHidden: (next) => set({ isHomeFullyHidden: resolve(next, get().isHomeFullyHidden) }),
}));

// Module-level handles for the assembly layer: these are actions, so they need no subscription.
// Importing them where they are used keeps App.tsx out of the chain (see setStatusMessage).
export const setIsPanelOpen: AppViewState['setIsPanelOpen'] = (next) => useAppViewStore.getState().setIsPanelOpen(next);
export const setPanelTab: AppViewState['setPanelTab'] = (next) => useAppViewStore.getState().setPanelTab(next);
