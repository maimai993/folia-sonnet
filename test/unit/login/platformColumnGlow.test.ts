// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountSummary } from '@/types/onlineMusic';

// test/unit/login/platformColumnGlow.test.ts
// The highlight of the row of platforms is placed from a measurement of the row it is on. Those
// numbers must not go back through React state: measuring in a layout effect that runs after every
// render and writing them into state is a loop that never ends — a tablet drew itself black when
// the sign-in of one platform was picked there. The numbers are written on the block itself.
//
// jsdom lays nothing out, so the width of a row is mocked to a value that changes on every read:
// through state, one render after another would each measure a different width and ask for
// another render; this way the row is measured once and then left alone.

vi.mock('@/components/modal/settings/kit', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/login/PlatformMark', () => ({
    AccountPicture: () => React.createElement('i'),
    PlatformMark: () => React.createElement('i'),
    platformMarkOf: () => ({ color: '#ffffff', letter: 'x' }),
}));

import PlatformColumn from '@/components/login/window/PlatformColumn';

const row = (providerId: string): ProviderAccountSummary => ({
    providerId, shortName: providerId, displayName: providerId,
    availability: { configured: true }, status: 'anonymous', user: null, collections: [],
});

describe('the highlight of the row of platforms', () => {
    let root: Root;
    let place: HTMLElement;
    const draw = (element: React.ReactElement): void => act(() => root.render(element));

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        // jsdom has neither of the two.
        (globalThis as { CSS?: unknown }).CSS ??= { escape: (text: string) => text };
        Element.prototype.scrollIntoView ??= () => { };
        place = document.body.appendChild(document.createElement('div'));
        root = createRoot(place);
    });
    afterEach(() => {
        act(() => root.unmount());
        place.remove();
        vi.unstubAllGlobals();
    });

    it('is placed on the block itself, not through a render of its own', () => {
        const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
        let reads = 0;
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
            configurable: true,
            get() {
                // The stopper: measuring one's way through the render reads forever, and a loop
                // that never ends hangs the whole run instead of failing it.
                if ((reads += 1) > 200) throw new Error('the highlight measured its way through a render');
                return 120 + (reads % 2);
            },
        });
        try {
            draw(React.createElement(PlatformColumn, {
                rows: [row('a'), row('b'), row('c')], chosenId: 'a', onChoose: () => { }, lie: 'column',
            }));
            const list = place.querySelector<HTMLElement>('[role="listbox"]')!;
            const glow = list.firstElementChild as HTMLElement;
            // The lit row is the chosen one: the block has a size and sits on it.
            expect(glow.style.width).toMatch(/^12[01]px$/);
            expect(glow.style.height).toBe('0px');
            expect(glow.style.transform).toBe('translate(0px, 0px)');
            expect(glow.style.opacity).toBe('1');
            // Four numbers of the one row the highlight is on, read after the one render there was.
            expect(reads).toBeLessThanOrEqual(8);
        } finally {
            Object.defineProperty(HTMLElement.prototype, 'offsetWidth', real);
        }
    });
});
