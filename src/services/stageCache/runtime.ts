import type { StageParts, StageRequest, StageResult } from '../aiStage';
import { pullAiCloudCache, type AiCloudCacheSource } from '../aiCloudCache';
import { md5 } from '../../utils/md5';
import { normalizeStageIdentity } from './identity';
import { createStageRepository, type StagePayload } from './repository';
import { pullStageCloud, putStageCloud, resolveStageCloudNamespace } from './cloud';
import { createStageScheduler } from './scheduler';

// src/services/stageCache/runtime.ts — 查询、持久化与生成共享入口；画面提交由播放消费者持有。
export class StageCacheMissError extends Error {
    constructor() { super('No cached visual stage'); this.name = 'StageCacheMissError'; }
}
export interface StageUpdate {
    identityKey: string;
    namespace: string;
    redoRevision?: string;
    payload: StageParts;
    revision: string;
    reason: 'update' | 'rollback';
    /** 后台更新只属于启动检查的播放轮次，消费时再次确认。 */
    isCurrent?: () => boolean;
}
export interface StageCacheDiagnostic {
    identityKey?: string;
    namespace: string;
    operation: 'persist' | 'upload';
    success: boolean;
}
const diagnostics = new Set<(event: StageCacheDiagnostic) => void>();
export const subscribeStageCacheDiagnostics = (listener: (event: StageCacheDiagnostic) => void) => {
    diagnostics.add(listener);
    return () => { diagnostics.delete(listener); };
};
const diagnose = (event: StageCacheDiagnostic) => diagnostics.forEach(listener => {
    try { listener(event); } catch { /* 诊断不改变请求结果。 */ }
});
let protectedKeys: ReadonlySet<string> = new Set();
export const setProtectedStageKeys = (keys: ReadonlySet<string>) => { protectedKeys = new Set(keys); };
const listeners = new Set<(event: StageUpdate) => void>();
export const subscribeStageUpdates = (listener: (event: StageUpdate) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
const emit = (event: StageUpdate) => listeners.forEach(listener => {
    try { listener(event); } catch { /* 提示消费者不影响已完成的存储与其他订阅。 */ }
});
const CHECK_INTERVAL = 60_000;
const STABLE_DELAY = 1_200;

export const createStageRuntime = (normalize: (payload: unknown) => StageParts | null) => {
    const scheduler = createStageScheduler<StageResult>();
    const checks = new Map<string, Promise<StageResult | undefined>>();
    const checked = new Map<string, number>();
    const recent = new Map<string, { value: StageResult; at: number }>();
    const validate = (payload: unknown): StagePayload | null => {
        const parts = normalize(payload);
        return parts?.theme && parts.decision ? parts as StagePayload : null;
    };
    const repository = createStageRepository({ validate, protectedKeys: () => protectedKeys });
    const persist = async (input: Parameters<typeof repository.save>[0]) => {
        try {
            const record = await repository.save(input);
            diagnose({ identityKey: input.identity.key, namespace: input.baseUrl, operation: 'persist', success: true });
            return record;
        } catch {
            diagnose({ identityKey: input.identity.key, namespace: input.baseUrl, operation: 'persist', success: false });
            return null;
        }
    };
    const restore = async (song: StageRequest['song']) => {
        const identity = song && normalizeStageIdentity({ title: song.title, artists: song.artists ?? [] });
        if (!identity) return null;
        const base = resolveStageCloudNamespace();
        return await repository.read(`${base}/personal`, identity.key).catch(() => null)
            ?? await repository.read(base, identity.key).catch(() => null);
    };
    const selectedBase = async (identityKey: string) => {
        const base = resolveStageCloudNamespace();
        return await repository.read(`${base}/personal`, identityKey).catch(() => null) ? `${base}/personal` : base;
    };
    const rollback = async (identityKey: string, expectedRevision?: string) => {
        const namespace = await selectedBase(identityKey);
        const record = await repository.rollback(namespace, identityKey, expectedRevision);
        if (record) emit({ identityKey, namespace, redoRevision: record.previous?.revision,
            payload: record.current.payload, revision: record.current.revision, reason: 'rollback' });
        return record;
    };
    const acceptUpdate = async (identityKey: string, revision: string, expectedRevision?: string) => {
        const namespace = await selectedBase(identityKey);
        const record = await repository.acceptUpdate(namespace, identityKey, revision, expectedRevision);
        if (record) emit({ identityKey, namespace, payload: record.current.payload, revision: record.current.revision, reason: 'update' });
        return record;
    };
    // 同歌网络检查共享，调用方取消仅撤销自己的生成和应用权。
    const resolve = async (request: StageRequest, fingerprint: string, generate: () => Promise<StageParts>): Promise<StageResult> => {
        const baseUrl = resolveStageCloudNamespace();
        const identity = request.song && normalizeStageIdentity({ title: request.song.title, artists: request.song.artists ?? [] });
        const customized = Boolean(request.hint?.trim()) || request.publicEligible === false;
        const personal = request.force === true || customized;
        const privateBase = customized ? `${baseUrl}/personal/${fingerprint}` : `${baseUrl}/personal`;
        const storageBase = personal ? privateBase : baseUrl;
        const key = `${storageBase}:${identity?.key ?? fingerprint}:${personal ? fingerprint + ':personal' : 'public'}`;
        const valid = () => !request.signal?.aborted && (request.isCurrent?.() ?? true);
        const chosenPrivate = identity && !customized && !request.force
            ? await repository.read(`${baseUrl}/personal`, identity.key).catch(() => null) : null;
        const local = identity && !request.force
            ? chosenPrivate ?? await repository.read(storageBase, identity.key).catch(() => null) : null;
        const fetchCloud = async (): Promise<StageResult | undefined> => {
            if (!identity || personal) return undefined;
            const pending = checks.get(key);
            if (pending) return pending;
            if (Date.now() - (checked.get(key) ?? 0) < CHECK_INTERVAL) return undefined;
            const check = (async () => {
                const result = await pullStageCloud({ identity, baseUrl, revision: local?.remoteRevision,
                    provider: request.song?.provider ?? request.platform, mediaId: String(request.song?.mediaId ?? '') });
                checked.set(key, Date.now());
                if (checked.size > 512) checked.delete(checked.keys().next().value!);
                if (result.status !== 'hit') return undefined;
                const payload = validate(result.payload);
                if (!payload) return undefined;
                const record = await persist({ identity, baseUrl, payload, revision: result.revision, source: 'cloud' })
                    .catch(() => null);
                if (!record) return { ...payload, source: 'cloud' as AiCloudCacheSource };
                if (local && local.current.revision !== record.current.revision && valid()) {
                    emit({ identityKey: identity.key, namespace: baseUrl, payload: record.current.payload, revision: record.current.revision,
                        reason: 'update', isCurrent: valid });
                }
                return { ...record.current.payload, source: 'cloud' as AiCloudCacheSource };
            })();
            checks.set(key, check);
            try { return await check; } finally { if (checks.get(key) === check) checks.delete(key); }
        };
        if (local) {
            if (!personal && !chosenPrivate) void fetchCloud().catch(() => undefined);
            return { ...local.current.payload, source: 'local' };
        }
        if (!personal) {
            const cloud = await fetchCloud().catch(() => undefined);
            if (cloud) return cloud;
            // 只兼容歌词精确旧键，不再用无歌手的旧歌名兜底关联。
            if (!request.cacheOnly) {
                const old = await pullAiCloudCache('stage', fingerprint);
                const payload = old.status === 'hit' ? validate(old.payload) : null;
                if (payload) {
                    if (identity) await persist({ identity, baseUrl, payload, revision: `legacy-${md5(JSON.stringify(payload))}`, source: 'cloud' }).catch(() => undefined);
                    return { ...payload, source: 'cloud' };
                }
            }
        }
        const remembered = recent.get(key);
        if (!request.force && remembered && Date.now() - remembered.at < 10 * 60_000) return remembered.value;
        if (request.cacheOnly) throw new StageCacheMissError();
        if (!valid()) throw new DOMException('Stage playback expired', 'AbortError');
        const result = await scheduler.request({ key: request.force ? `${key}:force` : key, priority: request.priority ?? 'current',
            signal: request.signal, isValid: valid,
            beforeRun: async () => {
                if (request.priority !== 'manual') await new Promise(resolve => setTimeout(resolve, STABLE_DELAY));
                if (!request.force && identity) {
                    const ready = await repository.read(storageBase, identity.key).catch(() => null);
                    if (ready) return { ...ready.current.payload, source: 'local' as AiCloudCacheSource };
                }
                return undefined;
            },
            generate: async () => {
                const parts = await generate();
                const payload = validate(parts);
                if (identity && payload) {
                    const revision = `local-${md5(JSON.stringify(payload))}`;
                    if (request.force && !customized && !await repository.read(storageBase, identity.key).catch(() => null)) {
                        const prior = await repository.read(baseUrl, identity.key).catch(() => null);
                        if (prior) await persist({ identity, baseUrl: storageBase, payload: prior.current.payload,
                            revision: prior.current.revision, source: 'local' }).catch(() => undefined);
                    }
                    const savedLocal = await persist({ identity, baseUrl: storageBase,
                        payload, revision, source: 'ai', onlyIfAbsent: !personal }).catch(() => null);
                    if (savedLocal && savedLocal.current.revision !== revision) {
                        return { ...savedLocal.current.payload, source: 'local' as AiCloudCacheSource };
                    }
                    if (!personal) {
                        // 公共补缺返回现有版本时以服务端为准，不让旧生成覆盖新公共结果。
                        const remote = await putStageCloud({ identity, baseUrl, provider: request.song?.provider ?? request.platform,
                            mediaId: String(request.song?.mediaId ?? '') }, payload);
                        diagnose({ identityKey: identity.key, namespace: baseUrl, operation: 'upload', success: remote.status === 'hit' });
                        if (remote.status === 'hit' && validate(remote.payload)) {
                            const saved = await persist({ identity, baseUrl, payload: remote.payload, revision: remote.revision, source: 'cloud' })
                                .catch(() => null);
                            checked.delete(key);
                            const accepted = saved?.current.payload ?? validate(remote.payload)!;
                            return { ...accepted, source: (md5(JSON.stringify(accepted)) === md5(JSON.stringify(payload))
                                ? 'ai' : 'cloud') as AiCloudCacheSource };
                        }
                    }
                }
                return { ...parts, source: 'ai' as AiCloudCacheSource };
            },
        });
        recent.set(key, { value: result, at: Date.now() });
        if (recent.size > 32) recent.delete(recent.keys().next().value!);
        return result;
    };
    return { resolve, restore, rollback, acceptUpdate };
};
