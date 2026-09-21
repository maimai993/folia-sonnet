import type { PonderTargetDefinition, PonderTargetId } from '../../types/ponder';

// src/components/ponder/ponderRegistry.ts
// 可教学目标的注册表。照 dev/probes/registry.ts 和 visualizer registry 的做法：
// 新增一个目标只要在 targets/ 下加一个 *.target.ts 并默认导出定义，这里不用改。
//
// eager 加载是有意的 —— 这些文件只有声明式数据，没有 animejs、没有组件，
// 不会把教程层那个懒加载 chunk 拖进 bootstrap。

const targetModules = import.meta.glob<{ default: PonderTargetDefinition }>(
    './targets/*.target.ts',
    { eager: true },
);

const buildRegistry = () => {
    const byId = {} as Record<PonderTargetId, PonderTargetDefinition>;
    for (const [path, module] of Object.entries(targetModules)) {
        if (!module.default) {
            throw new Error(`[PonderRegistry] Missing default export in ${path}`);
        }
        if (byId[module.default.id]) {
            throw new Error(`[PonderRegistry] Duplicate target id "${module.default.id}"`);
        }
        byId[module.default.id] = module.default;
    }
    return byId;
};

export const PONDER_TARGETS = buildRegistry();

export const PONDER_TARGET_LIST = Object.values(PONDER_TARGETS)
    .sort((a, b) => a.id.localeCompare(b.id));

export const findPonderTarget = (id: PonderTargetId): PonderTargetDefinition | null =>
    PONDER_TARGETS[id] ?? null;

/**
 * 指针底下那个元素属于哪个可教学目标。
 *
 * 一个元素可能同时落在多个目标的选择器里（槽位按钮既在控制条内、又是自己的目标），
 * 取命中最深的那个 —— 最具体的目标才是用户此刻真正指着的东西。
 */
export const resolveHoveredPonderTarget = (element: Element | null): PonderTargetDefinition | null => {
    if (!element) {
        return null;
    }

    let best: PonderTargetDefinition | null = null;
    let bestDepth = -1;

    for (const target of PONDER_TARGET_LIST) {
        if (!target.hoverSelector) {
            continue;
        }
        const matched = element.closest(target.hoverSelector);
        if (!matched) {
            continue;
        }
        let depth = 0;
        for (let node: Element | null = matched; node; node = node.parentElement) {
            depth += 1;
        }
        if (depth > bestDepth) {
            best = target;
            bestDepth = depth;
        }
    }

    return best;
};
