import type { ProviderAccountSummary } from '../../../types/onlineMusic';

// src/components/app/home/onlineProviderAccountView.ts

/** `accountless`: a provider with no account at all (a Folium mod source), so no library to show either. */
export type OnlineProviderAccountView = 'resolving' | 'guest' | 'authenticated' | 'accountless';

const isAccountless = (provider: ProviderAccountSummary | undefined) => provider?.requiresAccount === false;

// Keeps an unresolved account distinct from a confirmed anonymous session during startup hydration.
// An accountless provider never gets an account entry, so its status stays 'unknown' for good; it is
// settled first, before that would read as an account still resolving.
export const resolveOnlineProviderAccountView = ({
    provider,
    hasUser,
    platformAvailable,
}: {
    provider?: ProviderAccountSummary;
    hasUser: boolean;
    platformAvailable: boolean;
}): OnlineProviderAccountView => {
    if (isAccountless(provider)) return 'accountless';
    if (hasUser) return 'authenticated';
    if (platformAvailable && (provider?.hydration === 'loading' || provider?.status === 'unknown')) return 'resolving';
    return 'guest';
};

/** Whether picking the provider switches to it now (signed in, or nothing to sign in to) rather than starting a login. */
export const canSwitchToProviderDirectly = (provider: ProviderAccountSummary): boolean => (
    provider.status === 'authenticated' || isAccountless(provider)
);
