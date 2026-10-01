// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/onlineProviderPlatform.test.ts
// The provider platform hook as the home view sees it while Folium mods add and remove sources at
// runtime: the list follows the registry, a source that goes away falls back to NetEase (and that is
// remembered), and the search overlay's online source follows whichever provider ends up active.

const storage = vi.hoisted(() => {
    // jsdom 环境下 node 自带的 localStorage 占位没有 getItem，store 初始化会直接抛。
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        value: {
            getItem: (key: string) => (entries.has(key) ? entries.get(key)! : null),
            setItem: (key: string, value: string) => { entries.set(key, String(value)); },
            removeItem: (key: string) => { entries.delete(key); },
            clear: () => { entries.clear(); },
            key: (index: number) => Array.from(entries.keys())[index] ?? null,
            get length() { return entries.size; },
        },
        configurable: true,
        writable: true,
    });
    return entries;
});

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOnlineProviderPlatform, type OnlineProviderPlatformState } from '@/hooks/useOnlineProviderPlatform';
import { registerOnlineMusicProvider, unregisterOnlineMusicProvider } from '@/services/onlineMusic/providerRegistry';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';
import { useSearchNavigationStore } from '@/stores/useSearchNavigationStore';
import type { OnlineMusicProvider } from '@/types/onlineMusic';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MOD_PROVIDER_ID = 'folium.mod-a.source';

// The shape a Folium mod source is adapted to: search and playback, no account.
const modProvider: OnlineMusicProvider = {
    id: MOD_PROVIDER_ID,
    displayName: 'Mod Source',
    shortName: 'Mod',
    capabilities: {
        search: true, playback: true, lyrics: true, auth: false, userLibrary: false,
        playlists: false, albums: false, artists: false, recommendations: false,
        mutations: false, wordByWordLyrics: false,
    },
    normalizeSong: () => ({
        id: '1',
        name: 'Song',
        artists: [],
        album: { id: '', name: '' },
        durationMs: 1,
        sourceRef: { kind: 'online', providerId: MOD_PROVIDER_ID, mediaId: '1' },
    }),
};

const refreshers = {};
let platform: OnlineProviderPlatformState | null = null;
let root: Root | null = null;

const Probe = () => {
    platform = useOnlineProviderPlatform(refreshers);
    return null;
};

const mount = () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement(Probe)));
};

beforeEach(() => {
    useOnlineProviderAccountStore.getState().setActiveProviderId('netease');
    useSearchNavigationStore.setState({ searchSourceTab: 'netease' });
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    platform = null;
    unregisterOnlineMusicProvider(MOD_PROVIDER_ID);
    document.body.replaceChildren();
});

describe('online provider platform with Folium mod sources', () => {
    it('lists a provider registered after the home view mounted', () => {
        mount();
        expect(platform!.providers.some(provider => provider.providerId === MOD_PROVIDER_ID)).toBe(false);

        act(() => registerOnlineMusicProvider(modProvider));

        expect(platform!.providers.find(provider => provider.providerId === MOD_PROVIDER_ID))
            .toMatchObject({ shortName: 'Mod', requiresAccount: false });
    });

    it('switches to a mod source and points the search overlay at it', async () => {
        registerOnlineMusicProvider(modProvider);
        mount();

        await act(async () => {
            await expect(platform!.switchProvider(MOD_PROVIDER_ID)).resolves.toBe(true);
        });

        expect(platform!.activeProviderId).toBe(MOD_PROVIDER_ID);
        expect(useSearchNavigationStore.getState().searchSourceTab).toBe(MOD_PROVIDER_ID);
    });

    it('follows an active provider set without a switch, as after a restart or session restore', () => {
        registerOnlineMusicProvider(modProvider);
        mount();

        act(() => useOnlineProviderAccountStore.getState().setActiveProviderId(MOD_PROVIDER_ID));

        expect(useSearchNavigationStore.getState().searchSourceTab).toBe(MOD_PROVIDER_ID);
    });

    it('falls back to NetEase and remembers it when the active mod source goes away', () => {
        registerOnlineMusicProvider(modProvider);
        useOnlineProviderAccountStore.getState().setActiveProviderId(MOD_PROVIDER_ID);
        mount();
        expect(platform!.activeProviderId).toBe(MOD_PROVIDER_ID);

        act(() => unregisterOnlineMusicProvider(MOD_PROVIDER_ID));

        expect(platform!.activeProviderId).toBe('netease');
        expect(platform!.providers.some(provider => provider.providerId === MOD_PROVIDER_ID)).toBe(false);
        expect(storage.get('active_online_provider_id')).toBe('netease');
        expect(useSearchNavigationStore.getState().searchSourceTab).toBe('netease');
    });
});
