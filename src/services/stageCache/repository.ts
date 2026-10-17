import type { StageParts } from '../aiStage';
import { putCacheEntry, readCacheEntry, readCacheEntriesByKey, removeCacheEntry } from '../repositories/cacheRepository';
import { md5 } from '../../utils/md5';
import { normalizeStageIdentity, stageCacheNamespace, type StageIdentity } from './identity';

// src/services/stageCache/repository.ts — 完整 stage 单记录原子保存，版本选择仅属于本机。
export type StagePayload = Required<StageParts>;
export interface StageVersion {
    revision: string;
    payload: StagePayload;
    digest: string;
    source: 'cloud' | 'ai' | 'local';
    savedAt: number;
}
export interface StageCacheRecord {
    schema: 1;
    namespace: string;
    identity: StageIdentity;
    original: { title: string; artists: string[] };
    current: StageVersion;
    previous?: StageVersion;
    remote?: StageVersion;
    remoteRevision?: string;
    rejectedRevision?: string;
    pinned: boolean;
    checkedAt: number;
    accessedAt: number;
}
export interface StageSaveInput {
    identity: StageIdentity;
    baseUrl: string;
    payload: unknown;
    revision: string;
    source: StageVersion['source'];
    original?: StageCacheRecord['original'];
    activate?: boolean;
    /** 迟到生成只在目标仍缺结果时补缺，原子选择现存完整版本。 */
    onlyIfAbsent?: boolean;
}
const PREFIX = 'stage_song_v1_';
const keyFor = (base: string, key: string) => `${PREFIX}${md5(stageCacheNamespace(base))}_${key}`;
let writes: Promise<unknown> = Promise.resolve();
const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const result = writes.then(run, run);
    writes = result.catch(() => undefined);
    return result;
};

export const createStageRepository = (options: {
    validate: (value: unknown) => StagePayload | null;
    maxEntries?: number;
    protectedKeys?: () => ReadonlySet<string>;
}) => {
    const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 256));
    const validateVersion = (version: StageVersion | undefined): StageVersion | undefined => {
        if (!version || typeof version.revision !== 'string' || !version.revision) return undefined;
        const payload = options.validate(version.payload);
        return payload?.theme && payload.decision && version.digest === md5(JSON.stringify(version.payload))
            ? { ...version, payload } : undefined;
    };
    const read = async (baseUrl: string, identityKey: string): Promise<StageCacheRecord | null> => {
        const raw = await readCacheEntry<StageCacheRecord>(keyFor(baseUrl, identityKey));
        if (!raw || raw.schema !== 1 || raw.namespace !== stageCacheNamespace(baseUrl)
            || raw.identity?.key !== identityKey || normalizeStageIdentity(raw.identity)?.key !== identityKey) return null;
        const current = validateVersion(raw.current);
        if (!current) return null;
        return { ...raw, current, previous: validateVersion(raw.previous), remote: validateVersion(raw.remote) };
    };
    // 容量预留先于写入；当前记录、保留版本及播放窗口都不会被淘汰。
    const reserve = async (key: string) => {
        const rows = await readCacheEntriesByKey<StageCacheRecord>(key => key.startsWith(PREFIX), ['metadata_cache', 'api_cache']);
        if (rows.some(row => row.key === key)) return;
        const candidates = rows.filter(row => !row.data?.pinned
            && (!row.data?.previous || Date.now() - row.data.accessedAt > 7 * 24 * 60 * 60_000)
            && !options.protectedKeys?.().has(row.data?.identity?.key))
            .sort((a, b) => (a.data?.accessedAt ?? a.timestamp) - (b.data?.accessedAt ?? b.timestamp));
        const count = rows.length - maxEntries + 1;
        if (count > candidates.length) throw new Error('Stage cache capacity is protected');
        for (const row of candidates.slice(0, Math.max(0, count))) await removeCacheEntry(row.key);
    };
    const save = (input: StageSaveInput): Promise<StageCacheRecord> => exclusive(async () => {
        const payload = options.validate(input.payload);
        if (!payload?.theme || !payload.decision || !input.revision
            || normalizeStageIdentity(input.identity)?.key !== input.identity.key) throw new Error('Invalid complete stage');
        const key = keyFor(input.baseUrl, input.identity.key);
        const old = await read(input.baseUrl, input.identity.key);
        if (old && input.onlyIfAbsent) return old;
        const now = Date.now();
        const version: StageVersion = { revision: input.revision, payload, source: input.source,
            digest: md5(JSON.stringify(payload)), savedAt: now };
        const activate = !old || (input.activate !== false && !old.pinned && old.rejectedRevision !== input.revision);
        const changed = old?.current.revision !== version.revision;
        const record: StageCacheRecord = {
            ...old, schema: 1, namespace: stageCacheNamespace(input.baseUrl), identity: input.identity,
            original: old?.original ?? input.original ?? { title: input.identity.title, artists: [...input.identity.artists] },
            current: activate ? version : old!.current,
            previous: activate && changed ? old?.current : old?.previous,
            remote: input.source === 'cloud' ? version : old?.remote,
            remoteRevision: input.source === 'cloud' ? version.revision : old?.remoteRevision,
            pinned: old?.pinned ?? false, checkedAt: input.source === 'cloud' ? now : old?.checkedAt ?? 0, accessedAt: now,
        };
        await reserve(key);
        await putCacheEntry(key, record);
        return record;
    });
    // 显式选择具体版本，回退后锁定本机选择，直到主动接受更新。
    const select = (base: string, key: string, revision: string | undefined, rollback: boolean, expectedRevision?: string) => exclusive(async () => {
        const old = await read(base, key);
        if (!old || (expectedRevision !== undefined && old.current.revision !== expectedRevision)) return null;
        const selected = rollback ? old.previous : [old.remote, old.previous, old.current].find(v => v?.revision === revision);
        if (!selected) return null;
        const record: StageCacheRecord = { ...old, current: selected, previous: old.current,
            pinned: rollback, rejectedRevision: rollback ? old.current.revision : undefined, accessedAt: Date.now() };
        await putCacheEntry(keyFor(base, key), record);
        return record;
    });
    return { read, save,
        rollback: (base: string, key: string, expectedRevision?: string) => select(base, key, undefined, true, expectedRevision),
        acceptUpdate: (base: string, key: string, revision: string, expectedRevision?: string) => select(base, key, revision, false, expectedRevision),
    };
};
