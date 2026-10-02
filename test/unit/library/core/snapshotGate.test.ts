import { describe, expect, it } from 'vitest';
import { createSnapshotGate, type GateApplyMode } from '@/library/core/model/snapshotGate';
import { resolveReloadCapability, resolveScopeCapability } from '@/library/core/model/collectionCapabilities';

// test/unit/library/core/snapshotGate.test.ts
// 快照门：紧急更新立即提交，后台更新走 transition；拖拽中暂存最新的一份，放手再提交。
// 能力判定：重新拉取只给能分页的在线集合；空范围要说明是在加载还是确实没有。

type Snap = { id: number; hint: 'urgent' | 'background' };

const gateWith = (holding: { value: boolean }) => {
    const applied: Array<[number, GateApplyMode]> = [];
    const gate = createSnapshotGate<Snap>({
        hold: () => holding.value,
        apply: (snapshot, mode) => applied.push([snapshot.id, mode]),
    });
    return { gate, applied };
};

describe('snapshot gate', () => {
    it('applies urgent updates synchronously and background ones as transitions', () => {
        const { gate, applied } = gateWith({ value: false });
        gate.offer({ id: 1, hint: 'urgent' });
        gate.offer({ id: 2, hint: 'background' });
        expect(applied).toEqual([[1, 'sync'], [2, 'transition']]);
    });

    it('holds only the latest background update while holding, and releases it on flush', () => {
        const holding = { value: true };
        const { gate, applied } = gateWith(holding);
        gate.offer({ id: 1, hint: 'background' });
        gate.offer({ id: 2, hint: 'background' });
        expect(applied).toEqual([]);
        expect(gate.hasHeld()).toBe(true);

        holding.value = false;
        gate.flush();
        gate.flush();
        expect(applied).toEqual([[2, 'transition']]);
    });

    it('lets an urgent update through while holding and drops the held page', () => {
        const { gate, applied } = gateWith({ value: true });
        gate.offer({ id: 1, hint: 'background' });
        gate.offer({ id: 2, hint: 'urgent' });
        gate.flush();
        expect(applied).toEqual([[2, 'sync']]);
    });
});

describe('collection capabilities', () => {
    it('offers reload only for pageable online collections, disabled while loading', () => {
        expect(resolveReloadCapability({ kind: 'online', status: 'ready', collectionType: 'playlist' }))
            .toEqual({ supported: true, enabled: true, pending: false });
        expect(resolveReloadCapability({ kind: 'online', status: 'loading', collectionType: 'playlist' }))
            .toEqual({ supported: true, enabled: false, pending: true, reason: 'loading' });
        for (const input of [
            { kind: 'online' as const, collectionType: 'daily_recommendations' },
            { kind: 'online' as const, collectionType: 'radio' },
            { kind: 'navidrome' as const, collectionType: 'album' },
            { kind: 'static' as const, collectionType: 'folder' },
        ]) {
            expect(resolveReloadCapability({ ...input, status: 'ready' }).supported).toBe(false);
        }
    });

    it('tells an empty scope apart from one that is still loading', () => {
        expect(resolveScopeCapability({ scopeCount: 3, status: 'loading' }).enabled).toBe(true);
        expect(resolveScopeCapability({ scopeCount: 0, status: 'idle' })).toMatchObject({ enabled: false, reason: 'loading' });
        expect(resolveScopeCapability({ scopeCount: 0, status: 'ready' })).toMatchObject({ enabled: false, reason: 'empty' });
    });
});
