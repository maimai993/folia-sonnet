import { create } from 'zustand';
import type React from 'react';
import { isNavidromeEnabled } from '../services/navidromeService';
import type { OnlineProviderId } from '../types/onlineMusic';

// src/stores/useLibraryStore.ts
// Library-side state: whether Navidrome is on, which of its songs are starred, and the two
// in-flight flags for switching online provider.
//
// `navidromeEnabled` had two independent owners before this — App.tsx and SettingsModal each kept
// their own useState and re-read isNavidromeEnabled() to stay in step. One flag, two copies, kept
// in sync by hand is exactly the shape that drifts; there is one now.

type ProviderSwitchPending = {
    nextProviderId: OnlineProviderId;
    resolve: (confirmed: boolean) => void;
} | null;

type LibraryState = {
    navidromeEnabled: boolean;
    starredNavidromeSongIds: Set<string>;
    isProviderSyncing: boolean;
    /** Held while the confirm dialog for a provider switch is open; resolves the caller's promise. */
    providerSwitchPending: ProviderSwitchPending;

    setNavidromeEnabledState: React.Dispatch<React.SetStateAction<boolean>>;
    setStarredNavidromeSongIds: React.Dispatch<React.SetStateAction<Set<string>>>;
    setIsProviderSyncing: React.Dispatch<React.SetStateAction<boolean>>;
    setProviderSwitchPending: React.Dispatch<React.SetStateAction<ProviderSwitchPending>>;
};

const resolveNext = <T,>(next: React.SetStateAction<T>, previous: T): T => (
    typeof next === 'function' ? (next as (prev: T) => T)(previous) : next
);

export const useLibraryStore = create<LibraryState>((set, get) => ({
    navidromeEnabled: isNavidromeEnabled(),
    starredNavidromeSongIds: new Set(),
    isProviderSyncing: false,
    providerSwitchPending: null,

    setNavidromeEnabledState: (next) => set({ navidromeEnabled: resolveNext(next, get().navidromeEnabled) }),
    setStarredNavidromeSongIds: (next) => set({ starredNavidromeSongIds: resolveNext(next, get().starredNavidromeSongIds) }),
    setIsProviderSyncing: (next) => set({ isProviderSyncing: resolveNext(next, get().isProviderSyncing) }),
    setProviderSwitchPending: (next) => set({ providerSwitchPending: resolveNext(next, get().providerSwitchPending) }),
}));

/** Stable module-level setters, for callers that should not have to be handed one. */
export const setNavidromeEnabledState: React.Dispatch<React.SetStateAction<boolean>> = (next) => (
    useLibraryStore.getState().setNavidromeEnabledState(next)
);
export const setStarredNavidromeSongIds: React.Dispatch<React.SetStateAction<Set<string>>> = (next) => (
    useLibraryStore.getState().setStarredNavidromeSongIds(next)
);
