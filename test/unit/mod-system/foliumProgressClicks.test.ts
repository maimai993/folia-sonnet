// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FoliumProgressContext } from '@/mods/folium/contract';
import {
    controlButtonsRegistry,
    FoliumControlButtonSlot,
    FoliumProgressLayers,
    progressLayersRegistry,
} from '@/mods/folium/registries/progress';

// test/unit/mod-system/foliumProgressClicks.test.ts
// The floating capsule around the host progress bar opens the player on click.
// A click on a mod's button or marker must not reach it, even when the mod does
// not stop propagation itself.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctx = {} as FoliumProgressContext;

/* A mount that draws one clickable button and does not stop propagation. */
const buttonMount = (container: HTMLElement) => {
    const button = document.createElement('button');
    button.dataset.testid = 'mod-button';
    button.style.pointerEvents = 'auto';
    container.appendChild(button);
    return () => button.remove();
};

let root: Root | null = null;
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    controlButtonsRegistry.unregisterAll('mod-a');
    progressLayersRegistry.unregisterAll('mod-a');
    document.body.replaceChildren();
});

/* Renders `child` inside a clickable surface and clicks the mod's button. */
const clickModButton = (child: React.ReactElement) => {
    const onSurfaceClick = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(React.createElement('div', { onClick: onSurfaceClick }, child)));
    const button = Array.from(document.querySelectorAll('[data-folium-entry]'))
        .map((container) => (container.shadowRoot ?? container).querySelector<HTMLButtonElement>('[data-testid="mod-button"]'))
        .find(Boolean);
    expect(button).toBeTruthy();
    act(() => button!.click());
    return onSurfaceClick;
};

describe('clicks inside progress bar extensions', () => {
    it('do not reach the surface around a control button slot', () => {
        controlButtonsRegistry.register('mod-a', { id: 'plain', slot: 'progress.trailing', mount: buttonMount });
        const onSurfaceClick = clickModButton(React.createElement(FoliumControlButtonSlot, { slot: 'progress.trailing', ctx }));
        expect(onSurfaceClick).not.toHaveBeenCalled();
    });

    it('do not reach the surface around the progress layers', () => {
        progressLayersRegistry.register('mod-a', { id: 'plain', mount: buttonMount });
        const onSurfaceClick = clickModButton(React.createElement(FoliumProgressLayers, { ctx }));
        expect(onSurfaceClick).not.toHaveBeenCalled();
    });
});
