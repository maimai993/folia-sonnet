import { describe, expect, it } from 'vitest';
import {
    resolveStoredFocusIndex,
    shouldApplyInitialGridFocus,
} from '@/components/folia-grid/gridViewRestore';
import type { GridItem } from '@/components/folia-grid/polaroidCardParts';

// test/unit/folia-grid/gridViewRestore.test.ts
// 网格相机的两条规则：恢复时聚焦到哪张卡，以及初始定位什么时候才允许发生。

const item = (id: string | number): GridItem => ({ rawTrack: { id } } as unknown as GridItem);

describe('resolveStoredFocusIndex', () => {
    it('resolves by track id first, because indices drift between sessions', () => {
        expect(resolveStoredFocusIndex({ focusedIndex: 0, focusedTrackId: 'b' }, [item('a'), item('b'), item('c')])).toBe(1);
    });

    it('falls back to the stored index and clamps it into the list', () => {
        expect(resolveStoredFocusIndex({ focusedIndex: 9 }, [item('a'), item('b')])).toBe(1);
        expect(resolveStoredFocusIndex({ focusedIndex: -4 }, [item('a'), item('b')])).toBe(0);
    });

    it('returns -1 when there is nothing to resolve', () => {
        expect(resolveStoredFocusIndex(null, [item('a')])).toBe(-1);
        expect(resolveStoredFocusIndex({ focusedIndex: 0 }, [])).toBe(-1);
    });
});

describe('shouldApplyInitialGridFocus', () => {
    const fresh = {
        itemCount: 12,
        hasAppliedInitialFocus: false,
        restoreApplied: false,
        restorePending: false,
    };

    it('positions the camera on a brand-new grid', () => {
        expect(shouldApplyInitialGridFocus(fresh)).toBe(true);
    });

    // 这条就是回归点：歌手页的专辑列表分页追加，length 变化时 effect 会再跑一次。
    // 不加「已经定位过」这道闸，用户点开某张卡之后相机会被拽回介绍卡。
    it('never re-positions after the first time, however the list grows', () => {
        expect(shouldApplyInitialGridFocus({ ...fresh, hasAppliedInitialFocus: true })).toBe(false);
    });

    it('leaves a restored session alone', () => {
        expect(shouldApplyInitialGridFocus({ ...fresh, restoreApplied: true })).toBe(false);
    });

    it('waits while a restore is pending', () => {
        expect(shouldApplyInitialGridFocus({ ...fresh, restorePending: true })).toBe(false);
    });

    it('does nothing while the grid is still empty', () => {
        expect(shouldApplyInitialGridFocus({ ...fresh, itemCount: 0 })).toBe(false);
    });
});
