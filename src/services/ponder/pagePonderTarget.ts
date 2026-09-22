import { useAppViewStore, type AppView } from '../../stores/useAppViewStore';
import { usePonderStore } from '../../stores/usePonderStore';
import { useSettingsModalStore } from '../../stores/useSettingsModalStore';
import type { PonderTargetId } from '../../types/ponder';

// src/services/ponder/pagePonderTarget.ts

const PAGE_TARGET_BY_VIEW: Record<AppView, PonderTargetId> = {
    home: 'grid-page',
    player: 'player-page',
    lattice: 'lattice-page',
};

const PAGE_SCOPE_TARGETS = new Set<PonderTargetId>([
    'grid-page',
    'grid-view-page',
    'player-page',
    'lattice-page',
    'help-page',
    'settings-page',
]);

export const resolvePagePonderTarget = (
    view: AppView,
    visibleScopeTargetId?: string | null,
): PonderTargetId => (
    visibleScopeTargetId && PAGE_SCOPE_TARGETS.has(visibleScopeTargetId as PonderTargetId)
        ? visibleScopeTargetId as PonderTargetId
        : PAGE_TARGET_BY_VIEW[view]
);

/** Returns the topmost mounted, visible page scope. Later overlays win over their underlying page. */
export const readVisiblePagePonderScope = (): PonderTargetId | null => {
    if (typeof document === 'undefined') {
        return null;
    }

    const scopes = Array.from(document.querySelectorAll<HTMLElement>('[data-ponder-page-scope]'));
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
        const element = scopes[index];
        const targetId = element.dataset.ponderPageScope;
        if (!targetId || !PAGE_SCOPE_TARGETS.has(targetId as PonderTargetId)) continue;

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) {
            return targetId as PonderTargetId;
        }
    }

    return null;
};

/**
 * 思索导航页。帮助页那颗灯泡按钮开的是它。
 *
 * 不直接开教程：总览只有一章，剩下的几十条各自独立，用户要的是「挑一条」而不是
 * 「从头看一遍」。导航页上按 Ctrl+G 才是总览 —— 那一屏声明了 help-page 作为页面 scope。
 */
export const openPonderNavigation = (): void => {
    useSettingsModalStore.getState().closeSettings();
    usePonderStore.getState().openNavigation();
};

/** Opens Ponder for the foremost page and completes the non-dismissible shortcut lesson if present. */
export const openCurrentPagePonder = (): PonderTargetId => {
    const modal = useSettingsModalStore.getState();
    // 第一次那道门是压在首页上的，按页面 scope 解析出来的是海报墙 —— 而它要教的是
    // 「Folia 大致怎么转」。这一条比页面 scope 优先。
    const targetId = modal.isUserGuideModalOpen
        ? 'help-page'
        : resolvePagePonderTarget(
            useAppViewStore.getState().view,
            readVisiblePagePonderScope(),
        );

    if (modal.isUserGuideModalOpen) {
        if (typeof __APP_VERSION__ !== 'undefined') {
            modal.setLastSeenGuideVersion(__APP_VERSION__);
        }
        modal.setIsUserGuideModalOpen(false);
    }

    usePonderStore.getState().openPonder(targetId);
    return targetId;
};
