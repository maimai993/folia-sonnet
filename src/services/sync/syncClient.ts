import type {
    SettingsConfirmation,
    SyncProviderConfig,
    SyncRemoteState,
    SyncThemeManifest,
    SyncedSettingsRecord,
    SyncedThemeRecord,
    WorkerHealthResponse,
} from './syncTypes';
import {
    parseSyncRemoteState,
    parseSyncThemeManifest,
    parseSyncedSettingsRecord,
    parseSyncedThemeRecords,
} from './syncSchema';
import { createAiFetch } from '../aiNativeFetch';

// src/services/sync/syncClient.ts
// HTTP adapter for Folia's user-hosted sync API.
//
// 同步服务是**用户手填地址**的自建服务，请求还带 `Authorization` 头 —— 在安卓容器里
// 这必然被同源检查掐掉，报出来的是一个毫无特征的 `TypeError: Failed to fetch`，
// 界面上只能显示「连接失败」，从现象几乎反推不到原因。所以走和 AI 云缓存、字体市场
// 同一条原生 OkHttp 桥（`createAiFetch`）；桌面与浏览器那条它自己回落到全局 fetch。

export class SyncClientError extends Error {
    status: number;

    /**
     * 服务端给的错误码（`settings_conflict`、`invalid_revision`、`unauthorized` …），拿不到时为空串。
     *
     * 服务端为不同失败刻意分了码，客户端原来只留状态码，于是 409 冲突、401 鉴权、
     * 500 故障在用户侧全是同一句「请求失败」（issue M38）。上层要能照它分流：
     * 冲突等重试 / 合并，鉴权要重新登录，服务端故障该退避。
     */
    code: string;

    constructor(message: string, status: number, code = '') {
        super(message);
        this.name = 'SyncClientError';
        this.status = status;
        this.code = code;
    }
}

/**
 * 从错误响应里取服务端的错误码。
 *
 * 错误体不一定是本站的 JSON —— 反代的 HTML 错误页、空的 502 都很常见，
 * 所以任何一步失败都退成空串，绝不因为「读不出错误体」把原始状态码也丢掉。
 */
const readErrorCode = async (response: Response): Promise<string> => {
    try {
        const body = await response.json() as unknown;
        if (body && typeof body === 'object') {
            const record = body as Record<string, unknown>;
            for (const key of ['error', 'code']) {
                const value = record[key];
                if (typeof value === 'string' && value !== '') return value;
            }
        }
    } catch {
        /* 不是 JSON（网关页面、空响应），静默退成空码。 */
    }
    return '';
};

export type ThemeListPage = {
    themes: SyncedThemeRecord[];
    cursor: string | null;
};

const buildUrl = (config: SyncProviderConfig, path: string) => (
    `${config.workerBaseUrl.replace(/\/+$/, '')}${path}`
);

/**
 * 同步接口允许整段回传的上限：4MiB。
 *
 * 这里原来放到 16MiB（比桥的默认 8MiB 宽一档），理由是「自建服务可能一次回几百条主题」。
 * 但 16MiB 的响应走过桥时，heap 里的序列化放大能到 100MB 以上 —— 2026-11-18 的 OOM 报告
 * 把这条列为踩雷点之一。所以降到 4MiB：超过这个量应该让服务端分页（`limit`），
 * 而不是一次把整库塞进一条消息里。
 */
const SYNC_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const requestJson = async <T,>(
    config: SyncProviderConfig,
    path: string,
    init: RequestInit = {},
): Promise<T> => {
    const response = await createAiFetch(SYNC_MAX_RESPONSE_BYTES)(buildUrl(config, path), {
        ...init,
        headers: {
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            Authorization: `Bearer ${config.authToken}`,
            ...init.headers,
        },
    });

    if (!response.ok) {
        const code = await readErrorCode(response);
        /* 消息里带上码，日志 / 报错时能直接看出是哪种失败；码为空就还是原来那句。 */
        const detail = code === '' ? '' : ` (${code})`;
        throw new SyncClientError(`Sync request failed: ${response.status}${detail}`, response.status, code);
    }

    if (response.status === 204) {
        return null as T;
    }

    return await response.json() as T;
};

export const testSyncConnection = async (config: SyncProviderConfig) => (
    await requestJson<WorkerHealthResponse>(config, '/health')
);

export const getRemoteState = async (config: SyncProviderConfig): Promise<SyncRemoteState | null> => (
    parseSyncRemoteState(await requestJson(config, '/state'))
);

export const getRemoteThemeManifest = async (config: SyncProviderConfig): Promise<SyncThemeManifest | null> => (
    parseSyncThemeManifest(await requestJson(config, '/themes/manifest'))
);

export const getRemoteSettings = async (config: SyncProviderConfig): Promise<SyncedSettingsRecord | null> => (
    parseSyncedSettingsRecord(await requestJson(config, '/settings'))
);

const parseSettingsConfirmation = (value: unknown): SettingsConfirmation => {
    const response = value as Partial<SettingsConfirmation> | null;
    const record = parseSyncedSettingsRecord(response?.record);
    if (response?.protocol !== 'settings-cas-v1'
        || (response.revision !== null && (typeof response.revision !== 'string' || !/^[a-f0-9]{64}$/.test(response.revision)))
        || (response.revision === null ? response.record !== null : !record)) {
        throw new Error('Sync server does not support settings confirmation; upgrade the server');
    }
    return { protocol: response.protocol, revision: response.revision, record };
};

export const getRemoteSettingsConfirmation = async (config: SyncProviderConfig): Promise<SettingsConfirmation> => (
    parseSettingsConfirmation(await requestJson(config, '/settings/confirmation', { cache: 'no-store' }))
);

export const putRemoteSettings = async (
    config: SyncProviderConfig,
    record: SyncedSettingsRecord,
    expectedRevision: string | null,
): Promise<SettingsConfirmation> => {
    const response = await requestJson<{ accepted?: boolean; record?: SyncedSettingsRecord }>(config, '/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...record, expectedRevision }),
    });
    const confirmed = parseSettingsConfirmation(response);
    // Check the complete raw payload before parsing can discard fields; updatedAt is server-owned.
    if (response.accepted !== true || !confirmed.record || !confirmed.revision
        || JSON.stringify(response.record?.data) !== JSON.stringify(record.data)) {
        throw new Error('Sync server did not confirm the uploaded settings');
    }
    return confirmed;
};

export const getRemoteThemes = async (
    config: SyncProviderConfig,
    fingerprints: string[],
): Promise<SyncedThemeRecord[]> => {
    const uniqueFingerprints = Array.from(new Set(fingerprints.filter(Boolean)));
    if (uniqueFingerprints.length === 0) {
        return [];
    }

    const response = await requestJson<{ themes?: unknown[] }>(config, '/themes/get', {
        method: 'POST',
        body: JSON.stringify({ fingerprints: uniqueFingerprints }),
    });

    return parseSyncedThemeRecords(response.themes ?? []);
};

export const putRemoteThemes = async (
    config: SyncProviderConfig,
    themes: SyncedThemeRecord[],
) => {
    if (themes.length === 0) {
        return;
    }

    await requestJson(config, '/themes/put', {
        method: 'POST',
        body: JSON.stringify({ themes }),
    });
};

export const getRemoteThemesByBuckets = async (
    config: SyncProviderConfig,
    bucketIds: number[],
): Promise<SyncedThemeRecord[]> => {
    const ids = Array.from(new Set(bucketIds.filter(Number.isInteger)));
    if (ids.length === 0) {
        return [];
    }

    const response = await requestJson<{ themes?: unknown[] }>(config, '/themes/bucket', {
        method: 'POST',
        body: JSON.stringify({ bucketIds: ids }),
    });

    return parseSyncedThemeRecords(response.themes ?? []);
};

export const listRemoteThemes = async (
    config: SyncProviderConfig,
    options: { cursor?: string | null; limit?: number } = {},
): Promise<ThemeListPage> => {
    const response = await requestJson<{ themes?: unknown[]; cursor?: unknown }>(config, '/themes/list', {
        method: 'POST',
        body: JSON.stringify({
            cursor: options.cursor ?? null,
            limit: options.limit ?? 500,
        }),
    });

    return {
        themes: parseSyncedThemeRecords(response.themes ?? []),
        cursor: typeof response.cursor === 'string' && response.cursor ? response.cursor : null,
    };
};
