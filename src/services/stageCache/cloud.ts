import { createAiFetch } from '../aiNativeFetch';
import { isFoliaCloudCacheEnabled, resolveCloudBaseUrl } from '../foliaCloud';
import { normalizeStageIdentity, stageCacheNamespace, type StageIdentity } from './identity';
import type { StagePayload } from './repository';

// src/services/stageCache/cloud.ts — 通用身份协议；公开 PUT 只提交补缺候选并消费服务端现存版本。
export const STAGE_CLOUD_TIMEOUT_MS = 8_000;
export interface StageCloudOptions {
    identity: StageIdentity;
    baseUrl?: string;
    revision?: string;
    provider?: string;
    mediaId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export type StageCloudResult =
    | { status: 'hit'; identityKey: string; revision: string; payload: unknown; etag?: string }
    | { status: 'not-modified'; revision: string }
    | { status: 'miss' }
    | { status: 'unavailable' };
export const resolveStageCloudNamespace = (): string => stageCacheNamespace(resolveCloudBaseUrl());

// 查询可以有限等待；原生传输仍由现有桥的底层超时收尾，不代表取消了真实 AI 生成。
const exchange = async (options: StageCloudOptions, payload?: StagePayload): Promise<StageCloudResult> => {
    if (!isFoliaCloudCacheEnabled() || options.signal?.aborted
        || normalizeStageIdentity(options.identity)?.key !== options.identity.key) return { status: 'unavailable' };
    const base = stageCacheNamespace(options.baseUrl ?? resolveCloudBaseUrl());
    const url = new URL(`${base}/api/ai-stage`);
    url.searchParams.set('title', options.identity.title);
    url.searchParams.set('artists', JSON.stringify(options.identity.artists));
    if (options.provider) url.searchParams.set('provider', options.provider);
    if (options.mediaId) url.searchParams.set('mediaId', options.mediaId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
        const stopped = new Promise<never>((_, reject) => {
            cancel = () => { controller.abort(); reject(new DOMException('Stage cache request cancelled', 'AbortError')); };
            options.signal?.addEventListener('abort', cancel, { once: true });
            timer = setTimeout(cancel, options.timeoutMs ?? STAGE_CLOUD_TIMEOUT_MS);
        });
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (options.revision && !payload) headers['If-None-Match'] = `"${options.revision}"`;
        if (payload) headers['Content-Type'] = 'application/json';
        const response = await Promise.race([createAiFetch()(url.toString(), {
            method: payload ? 'PUT' : 'GET', headers, signal: controller.signal,
            body: payload ? JSON.stringify({ title: options.identity.title, artists: options.identity.artists,
                provider: options.provider, mediaId: options.mediaId, payload }) : undefined,
        }), stopped]);
        if (response.status === 304 && options.revision) return { status: 'not-modified', revision: options.revision };
        if (response.status === 404 && !payload) return { status: 'miss' };
        if (!response.ok) return { status: 'unavailable' };
        const data = await Promise.race([response.json(), stopped]) as Record<string, unknown>;
        if (data?.hit === false && !payload) return { status: 'miss' };
        if (data?.hit !== true || data.identityKey !== options.identity.key
            || typeof data.revision !== 'string' || !data.revision || !data.payload) return { status: 'unavailable' };
        return { status: 'hit', identityKey: data.identityKey, revision: data.revision,
            payload: data.payload, etag: response.headers.get('ETag') ?? undefined };
    } catch {
        return { status: 'unavailable' };
    } finally {
        if (timer) clearTimeout(timer);
        if (cancel) options.signal?.removeEventListener('abort', cancel);
    }
};
export const pullStageCloud = (options: StageCloudOptions): Promise<StageCloudResult> => exchange(options);
export const putStageCloud = (options: StageCloudOptions, payload: StagePayload): Promise<StageCloudResult> => {
    if (!payload?.theme || !payload.decision) return Promise.resolve({ status: 'unavailable' });
    return exchange(options, payload);
};
