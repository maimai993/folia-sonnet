import { useAppViewStore, type AppView } from '../../stores/useAppViewStore';
import { usePonderStore } from '../../stores/usePonderStore';
import { useSettingsModalStore } from '../../stores/useSettingsModalStore';
import type { PonderTargetId } from '../../types/ponder';

// src/utils/ponder/pagePonderTarget.ts

const PAGE_TARGET_BY_VIEW: Record<AppView, PonderTargetId> = {
    home: 'grid-page',
    player: 'player-page',
    lattice: 'lattice-page',
};

export const resolvePagePonderTarget = (view: AppView): PonderTargetId => PAGE_TARGET_BY_VIEW[view];

/** Opens Ponder for the active page and completes the non-dismissible shortcut lesson if present. */
export const openCurrentPagePonder = (): PonderTargetId => {
    const targetId = resolvePagePonderTarget(useAppViewStore.getState().view);
    const modal = useSettingsModalStore.getState();

    if (modal.isUserGuideModalOpen) {
        if (typeof __APP_VERSION__ !== 'undefined') {
            modal.setLastSeenGuideVersion(__APP_VERSION__);
        }
        modal.setIsUserGuideModalOpen(false);
    }

    usePonderStore.getState().openPonder(targetId);
    return targetId;
};
