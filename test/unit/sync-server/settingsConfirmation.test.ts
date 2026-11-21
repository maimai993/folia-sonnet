import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../sync-server/src/app';
import { D1Emulator } from '../../../sync-server/src/d1-emulator';
import { compareAndSetSettings, readSettingsRow, settingsRevision } from '../../../sync-server/src/settingsConfirmation';
import type { Env } from '../../../sync-server/src/app';

// Exercises coordinator + HTTP client + real Hono routes + SQLite, with only local stores/transport isolated.
const local = vi.hoisted(() => ({ value: 'local', offline: false, legacyServer: false, baseUrl: 'https://sync.test', token: 'synthetic-test-token', beforePut: null as null | (() => Promise<void>), afterPut: null as null | (() => void), saveCache: null as null | (() => Promise<void>) }));
const transport = vi.hoisted(() => ({ fetch: null as null | ((input: string, init?: RequestInit) => Promise<Response>) }));
vi.mock('../../../src/services/aiNativeFetch', () => ({ createAiFetch: () => transport.fetch }));
vi.mock('../../../src/services/db', () => ({ getCacheEntriesByPrefix: async () => [], getFromCache: async () => null, saveToCache: async () => { await local.saveCache?.(); }, getThemeRegistryEntries: async () => [], upsertThemeRegistryEntries: async () => {} }));
vi.mock('../../../src/services/sync/syncConfig', () => ({
    getSyncConfig: () => ({ provider: 'sync-server', enabled: true, workerBaseUrl: local.baseUrl, authToken: local.token }),
    isSyncConfigured: () => true,
    setSyncStatus: vi.fn(),
}));
vi.mock('../../../src/services/sync/settingsSnapshot', () => ({
    readSyncableSettingsState: () => ({ value: local.value }),
    getSyncedSettingsSignature: (state: { value: string }) => JSON.stringify({ visualizerMode: state.value }),
    buildSyncedSettingsRecord: (state: { value: string }, updatedAt = new Date().toISOString()) => ({ schemaVersion: 1, updatedAt, data: { visualizerMode: state.value } }),
    applySyncedVisualSettings: (_state: unknown, data: { visualizerMode?: string }) => { if (data.visualizerMode) local.value = data.visualizerMode; },
}));

const storage = new Map<string, string>();
vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
}, dispatchEvent: () => true });
vi.stubGlobal('localStorage', window.localStorage);
const { importSyncLibraryBundle, syncNow } = await import('../../../src/services/sync/syncCoordinator');
const db = new D1Emulator(':memory:');
const env: Env = { FOLIA_SYNC_DB: db, SYNC_TOKEN: 'synthetic-test-token' };
const syncOptions = { syncThemes: false, applyRemoteSettings: true, pushSettings: true };
const baselineKey = 'folia_sync_settings_confirmation_v1';
const record = (value: string, updatedAt = '2099-01-01T00:00:00.000Z', schemaVersion = 2) => ({ schemaVersion, updatedAt, data: { visualizerMode: value } });
const request = (path: string, init: RequestInit = {}) => app.request(`https://sync.test${path}`, {
    ...init, headers: { Authorization: `Bearer ${env.SYNC_TOKEN}`, 'Content-Type': 'application/json', ...init.headers },
}, env);
const legacyWrite = async (value: string, updatedAt?: string, schemaVersion = 2) => {
    const response = await request('/settings', { method: 'PUT', body: JSON.stringify(record(value, updatedAt, schemaVersion)) });
    expect(response.status).toBe(200);
};
const serverValue = async () => JSON.parse((await readSettingsRow(db))!.value_json).data.visualizerMode;
const imported = () => ({ kind: 'folia-sync-export', schemaVersion: 1, exportedAt: '2025-01-01T00:00:00Z', settings: record('imported', '2025-01-01T00:00:00Z', 1), themes: [] });
const establishBaseline = async () => { expect((await syncNow(syncOptions))?.pushedLocalSettings).toBe(true); };

beforeAll(async () => { expect((await request('/health')).status).toBe(200); });
beforeEach(async () => {
    await db.prepare('DELETE FROM settings').run();
    storage.clear();
    env.SYNC_TOKEN = 'synthetic-test-token';
    local.value = 'local'; local.offline = false; local.legacyServer = false; local.baseUrl = 'https://sync.test'; local.token = 'synthetic-test-token'; local.beforePut = null; local.afterPut = null; local.saveCache = null;
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    transport.fetch = async (input, init) => {
        const path = new URL(input).pathname;
        if (local.legacyServer && path === '/settings/confirmation') return new Response('Not Found', { status: 404 });
        if (init?.method === 'PUT') {
            if (local.offline) throw new Error('offline');
            const hook = local.beforePut; local.beforePut = null;
            await hook?.();
        }
        const response = await request(path, init);
        if (init?.method === 'PUT') local.afterPut?.();
        return response;
    };
});
afterAll(() => { (db as unknown as { db: { close: () => void } }).db.close(); });

describe('settings confirmation through real Hono/SQLite', () => {
    it('preserves wire v2 and accepts old v1 settings clients', async () => {
        expect(await (await request('/state')).json()).toMatchObject({ schemaVersion: 2 });
        await legacyWrite('old-client', undefined, 1);
        expect(await serverValue()).toBe('old-client');
    });

    /*
     * 老客户端路径（issue M37）。
     *
     * 这条原来叫「reproduces the original future-timestamp no-op ACK」，断言的是 bug 本身：
     * 更旧的时间戳被 SQL 守卫挡下、数据实际没写，却回 `{ ok: true }`。等于把「静默丢数据」
     * 钉成了规格。现在回执反映真实结果：409 + `settings_stale`。
     * 携带 expectedRevision 的 CAS 路径不变（上面那条 keep-local）。
     */
    it('legacy path reports a stale timestamp as 409 instead of a silent ok', async () => {
        await legacyWrite('remote-future');
        const response = await request('/settings', { method: 'PUT', body: JSON.stringify(record('chosen-local', '2026-01-01T00:00:00Z')) });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ ok: false, error: 'settings_stale', stale: true });
        /* 数据照旧没被写进去 —— 变的是回执不再骗人。 */
        expect(await serverValue()).toBe('remote-future');
    });

    /* 相等的时间戳仍然写入（`>=` 守卫不变），别把正常覆盖也挡了。 */
    it('legacy path still writes when the timestamp matches', async () => {
        await legacyWrite('first');
        const response = await request('/settings', { method: 'PUT', body: JSON.stringify(record('second', '2099-01-01T00:00:00.000Z')) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(await serverValue()).toBe('second');
    });

    it('keep-local actually writes over a future clock and only then saves a baseline', async () => {
        await legacyWrite('remote-future');
        const conflict = await syncNow(syncOptions);
        expect(conflict?.settingsConflict).toBe(true);
        expect(local.value).toBe('local');
        expect(storage.has(baselineKey)).toBe(false);
        expect(await syncNow({ ...syncOptions, settingsConflictResolution: 'local', settingsConflictRevision: conflict!.settingsRevision })).toMatchObject({ pushedLocalSettings: true, settingsConflict: false });
        expect(await serverValue()).toBe('local');
        expect((await readSettingsRow(db))!.updated_at).toBe('2099-01-01T00:00:00.001Z');
        expect(await syncNow(syncOptions)).toMatchObject({ appliedRemoteSettings: false, pushedLocalSettings: false, settingsConflict: false });
        expect(local.value).toBe('local');
    });

    it('first baseline never silently discards existing local settings', async () => {
        await legacyWrite('remote');
        expect(await syncNow(syncOptions)).toMatchObject({ settingsConflict: true, appliedRemoteSettings: false, pushedLocalSettings: false });
        expect(local.value).toBe('local');
    });

    it('applies remote-only changes without pushing them back', async () => {
        await establishBaseline();
        await legacyWrite('remote');
        expect(await syncNow(syncOptions)).toMatchObject({ appliedRemoteSettings: true, pushedLocalSettings: false, settingsConflict: false });
        expect(local.value).toBe('remote');
    });

    it('pushes local-only changes and reports both-side changes as conflicts', async () => {
        await establishBaseline();
        local.value = 'local-edited';
        expect((await syncNow(syncOptions))?.pushedLocalSettings).toBe(true);
        await legacyWrite('remote');
        local.value = 'local-again';
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(await serverValue()).toBe('remote');
        expect(local.value).toBe('local-again');
    });

    it('explicit remote choice applies without a push', async () => {
        await legacyWrite('remote');
        expect(await syncNow({ ...syncOptions, settingsConflictResolution: 'remote' })).toMatchObject({ appliedRemoteSettings: true, pushedLocalSettings: false });
        expect(local.value).toBe('remote');
    });

    it('detects different data at the very same timestamp', async () => {
        await establishBaseline();
        const timestamp = (await readSettingsRow(db))!.updated_at;
        await legacyWrite('same-time-remote', timestamp);
        local.value = 'local-edit';
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(local.value).toBe('local-edit');
    });

    it('rejects a same-timestamp concurrent write between observation and CAS', async () => {
        await establishBaseline();
        const before = storage.get(baselineKey);
        local.value = 'local-edit';
        local.beforePut = async () => { await legacyWrite('racer', (await readSettingsRow(db))!.updated_at); };
        expect(await syncNow(syncOptions)).toMatchObject({ settingsConflict: true, pushedLocalSettings: false });
        expect(await serverValue()).toBe('racer');
        expect(storage.get(baselineKey)).toBe(before);
    });

    it('requires a new choice if the remote changed while the conflict dialog was open', async () => {
        await legacyWrite('remote');
        const conflict = await syncNow(syncOptions);
        await legacyWrite('new-remote');
        expect(await syncNow({ ...syncOptions, settingsConflictResolution: 'local', settingsConflictRevision: conflict!.settingsRevision })).toMatchObject({ settingsConflict: true, pushedLocalSettings: false });
        expect(await serverValue()).toBe('new-remote');
    });

    it('only one writer wins an empty-row race', async () => {
        const body = JSON.stringify({ ...record('winner', undefined, 1), expectedRevision: null });
        const responses = await Promise.all([request('/settings', { method: 'PUT', body }), request('/settings', { method: 'PUT', body })]);
        expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
        expect(await serverValue()).toBe('winner');
    });

    it('SQL compare-and-set refuses changes after the row was observed', async () => {
        await legacyWrite('first');
        const observed = await readSettingsRow(db);
        const revision = await settingsRevision(observed);
        await legacyWrite('second');
        expect(await settingsRevision(await readSettingsRow(db))).not.toBe(revision);
        expect(await compareAndSetSettings(db, observed, record('loser'))).toBeNull();
        expect(await serverValue()).toBe('second');
    });

    it('SQL compare-and-set refuses an insert after an empty observation', async () => {
        await legacyWrite('insert-racer');
        expect(await compareAndSetSettings(db, null, record('loser'))).toBeNull();
        expect(await serverValue()).toBe('insert-racer');
    });

    it('does not mark settings edited during upload as already synced', async () => {
        await establishBaseline();
        local.value = 'sent';
        local.afterPut = () => { local.value = 'edited-during-upload'; };
        expect((await syncNow(syncOptions))?.pushedLocalSettings).toBe(true);
        expect(await serverValue()).toBe('sent');
        local.afterPut = null;
        await legacyWrite('remote');
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(local.value).toBe('edited-during-upload');
    });

    it('failed pushes leave the previous baseline untouched', async () => {
        await establishBaseline();
        const before = storage.get(baselineKey);
        local.value = 'unsent'; local.offline = true;
        expect(await syncNow(syncOptions)).toBeNull();
        expect(storage.get(baselineKey)).toBe(before);
        local.offline = false;
        await legacyWrite('remote');
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(local.value).toBe('unsent');
    });

    it('local-only import removes any synced baseline and survives the next pull', async () => {
        await establishBaseline();
        await legacyWrite('remote');
        await importSyncLibraryBundle(imported(), { pushRemote: false });
        expect(storage.has(baselineKey)).toBe(false);
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(local.value).toBe('imported');
    });

    it('failed import settings push keeps imported settings dirty', async () => {
        await establishBaseline();
        await legacyWrite('remote');
        local.offline = true;
        await expect(importSyncLibraryBundle(imported())).rejects.toThrow('offline');
        expect(storage.has(baselineKey)).toBe(false);
        local.offline = false;
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(local.value).toBe('imported');
    });

    it('import CAS races do not overwrite a concurrent remote edit or create a baseline', async () => {
        await legacyWrite('remote');
        local.beforePut = async () => { await legacyWrite('import-racer'); };
        await expect(importSyncLibraryBundle(imported())).rejects.toThrow('409');
        expect(storage.has(baselineKey)).toBe(false);
        expect(await serverValue()).toBe('import-racer');
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(local.value).toBe('imported');
    });

    it('successful import confirms the resulting snapshot rather than an export date', async () => {
        await legacyWrite('remote');
        await importSyncLibraryBundle(imported());
        expect(await serverValue()).toBe('imported');
        expect(await syncNow(syncOptions)).toMatchObject({ settingsConflict: false, pushedLocalSettings: false, appliedRemoteSettings: false });
    });

    it('import edits made while uploading remain dirty', async () => {
        await legacyWrite('remote');
        local.afterPut = () => { local.value = 'after-import'; };
        await importSyncLibraryBundle(imported());
        local.afterPut = null;
        await legacyWrite('remote-later', '2099-01-01T00:00:01Z');
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(local.value).toBe('after-import');
    });

    it('theme upload failure during import leaves settings dirty and does not push them', async () => {
        await establishBaseline();
        await legacyWrite('remote');
        const originalFetch = transport.fetch!;
        transport.fetch = async (input, init) => {
            if (new URL(input).pathname === '/themes/put') throw new Error('theme-offline');
            return originalFetch(input, init);
        };
        const bundle = imported();
        const withTheme = { ...bundle, themes: [{ fingerprint: 'netease:123', source: 'manual', updatedAt: '2026-01-01T00:00:00Z', theme: {} }] };
        await expect(importSyncLibraryBundle(withTheme)).rejects.toThrow('theme-offline');
        expect(storage.has(baselineKey)).toBe(false);
        expect(await serverValue()).toBe('remote');
        transport.fetch = originalFetch;
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        expect(local.value).toBe('imported');
    });

    it('remote choice does not discard local edits made while reading the server', async () => {
        await legacyWrite('remote');
        const originalFetch = transport.fetch!;
        transport.fetch = async (input, init) => {
            const response = await originalFetch(input, init);
            if (new URL(input).pathname === '/settings/confirmation') local.value = 'edited-during-read';
            return response;
        };
        expect(await syncNow({ ...syncOptions, settingsConflictResolution: 'remote' })).toMatchObject({ settingsConflict: true, appliedRemoteSettings: false });
        expect(local.value).toBe('edited-during-read');
    });

    it('does not apply a pending remote read over new local edits', async () => {
        await establishBaseline();
        await legacyWrite('remote');
        const originalFetch = transport.fetch!;
        transport.fetch = async (input, init) => {
            const response = await originalFetch(input, init);
            if (new URL(input).pathname === '/settings/confirmation') local.value = 'pending-edit';
            return response;
        };
        expect(await syncNow(syncOptions)).toMatchObject({ settingsConflict: true, appliedRemoteSettings: false });
        expect(local.value).toBe('pending-edit');
    });

    it('credential rotation at the same URL invalidates baseline without storing credentials', async () => {
        await establishBaseline();
        expect(storage.get(baselineKey)).not.toContain(local.token);
        local.token = 'rotated-synthetic-token';
        env.SYNC_TOKEN = local.token;
        expect(await syncNow(syncOptions)).toMatchObject({ settingsConflict: true, appliedRemoteSettings: false });
    });

    it.each(['/state', '/settings/confirmation'])('config changes during %s cannot push A settings into B', async (boundary) => {
        const originalFetch = transport.fetch!;
        let puts = 0;
        transport.fetch = async (input, init) => {
            if (init?.method === 'PUT') puts += 1;
            const response = await originalFetch(input, init);
            if (new URL(input).pathname === boundary) local.baseUrl = 'https://other.test';
            return response;
        };
        expect(await syncNow(syncOptions)).toBeNull();
        expect(puts).toBe(0);
        expect(storage.has(baselineKey)).toBe(false);
    });

    it('credential change while PUT is pending does not save an ACK to the new scope', async () => {
        local.afterPut = () => { local.token = 'rotated-synthetic-token'; };
        expect(await syncNow(syncOptions)).toBeNull();
        expect(await serverValue()).toBe('local');
        expect(storage.has(baselineKey)).toBe(false);
    });

    it('rejects an old conflict choice after switching to a cloned server with the same revision', async () => {
        await legacyWrite('remote');
        const conflict = (await syncNow(syncOptions))!;
        local.baseUrl = 'https://cloned.test';
        expect(await syncNow({ ...syncOptions, settingsConflictResolution: 'local', settingsConflictRevision: conflict.settingsRevision, settingsConflictScope: conflict.settingsScope })).toMatchObject({ settingsConflict: true, pushedLocalSettings: false });
        expect(await serverValue()).toBe('remote');
    });

    it('keep-local still writes if local settings were undone back to the old baseline', async () => {
        await establishBaseline();
        await legacyWrite('remote');
        local.value = 'local-edited';
        const conflict = (await syncNow(syncOptions))!;
        local.value = 'local';
        expect(await syncNow({ ...syncOptions, settingsConflictResolution: 'local', settingsConflictRevision: conflict.settingsRevision, settingsConflictScope: conflict.settingsScope })).toMatchObject({ settingsConflict: false, pushedLocalSettings: true });
        expect(await serverValue()).toBe('local');
        expect((await syncNow(syncOptions))?.appliedRemoteSettings).toBe(false);
    });

    it('captures import config before a paused cache save and never pushes to the new server', async () => {
        let release!: () => void;
        let started!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const entered = new Promise<void>(resolve => { started = resolve; });
        local.saveCache = async () => { started(); await pending; };
        const bundle = imported();
        const withTheme = { ...bundle, themes: [{ fingerprint: 'netease:123', source: 'manual', updatedAt: '2026-01-01T00:00:00Z', theme: {} }] };
        let puts = 0;
        const originalFetch = transport.fetch!;
        transport.fetch = async (input, init) => { if (init?.method === 'PUT' || init?.method === 'POST') puts += 1; return originalFetch(input, init); };
        const importing = importSyncLibraryBundle(withTheme);
        await entered;
        local.baseUrl = 'https://new.test';
        release();
        await expect(importing).rejects.toThrow('Sync server changed');
        expect(puts).toBe(0);
        expect(storage.has(baselineKey)).toBe(false);
        expect(await readSettingsRow(db)).toBeNull();
    });

    it('does not apply remote over an undo back to baseline while GET is pending', async () => {
        await establishBaseline();
        await legacyWrite('remote');
        local.value = 'changed-before-read';
        const originalFetch = transport.fetch!;
        transport.fetch = async (input, init) => {
            const response = await originalFetch(input, init);
            if (new URL(input).pathname === '/settings/confirmation') local.value = 'local';
            return response;
        };
        expect(await syncNow(syncOptions)).toMatchObject({ settingsConflict: true, appliedRemoteSettings: false });
        expect(local.value).toBe('local');
        expect(await serverValue()).toBe('remote');
    });

    it('explicit remote choice still applies after remote was undone back to baseline', async () => {
        await establishBaseline();
        const baselineRow = (await readSettingsRow(db))!;
        await legacyWrite('remote-edit');
        local.value = 'local-edited';
        expect((await syncNow(syncOptions))?.settingsConflict).toBe(true);
        await db.prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?').bind(baselineRow.value_json, baselineRow.updated_at, 'visual').run();
        expect(await syncNow({ ...syncOptions, settingsConflictResolution: 'remote' })).toMatchObject({ appliedRemoteSettings: true, pushedLocalSettings: false });
        expect(local.value).toBe('local');
        expect(await serverValue()).toBe('local');
    });

    it('works in an HTTP LAN client without crypto.subtle using the existing SHA fallback', async () => {
        const serverCrypto = globalThis.crypto;
        vi.stubGlobal('crypto', {});
        // Hono runs in a separate secure Node/Workers host in production; preserve its real crypto here.
        const originalFetch = transport.fetch!;
        transport.fetch = async (input, init) => {
            vi.stubGlobal('crypto', serverCrypto);
            try { return await originalFetch(input, init); }
            finally { vi.stubGlobal('crypto', {}); }
        };
        try {
            expect((await syncNow(syncOptions))?.pushedLocalSettings).toBe(true);
            expect((await syncNow(syncOptions))?.settingsConflict).toBe(false);
            await importSyncLibraryBundle(imported());
            expect(local.value).toBe('imported');
        } finally { vi.stubGlobal('crypto', serverCrypto); }
    });

    it('explicit remote choice on an empty server reports conflict and never uploads local settings', async () => {
        let puts = 0;
        const originalFetch = transport.fetch!;
        transport.fetch = async (input, init) => { if (init?.method === 'PUT') puts += 1; return originalFetch(input, init); };
        expect(await syncNow({ ...syncOptions, settingsConflictResolution: 'remote' })).toMatchObject({ settingsConflict: true, pushedLocalSettings: false, appliedRemoteSettings: false });
        expect(puts).toBe(0);
        expect(await readSettingsRow(db)).toBeNull();
        expect(local.value).toBe('local');
    });

    it('old servers without confirmation fail closed before PUT', async () => {
        local.legacyServer = true;
        expect(await syncNow(syncOptions)).toBeNull();
        expect(await readSettingsRow(db)).toBeNull();
        expect(storage.has(baselineKey)).toBe(false);
    });
});
