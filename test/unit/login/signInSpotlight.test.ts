// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountSummary } from '@/types/onlineMusic';

// test/unit/login/signInSpotlight.test.ts
// The last step of the first launch: the sign-in button is brought to the face, and the only way
// past it is to press it. Two things are held to here — pressing it opens the window and settles
// the step, and nothing else gets you out (Escape, the Android back key it becomes, the backdrop).
// Nothing is laid out or timed in jsdom: the button has no `animate`, so the flight is skipped.

const opened = vi.hoisted(() => ({ windows: [] as (Element | null | undefined)[] }));

vi.mock('@/components/modal/settings/kit/motion', () => ({
    KIT_EASE: { out: [0, 0, 0, 1], standard: [0, 0, 0, 1], inOut: [0, 0, 0, 1] },
    KIT_MOTION: { fast: 0.12, move: 0.22, unfold: 0.3, show: 0.48 },
    kitMotionTokens: () => ({}),
    useKitReducedMotion: () => false,
}));
vi.mock('@/components/modal/settings/kit/kitTheme', () => ({
    settingsTokens: () => ({}),
    useSettingsKitTheme: () => ({ isDaylight: true, theme: undefined }),
}));
vi.mock('@/components/login/PlatformMark', () => ({
    PlatformMark: () => React.createElement('i', { 'data-picture': 'mark' }),
}));
vi.mock('@/library/core/account/useLibraryAccount', () => ({
    useLibraryAccountProviders: () => ({ providers: [row('a')], activeProviderId: 'a' }),
}));
vi.mock('@/components/login/loginWindowStore', () => ({
    openLoginWindow: (providerId: string | null, pressed?: Element | null) => {
        opened.windows.push(pressed);
    },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import SignInSpotlight from '@/components/login/SignInSpotlight';

const row = (providerId: string): ProviderAccountSummary => ({
    providerId, shortName: providerId, displayName: providerId,
    availability: { configured: true }, status: 'anonymous', user: null, collections: [],
});

describe('the sign-in button brought to the face', () => {
    let root: Root;
    let place: HTMLElement;
    let pressed: number;
    const draw = (isOpen: boolean): void => act(() => root.render(React.createElement(SignInSpotlight, {
        isOpen, account: {} as never, onPressed: () => { pressed += 1; },
    })));
    const dialog = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="dialog"]');
    const button = (): HTMLButtonElement => document.body.querySelector<HTMLElement>('[role="dialog"]')!.querySelector('button')!;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        place = document.body.appendChild(document.createElement('div'));
        root = createRoot(place);
        pressed = 0;
        opened.windows.length = 0;
    });
    afterEach(() => {
        act(() => root.unmount());
        place.remove();
    });

    it('opens the window and settles the step when the button is pressed, and only then', () => {
        draw(true);
        act(() => button().click());
        expect(pressed).toBe(1);
        // It hands the window the button it flew in from, so the two agree on where it happened.
        expect(opened.windows).toHaveLength(1);
        expect(opened.windows[0]).toBe(button());
    });

    it('lets nothing else through: not Escape, not the back key it becomes, not the backdrop', () => {
        draw(true);
        // The Android back key arrives as an Escape on the window (useNativeBackButton): it must be
        // swallowed here, or it walks out of the app instead of staying on this one thing to do.
        const back = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        act(() => { window.dispatchEvent(back); });
        expect(back.defaultPrevented).toBe(true);
        act(() => button().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        act(() => dialog()!.click());
        expect(pressed).toBe(0);
        expect(opened.windows).toEqual([]);
        expect(dialog()).not.toBeNull();
    });

    it('is not there once it is not the step', () => {
        draw(false);
        expect(dialog()).toBeNull();
    });
});
