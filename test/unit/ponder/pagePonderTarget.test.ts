import { afterEach, describe, expect, it } from 'vitest';
import { openCurrentPagePonder, resolvePagePonderTarget } from '@/services/ponder/pagePonderTarget';
import { useAppViewStore } from '@/stores/useAppViewStore';
import { usePonderStore } from '@/stores/usePonderStore';
import { useSettingsModalStore } from '@/stores/useSettingsModalStore';

// test/unit/ponder/pagePonderTarget.test.ts

describe('resolvePagePonderTarget', () => {
    afterEach(() => {
        useAppViewStore.setState({ view: 'home' });
        usePonderStore.getState().closePonder();
        useSettingsModalStore.getState().setIsUserGuideModalOpen(false);
    });

    it.each([
        ['home', 'grid-page'],
        ['player', 'player-page'],
        ['lattice', 'lattice-page'],
    ] as const)('maps %s to its page-level target', (view, targetId) => {
        expect(resolvePagePonderTarget(view)).toBe(targetId);
    });

    it.each([
        'grid-view-page',
        'help-page',
        'settings-page',
    ] as const)('lets the visible %s scope override the underlying main view', targetId => {
        expect(resolvePagePonderTarget('home', targetId)).toBe(targetId);
    });

    it('ignores an unknown page scope', () => {
        expect(resolvePagePonderTarget('player', 'not-a-ponder-target')).toBe('player-page');
    });

    it('opens only the active page target and releases the onboarding gate', () => {
        useAppViewStore.setState({ view: 'lattice' });
        useSettingsModalStore.getState().setIsUserGuideModalOpen(true);

        expect(openCurrentPagePonder()).toBe('lattice-page');
        expect(usePonderStore.getState().session?.targetId).toBe('lattice-page');
        expect(useSettingsModalStore.getState().isUserGuideModalOpen).toBe(false);
    });
});
