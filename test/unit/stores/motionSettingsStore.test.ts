import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MOTION_SURFACE_IDS,
    readReducedMotion,
    resolveReducedMotion,
    useMotionSettingsStore,
} from '@/stores/useMotionSettingsStore';

// test/unit/stores/motionSettingsStore.test.ts
// issue #370 的回归点：系统的动画偏好本身不再降级任何东西，只有用户显式选择才会。
// 这条一旦松掉，Windows 关掉「动画效果」的用户又会拿到一个没有任何解释的瞬移界面。

const fullMotion = {
    reducedMotionSurfaces: Object.fromEntries(
        MOTION_SURFACE_IDS.map(surface => [surface, false]),
    ) as Record<(typeof MOTION_SURFACE_IDS)[number], boolean>,
    followSystemReducedMotion: false,
    systemPrefersReducedMotion: false,
};

describe('motion settings store', () => {
    let values: Map<string, string>;

    beforeEach(() => {
        values = new Map();
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        };
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', { localStorage: storage });
        useMotionSettingsStore.setState({ ...fullMotion });
    });

    afterEach(() => {
        useMotionSettingsStore.setState({ ...fullMotion });
        vi.unstubAllGlobals();
    });

    it('defaults every surface to full motion', () => {
        const state = useMotionSettingsStore.getState();
        expect(state.followSystemReducedMotion).toBe(false);
        MOTION_SURFACE_IDS.forEach(surface => {
            expect(resolveReducedMotion(state, surface)).toBe(false);
        });
    });

    it('ignores the system preference until the listener opts into following it', () => {
        useMotionSettingsStore.setState({ systemPrefersReducedMotion: true });
        expect(readReducedMotion('lattice')).toBe(false);

        useMotionSettingsStore.getState().handleToggleFollowSystemReducedMotion(true);
        expect(readReducedMotion('lattice')).toBe(true);
    });

    it('reduces only the surface that was switched off', () => {
        useMotionSettingsStore.getState().handleToggleReducedMotionSurface('lattice', true);

        expect(readReducedMotion('lattice')).toBe(true);
        expect(readReducedMotion('monetBackground')).toBe(false);
        expect(readReducedMotion('settingsScroll')).toBe(false);
    });

    it('persists each surface under its own key', () => {
        useMotionSettingsStore.getState().handleToggleReducedMotionSurface('transitionOverlay', true);
        expect(localStorage.getItem('reduce_motion_transitionOverlay')).toBe('true');

        useMotionSettingsStore.getState().handleToggleReducedMotionSurface('transitionOverlay', false);
        expect(localStorage.getItem('reduce_motion_transitionOverlay')).toBe('false');
    });

    it('writes every surface at once when all of them are set together', () => {
        useMotionSettingsStore.getState().handleSetAllReducedMotionSurfaces(true);

        MOTION_SURFACE_IDS.forEach(surface => {
            expect(readReducedMotion(surface)).toBe(true);
            expect(localStorage.getItem(`reduce_motion_${surface}`)).toBe('true');
        });
    });

    it('keeps a surface reduced when the system preference is also on', () => {
        useMotionSettingsStore.getState().handleToggleReducedMotionSurface('lattice', true);
        useMotionSettingsStore.setState({ followSystemReducedMotion: true, systemPrefersReducedMotion: true });
        expect(readReducedMotion('lattice')).toBe(true);

        // 关掉跟随系统不应该把这一面自己的选择也一起关掉。
        useMotionSettingsStore.getState().handleToggleFollowSystemReducedMotion(false);
        expect(readReducedMotion('lattice')).toBe(true);
        expect(readReducedMotion('uiMicroMotion')).toBe(false);
    });
});
