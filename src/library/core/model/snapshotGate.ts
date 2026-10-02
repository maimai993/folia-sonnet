// src/library/core/model/snapshotGate.ts
// 资源快照交给 renderer 之前的那道门：紧急更新立即提交；后台更新（大歌单的分页）走 transition，
// 并且在 hold() 为真时（例如正在拖拽网格）先暂存，只保留最新的一份，等 flush() 再提交。
// 不用 useSyncExternalStore：外部 store 的更新总是同步渲染，包 startTransition 也无效。

export type GateSnapshot = { hint: 'urgent' | 'background' };
export type GateApplyMode = 'sync' | 'transition';

export type SnapshotGate<S extends GateSnapshot> = {
    /** 资源每次通知时调用。 */
    offer: (snapshot: S) => void;
    /** 放行暂存的后台更新（如果有）。 */
    flush: () => void;
    hasHeld: () => boolean;
};

export const createSnapshotGate = <S extends GateSnapshot>({
    hold,
    apply,
}: {
    hold: () => boolean;
    apply: (snapshot: S, mode: GateApplyMode) => void;
}): SnapshotGate<S> => {
    let held: S | null = null;

    return {
        offer: (snapshot) => {
            if (snapshot.hint === 'urgent') {
                // 紧急更新本身就是完整快照，暂存的旧页一并作废。
                held = null;
                apply(snapshot, 'sync');
                return;
            }
            if (hold()) {
                held = snapshot;
                return;
            }
            held = null;
            apply(snapshot, 'transition');
        },
        flush: () => {
            if (!held) return;
            const snapshot = held;
            held = null;
            apply(snapshot, 'transition');
        },
        hasHeld: () => held !== null,
    };
};
