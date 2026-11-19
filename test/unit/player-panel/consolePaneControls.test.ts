// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Toggle } from '@/components/ui';
import { Toggle as KitToggle } from '@/components/modal/settings/kit';

// test/unit/player-panel/consolePaneControls.test.ts
// AGENTS.md: outside the settings page, controls come from src/components/ui, not the settings kit. The
// four panes added by this PR take Toggle from ui; the kit's Toggle is a wrapper over the same control.

const PANES = ['MasteringPane', 'RepairPane', 'SpatialPane', 'StudioPane'];

describe('console panes use the shared ui controls', () => {
    it.each(PANES)('%s does not import Toggle from the settings kit', (pane) => {
        const source = readFileSync(`src/components/panelTab/console/${pane}.tsx`, 'utf8');
        expect(source).not.toMatch(/import\s*\{[^}]*\bToggle\b[^}]*\}\s*from\s*'[^']*modal\/settings\/kit'/);
        expect(source).toMatch(/import\s*\{[^}]*\bToggle\b[^}]*\}\s*from\s*'\.\.\/\.\.\/ui'/);
    });

    it.each(['MasteringPane', 'RepairPane', 'StudioPane'])('%s inert wrappers declare vertical spacing for sliders and negative-margin hints', (pane) => {
        const source = readFileSync(`src/components/panelTab/console/${pane}.tsx`, 'utf8');
        const inertDivs = [...source.matchAll(/<div[^>]*\binert=\{[^}]+\}[^>]*>/g)].map(m => m[0]);
        expect(inertDivs.length).toBeGreaterThan(0);
        for (const tag of inertDivs) {
            expect(tag).toMatch(/\bspace-y-3(?:\.5)?\b/);
        }
    });

    it('ui Toggle is a named switch that reports the flipped value and honours disabled', () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const place = document.body.appendChild(document.createElement('div'));
        const root = createRoot(place);
        const onChange = vi.fn();
        act(() => root.render(React.createElement(Toggle, { checked: false, onChange, label: 'gate' })));
        const sw = place.querySelector<HTMLButtonElement>('[role="switch"]')!;
        expect(sw.getAttribute('aria-label')).toBe('gate');
        expect(sw.getAttribute('aria-checked')).toBe('false');
        act(() => { sw.click(); });
        expect(onChange).toHaveBeenCalledWith(true);

        act(() => root.render(React.createElement(Toggle, { checked: true, onChange, label: 'gate', disabled: true })));
        act(() => { place.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(onChange).toHaveBeenCalledTimes(1);
        act(() => root.unmount());
        place.remove();
    });

    it('the settings kit Toggle renders the same control', () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        const place = document.body.appendChild(document.createElement('div'));
        const root = createRoot(place);
        const onChange = vi.fn();
        act(() => root.render(React.createElement(KitToggle, { checked: true, onChange, label: 'x' })));
        const sw = place.querySelector<HTMLButtonElement>('[role="switch"]')!;
        expect(sw.getAttribute('aria-checked')).toBe('true');
        expect(sw.className).toContain('w-12 h-6');
        act(() => { sw.click(); });
        expect(onChange).toHaveBeenCalledWith(false);
        act(() => root.unmount());
        place.remove();
    });
});
