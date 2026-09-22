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

    it('opens the active page target', () => {
        useAppViewStore.setState({ view: 'lattice' });

        expect(openCurrentPagePonder()).toBe('lattice-page');
        expect(usePonderStore.getState().session?.targetId).toBe('lattice-page');
    });

    /**
     * 第一次那道门压在首页上，按页面 scope 解析出来的是海报墙 —— 而它要教的是
     * 「Folia 大致怎么转」。所以这一条必须压过页面 scope。
     */
    it('第一次那道门开的是总览，不是底下那一页', () => {
        useAppViewStore.setState({ view: 'lattice' });
        useSettingsModalStore.getState().setIsUserGuideModalOpen(true);

        expect(openCurrentPagePonder()).toBe('help-page');
        expect(usePonderStore.getState().session?.targetId).toBe('help-page');
        expect(useSettingsModalStore.getState().isUserGuideModalOpen).toBe(false);
    });
});
