import type { LibraryCollectionDescriptor } from '../contracts/collection';
import type { CollectionResource } from '../contracts/resource';

// src/library/core/services/collectionResourceRegistry.ts
// 资源的生命周期：谁在用、什么时候停、什么时候可以复用。
//
// - peekOrCreate 在渲染期调用，只创建对象、不发请求（请求由 ensure 触发）；
// - retain 在 effect 里调用并返回释放函数。StrictMode 会同步地「挂载 → 卸载 → 挂载」，
//   所以释放后先等一个宽限期，期间重新 retain 就什么都不发生，不会重复请求；
// - 只被 peek、一直没被 retain 的实例（渲染被丢弃）过一段时间后销毁；
// - 最后一个使用者离开后资源先暂停；能复用的在线资源放进一个有界的 LRU，其余直接销毁。
//   复用与否由资源自己判断（版本相同、缓存本来就会命中、已加载完或中断），
//   所以复用不会绕过原先「重进时按曲目更新时间校验缓存」的规则。

export type CollectionResourceRegistryOptions = {
    releaseGraceMs?: number;
    orphanGraceMs?: number;
    maxRetained?: number;
};

type LiveEntry = {
    resource: CollectionResource;
    refs: number;
    releaseTimer?: ReturnType<typeof setTimeout>;
    orphanTimer?: ReturnType<typeof setTimeout>;
};

export type CollectionResourceRegistry = {
    peekOrCreate: (
        key: string,
        descriptor: LibraryCollectionDescriptor,
        create: () => CollectionResource,
    ) => CollectionResource;
    /** 返回释放函数（重复调用无害）；资源已被销毁时返回 null，调用方应重新 peek。 */
    retain: (resource: CollectionResource) => (() => void) | null;
    /** 测试与诊断用：当前在用的资源数与 LRU 里的资源数。 */
    size: () => { live: number; retained: number };
};

export const createCollectionResourceRegistry = ({
    releaseGraceMs = 0,
    orphanGraceMs = 5000,
    maxRetained = 3,
}: CollectionResourceRegistryOptions = {}): CollectionResourceRegistry => {
    const live = new Map<string, LiveEntry>();
    const retained = new Map<string, CollectionResource>();

    const clearTimers = (entry: LiveEntry) => {
        if (entry.releaseTimer) clearTimeout(entry.releaseTimer);
        if (entry.orphanTimer) clearTimeout(entry.orphanTimer);
        entry.releaseTimer = undefined;
        entry.orphanTimer = undefined;
    };

    // 最后一个使用者走了：暂停，在线资源进 LRU，超出上限的最旧那个销毁。
    const settle = (key: string, entry: LiveEntry) => {
        if (live.get(key) !== entry || entry.refs > 0) return;
        clearTimers(entry);
        live.delete(key);
        entry.resource.pause();
        if (entry.resource.kind !== 'online') {
            entry.resource.dispose();
            return;
        }
        retained.delete(key);
        retained.set(key, entry.resource);
        while (retained.size > maxRetained) {
            const [oldestKey, oldest] = retained.entries().next().value as [string, CollectionResource];
            retained.delete(oldestKey);
            oldest.dispose();
        }
    };

    const watchOrphan = (key: string, entry: LiveEntry) => {
        entry.orphanTimer = setTimeout(() => settle(key, entry), orphanGraceMs);
    };

    return {
        peekOrCreate: (key, descriptor, create) => {
            const current = live.get(key);
            if (current) return current.resource;

            const kept = retained.get(key);
            if (kept) {
                retained.delete(key);
                if (kept.canReuse(descriptor)) {
                    const entry: LiveEntry = { resource: kept, refs: 0 };
                    live.set(key, entry);
                    watchOrphan(key, entry);
                    return kept;
                }
                kept.dispose();
            }

            const entry: LiveEntry = { resource: create(), refs: 0 };
            live.set(key, entry);
            watchOrphan(key, entry);
            return entry.resource;
        },
        retain: (resource) => {
            const entry = live.get(resource.key);
            if (!entry || entry.resource !== resource) return null;
            entry.refs += 1;
            clearTimers(entry);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                entry.refs -= 1;
                if (entry.refs > 0) return;
                entry.releaseTimer = setTimeout(() => settle(resource.key, entry), releaseGraceMs);
            };
        },
        size: () => ({ live: live.size, retained: retained.size }),
    };
};

/** 应用里共用的那一个。 */
export const collectionResourceRegistry = createCollectionResourceRegistry();
