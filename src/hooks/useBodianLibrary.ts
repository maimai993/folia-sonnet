import { useCallback, useEffect, useRef } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { clearProviderAccountSnapshot, saveProviderAccountSnapshot } from '../services/onlineMusic/providerAccountCache';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { OnlineProviderError } from '../types/onlineMusic';
import type { MediaId, ProviderCollection } from '../types/onlineMusic';

// src/hooks/useBodianLibrary.ts

export const useBodianLibrary = () => {
    const generation = useRef(0);
    const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
    const refresh = useCallback(async () => {
        const current = ++generation.current;
        const store = useOnlineProviderAccountStore.getState();
        try {
            if (!omni.getProviderAvailability('bodian').configured || !omni.getProviderCapabilities('bodian').auth) {
                store.clearAccount('bodian');
                await pendingSave.current.catch(() => {});
                await clearProviderAccountSnapshot('bodian');
                return false;
            }
            store.updateAccount('bodian', { freshness: 'refreshing', error: undefined });
            const user = await omni.getLoginStatus('bodian');
            if (generation.current !== current) return false;
            if (!user) {
                store.clearAccount('bodian');
                await clearProviderAccountSnapshot('bodian');
                return false;
            }
            const collections: ProviderCollection[] = [];
            const capabilities = omni.getProviderCapabilities('bodian');
            let offset = 0;
            if (capabilities.userLibrary) {
                while (true) {
                    const page = await omni.getProviderUserPlaylists('bodian', user.id, { offset, limit: 50 });
                    if (generation.current !== current) return false;
                    collections.push(...page.items);
                    if (!page.hasMore || page.nextOffset <= offset) break;
                    offset = page.nextOffset;
                }
            }
            const likedSongIds: MediaId[] = capabilities.likes ? await omni.getProviderLikedSongIds('bodian', user.id) : [];
            if (generation.current !== current) return false;
            const save = pendingSave.current.catch(() => {}).then(() => generation.current === current
                ? saveProviderAccountSnapshot('bodian', { user, collections, likedSongIds }) : null);
            pendingSave.current = save;
            const saved = await save;
            if (generation.current !== current) return false;
            if (!saved) return false;
            store.updateAccount('bodian', { status: 'authenticated', user, collections, likedSongIds,
                hydration: 'ready', freshness: 'fresh', lastUpdatedAt: saved.savedAt, error: undefined });
            return true;
        } catch (error) {
            if (generation.current !== current) return false;
            if (error instanceof OnlineProviderError && error.code === 'auth-required') {
                store.clearAccount('bodian', 'auth-required');
                await pendingSave.current.catch(() => {});
                await clearProviderAccountSnapshot('bodian');
            } else store.updateAccount('bodian', { hydration: 'ready', freshness: 'error',
                status: useOnlineProviderAccountStore.getState().accounts.bodian?.user ? 'authenticated' : 'error', error: 'bodian-refresh-failed' });
            return false;
        }
    }, []);
    const logout = useCallback(async () => {
        generation.current++;
        useOnlineProviderAccountStore.getState().clearAccount('bodian');
        await pendingSave.current.catch(() => {});
        await Promise.all([omni.logout('bodian'), clearProviderAccountSnapshot('bodian')]);
    }, []);
    useEffect(() => {
        // Historical snapshots have no verified identity binding; only a fresh session check may populate the account.
        useOnlineProviderAccountStore.getState().clearAccount('bodian');
        void refresh();
        return () => { generation.current++; };
    }, [refresh]);
    return { refresh, logout };
};
