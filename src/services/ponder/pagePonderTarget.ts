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
 * 入门教程。帮助页那颗灯泡按钮开的是它，第一次打开应用时那道门也指向它。
 *
 * 不走 openCurrentPagePonder：那个解析的是「此刻最上层的页面」，而从帮助页按下去时
 * 最上层是设置窗口 —— 用户要的是「Folia 怎么用」，不是「设置页有什么」。
 */
export const openOnboardingPonder = (): void => {
    useSettingsModalStore.getState().closeSettings();
    usePonderStore.getState().openPonder('help-page');
};

/** Opens Ponder for the foremost page and completes the non-dismissible shortcut lesson if present. */
export const openCurrentPagePonder = (): PonderTargetId => {
    const targetId = resolvePagePonderTarget(
        useAppViewStore.getState().view,
        readVisiblePagePonderScope(),
    );
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
