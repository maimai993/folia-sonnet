import { describe, expect, it } from 'vitest';
import {
    resolveGridMapDisplayIndex,
    resolveGridMapEscapeAction,
    resolveGridMapSourceIndex,
    shouldSuppressGridMapSelection,
} from '@/components/folia-grid/gridMapNavigation';

// test/unit/folia-grid/gridMapNavigation.test.ts
// Tests GridMap collection index resolution, drag selection suppression, and multi-layer Escape navigation.

describe('resolveGridMapEscapeAction', () => {
    it('prioritizes clearing an active search query first', () => {
        expect(resolveGridMapEscapeAction({
            searchQuery: 'ambient',
            showSidePanel: true,
            showCutInPanel: true,
            isPlaylistEditMode: true,
        })).toBe('clear-search');
    });

    it('ignores whitespace-only queries and continues to dismiss panels', () => {
        expect(resolveGridMapEscapeAction({
            searchQuery: '   ',
            showSidePanel: true,
            showCutInPanel: false,
            isPlaylistEditMode: false,
        })).toBe('close-side-panel');
    });

    it('closes the side drawer before closing cut-in or navigating back', () => {
        expect(resolveGridMapEscapeAction({
            searchQuery: '',
            showSidePanel: true,
            showCutInPanel: true,
            isPlaylistEditMode: false,
        })).toBe('close-side-panel');
    });

    it('closes the cut-in panel before navigating back', () => {
        expect(resolveGridMapEscapeAction({
            searchQuery: '',
            showSidePanel: false,
            showCutInPanel: true,
            isPlaylistEditMode: false,
        })).toBe('close-cut-in-panel');
    });

    it('exits playlist edit mode if active without cut-in panel', () => {
        expect(resolveGridMapEscapeAction({
            searchQuery: '',
            showSidePanel: false,
            showCutInPanel: false,
            isPlaylistEditMode: true,
        })).toBe('exit-playlist-edit');
    });

    it('navigates back when no nested modal or filter state is active', () => {
        expect(resolveGridMapEscapeAction({
            searchQuery: '',
            showSidePanel: false,
            showCutInPanel: false,
            isPlaylistEditMode: false,
        })).toBe('navigate-back');
    });
});

describe('shouldSuppressGridMapSelection', () => {
    it('allows selection clicks within the drag threshold', () => {
        expect(shouldSuppressGridMapSelection(2, 3)).toBe(false);
    });

    it('suppresses selection when drag displacement exceeds the threshold', () => {
        expect(shouldSuppressGridMapSelection(6, 6)).toBe(true);
    });
});

describe('resolveGridMapSourceIndex', () => {
    const items = [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }];

    it('resolves by identity when the object matches directly', () => {
        expect(resolveGridMapSourceIndex(items, items[1], 0)).toBe(1);
    });

    it('resolves by id when identity differs after list reconstruction', () => {
        expect(resolveGridMapSourceIndex(items, { id: 'gamma' }, 0)).toBe(2);
    });

    it('falls back to clamped index when item is not in source', () => {
        expect(resolveGridMapSourceIndex(items, { id: 'unknown' }, 5)).toBe(2);
        expect(resolveGridMapSourceIndex(items, { id: 'unknown' }, -2)).toBe(0);
    });
});

describe('resolveGridMapDisplayIndex', () => {
    const items = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];

    it('resolves the display index by object identity', () => {
        expect(resolveGridMapDisplayIndex(items, items[2])).toBe(2);
    });

    it('resolves the display index by id', () => {
        expect(resolveGridMapDisplayIndex(items, { id: 'y' })).toBe(1);
    });

    it('defaults to 0 when source item is missing or not found', () => {
        expect(resolveGridMapDisplayIndex(items, undefined)).toBe(0);
        expect(resolveGridMapDisplayIndex(items, { id: 'not-there' })).toBe(0);
    });
});
