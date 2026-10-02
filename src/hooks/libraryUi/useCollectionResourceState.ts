import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { CollectionResource, CollectionResourceSnapshot } from '../../types/libraryUi';
import { createSnapshotGate, type SnapshotGate } from '../../utils/libraryUi/snapshotGate';

// src/hooks/libraryUi/useCollectionResourceState.ts
// renderer 订阅资源快照。紧急更新直接 setState，后台更新（大歌单分页）放进 transition；
// holdBackground 为真时（网格拖拽中）后台更新先暂存，flushHeld 时再提交。
// 资源对象换了（例如本地曲目变化后的新静态资源）就在渲染期直接取新快照，不等 effect，避免闪一帧旧数据。

type MirroredState = {
    resource: CollectionResource | null;
    snapshot: CollectionResourceSnapshot | null;
};

export const useCollectionResourceState = (
    resource: CollectionResource | null,
    { holdBackground }: { holdBackground?: () => boolean } = {},
) => {
    const [state, setState] = useState<MirroredState>(() => ({ resource, snapshot: resource?.getSnapshot() ?? null }));
    let current = state;
    if (state.resource !== resource) {
        current = { resource, snapshot: resource?.getSnapshot() ?? null };
        setState(current);
    }

    const holdRef = useRef(holdBackground);
    holdRef.current = holdBackground;
    const gateRef = useRef<SnapshotGate<CollectionResourceSnapshot> | null>(null);

    useEffect(() => {
        if (!resource) return;
        const commit = (snapshot: CollectionResourceSnapshot) => setState(previous => (
            previous.resource === resource && previous.snapshot === snapshot ? previous : { resource, snapshot }
        ));
        const gate = createSnapshotGate<CollectionResourceSnapshot>({
            hold: () => holdRef.current?.() ?? false,
            apply: (snapshot, mode) => {
                if (mode === 'transition') startTransition(() => commit(snapshot));
                else commit(snapshot);
            },
        });
        gateRef.current = gate;
        const unsubscribe = resource.subscribe(() => gate.offer(resource.getSnapshot()));
        // 渲染与订阅之间可能已经有更新：订阅后补读一次。
        commit(resource.getSnapshot());
        return () => {
            unsubscribe();
            if (gateRef.current === gate) gateRef.current = null;
        };
    }, [resource]);

    const flushHeld = useCallback(() => gateRef.current?.flush(), []);

    return { snapshot: current.snapshot, flushHeld };
};
