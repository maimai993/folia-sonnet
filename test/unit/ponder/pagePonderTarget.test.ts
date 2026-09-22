import { afterEach, describe, expect, it } from 'vitest';
import { openCurrentPagePonder, openSettingsFromPonder, resolvePagePonderTarget } from '@/services/ponder/pagePonderTarget';
import { useAppViewStore } from '@/stores/useAppViewStore';
import { usePonderStore } from '@/stores/usePonderStore';
import { useSettingsModalStore } from '@/stores/useSettingsModalStore';

// test/unit/ponder/pagePonderTarget.test.ts

describe('resolvePagePonderTarget', () => {
    afterEach(() => {
        useAppViewStore.setState({ view: 'home' });
        usePonderStore.getState().closePonder();
        usePonderStore.getState().closeNavigation();
        useSettingsModalStore.getState().setIsUserGuideModalOpen(false);
        useSettingsModalStore.getState().closeSettings();
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

    /**
     * 设置窗口是 z-[100]，整个应用里最低的一层浮层：教程层（220）和思索导航页（195）
     * 都压在它上面。从导航页进的那条路只关教程的话，设置会开在导航页底下 ——
     * 屏幕上什么都没变，读起来就是「这颗按钮没反应」。
     */
    it('「直接去那儿」会把教程层和导航页一起收掉，设置才不会开在它们底下', () => {
        const ponder = usePonderStore.getState();
        ponder.openNavigation();
        ponder.openPonder('ponder-basics');
        expect(usePonderStore.getState().isNavigationOpen).toBe(true);

        openSettingsFromPonder('labPonder');

        expect(usePonderStore.getState().session, '教程层没收掉').toBeNull();
        expect(usePonderStore.getState().isNavigationOpen, '导航页没收掉，设置会被它盖住').toBe(false);
        const settings = useSettingsModalStore.getState().settingsModalState;
        expect(settings.isOpen).toBe(true);
        // 而且要落在那一章讲的那个锚点上，不是设置面板的首页。
        expect(settings.initialAnchor?.id).toBe('labPonder');
    });
});
