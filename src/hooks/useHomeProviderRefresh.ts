import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { OnlineProviderId } from '../types/onlineMusic';
import type { OnlineProviderPlatformState } from './useOnlineProviderPlatform';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { useCollectionNavigationStore } from '../stores/useCollectionNavigationStore';
import { useAppViewStore } from '../stores/useAppViewStore';
import { setStatusMessage } from '../stores/useStatusMessageStore';

// src/hooks/useHomeProviderRefresh.ts
//
// Refreshes the active online provider's playlists when the listener lands on the home surface.
//
// Not on an interval and not on mount: home is where those lists are read, so entering it is the
// moment they are worth fetching. The cooldown and the in-flight check keep bouncing between home
// and a collection from re-fetching each time.

/** Long enough that home ↔ player ↔ collection bouncing does not re-fetch, short enough to feel live. */
const HOME_PROVIDER_REFRESH_COOLDOWN_MS = 5_000;

type HomeProviderRefreshParams = {
    onlineProviderPlatform: OnlineProviderPlatformState;
    refreshActiveProviderPlaylists: () => Promise<unknown>;
    /** Kugou is the one provider whose failure can mean an expired login worth telling the user about. */
    checkKugouLoginStatus: () => Promise<unknown>;
};

export const useHomeProviderRefresh = ({
    onlineProviderPlatform,
    refreshActiveProviderPlaylists,
    checkKugouLoginStatus,
}: HomeProviderRefreshParams) => {
    const { t } = useTranslation();
    const currentView = useAppViewStore(state => state.view);
    // A collection is open on top of home, so the lists behind it are not what is being looked at.
    const hasCollection = useCollectionNavigationStore(state => Boolean(state.snapshot?.stack.length));
    const lastHomeProviderRefreshRef = useRef<{ providerId: OnlineProviderId; at: number } | null>(null);

    useEffect(() => {
        if (currentView !== 'home' || hasCollection) return;

        const providerId = onlineProviderPlatform.activeProviderId;
        const startedAt = Date.now();
        const previous = lastHomeProviderRefreshRef.current;
        if (previous?.providerId === providerId && startedAt - previous.at <= HOME_PROVIDER_REFRESH_COOLDOWN_MS) return;
        if (onlineProviderPlatform.activeProvider?.freshness === 'refreshing') {
            lastHomeProviderRefreshRef.current = { providerId, at: startedAt };
            return;
        }

        lastHomeProviderRefreshRef.current = { providerId, at: startedAt };
        void refreshActiveProviderPlaylists().catch(async error => {
            if (lastHomeProviderRefreshRef.current?.providerId === providerId
                && lastHomeProviderRefreshRef.current.at === startedAt) {
                lastHomeProviderRefreshRef.current = null;
            }
            console.warn('[Omni] Failed to refresh active provider playlists on home entry', {
                providerId,
                name: error instanceof Error ? error.name : 'Error',
            });
            const account = useOnlineProviderAccountStore.getState().accounts[providerId];
            if (providerId !== 'kugou' || !account?.user) return;

            const user = await checkKugouLoginStatus();
            const refreshedAccount = useOnlineProviderAccountStore.getState().accounts.kugou;
            if (!user && refreshedAccount?.error === 'auth-required') {
                setStatusMessage({ type: 'error', text: t('status.loginExpired') });
            }
        });
    }, [
        checkKugouLoginStatus,
        currentView,
        hasCollection,
        onlineProviderPlatform.activeProvider?.freshness,
        onlineProviderPlatform.activeProviderId,
        refreshActiveProviderPlaylists,
        t,
    ]);
};
