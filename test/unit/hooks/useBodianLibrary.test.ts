import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBodianLibrary } from '@/hooks/useBodianLibrary';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';

// test/unit/hooks/useBodianLibrary.test.ts

const mocks = vi.hoisted(() => ({
    effects: [] as Array<() => unknown>,
    getProviderAvailability: vi.fn(),
    getProviderCapabilities: vi.fn(),
    getLoginStatus: vi.fn(),
    loadProviderAccountSnapshot: vi.fn(),
    clearProviderAccountSnapshot: vi.fn(),
    saveProviderAccountSnapshot: vi.fn(),
}));
vi.mock('react', () => ({
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => { mocks.effects.push(effect); },
}));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: mocks }));
vi.mock('@/services/onlineMusic/providerAccountCache', () => mocks);

describe('Bodian account identity restoration', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.effects.length = 0;
        mocks.getProviderAvailability.mockReturnValue({ configured: true });
        mocks.getProviderCapabilities.mockReturnValue({ auth: false });
        mocks.clearProviderAccountSnapshot.mockResolvedValue(undefined);
        mocks.loadProviderAccountSnapshot.mockResolvedValue({ user: { id: 'unverified', nickname: 'Old account' } });
        useOnlineProviderAccountStore.setState({ accounts: {} });
        useOnlineProviderAccountStore.getState().updateAccount('bodian', {
            status: 'authenticated', user: { id: 'unverified', nickname: 'Old account' },
            likedSongIds: ['old-song'], collections: [{ providerId: 'bodian', id: 'old-list', name: 'Old list', type: 'playlist' }],
        });
    });

    it('clears the visible account synchronously on mount without loading a historical snapshot', async () => {
        useBodianLibrary();
        mocks.effects[0]();
        expect(useOnlineProviderAccountStore.getState().accounts.bodian).toMatchObject({
            status: 'anonymous', user: null, collections: [], likedSongIds: [],
        });
        await vi.waitFor(() => expect(mocks.clearProviderAccountSnapshot).toHaveBeenCalledWith('bodian'));
        expect(mocks.loadProviderAccountSnapshot).not.toHaveBeenCalled();
        expect(mocks.getLoginStatus).not.toHaveBeenCalled();
    });

    it.each([true, false])('does not authenticate when disabled (configured=%s), even if cache deletion fails', async configured => {
        mocks.getProviderAvailability.mockReturnValue({ configured });
        mocks.clearProviderAccountSnapshot.mockRejectedValue(new Error('storage unavailable'));
        const { refresh } = useBodianLibrary();
        await expect(refresh()).resolves.toBe(false);
        expect(useOnlineProviderAccountStore.getState().accounts.bodian).toMatchObject({
            user: null, collections: [], likedSongIds: [], freshness: 'error',
        });
        expect(useOnlineProviderAccountStore.getState().accounts.bodian.status).not.toBe('authenticated');
        expect(mocks.getLoginStatus).not.toHaveBeenCalled();
        expect(mocks.saveProviderAccountSnapshot).not.toHaveBeenCalled();
    });

    it('keeps old identity hidden while a new status check is pending or fails', async () => {
        mocks.getProviderCapabilities.mockReturnValue({ auth: true });
        let rejectStatus!: (error: Error) => void;
        mocks.getLoginStatus.mockReturnValue(new Promise((_resolve, reject) => { rejectStatus = reject; }));
        useBodianLibrary();
        mocks.effects[0]();
        expect(useOnlineProviderAccountStore.getState().accounts.bodian.user).toBeNull();
        expect(mocks.loadProviderAccountSnapshot).not.toHaveBeenCalled();
        rejectStatus(new Error('network failure'));
        await vi.waitFor(() => expect(useOnlineProviderAccountStore.getState().accounts.bodian.freshness).toBe('error'));
        expect(useOnlineProviderAccountStore.getState().accounts.bodian).toMatchObject({
            status: 'error', user: null, collections: [], likedSongIds: [],
        });
    });
});
