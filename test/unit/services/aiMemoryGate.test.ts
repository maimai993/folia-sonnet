import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/aiMemoryGate.test.ts
// AI 推理闸门（issue #401）分成两道，判据不同：
//   · 本地推理（拍点、分轨等 on-device 模型）：总闸 + 内存水位 + 连续被杀次数，任一拦住就不跑。
//   · 在线补全（AI 主题 / 导演 / 云缓存）：只看总闸 —— 它只是一次网络请求，不占本地内存。

const storage = new Map<string, string>();

const stubStorage = () => {
    const localStorageStub = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, String(value)); },
        removeItem: (key: string) => { storage.delete(key); },
    };
    vi.stubGlobal('window', { localStorage: localStorageStub });
    vi.stubGlobal('localStorage', localStorageStub);
};

const loadGate = async (android = false) => {
    vi.resetModules();
    stubStorage();
    // 闸门的「连续被杀」与内存采样只在安卓上介入；用例里按需要把它当安卓。
    vi.doMock('../../../src/platform/runtime', () => ({ isCapacitorAndroid: () => android }));
    return import('../../../src/services/aiMemoryGate');
};

const setInferenceDisabled = async (disabled: boolean) => {
    const { useAiInferenceSettingsStore } = await import('../../../src/stores/useAiInferenceSettingsStore');
    useAiInferenceSettingsStore.getState().setAiInferenceDisabled(disabled);
};

afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('AI inference gate', () => {
    it('blocks both kinds by default, because the setting ships enabled', async () => {
        const gate = await loadGate();
        expect(gate.localInferenceBlockedReason()).toBe('disabled-in-settings');
        expect(gate.onlineInferenceBlockedReason()).toBe('disabled-in-settings');
        expect(gate.isLocalInferenceAllowed()).toBe(false);
        expect(gate.isOnlineInferenceAllowed()).toBe(false);
    });

    it('lets both run once the setting is turned off', async () => {
        const gate = await loadGate();
        await setInferenceDisabled(false);
        expect(gate.localInferenceBlockedReason()).toBeNull();
        expect(gate.onlineInferenceBlockedReason()).toBeNull();
        expect(() => gate.assertLocalInferenceAllowed()).not.toThrow();
        expect(() => gate.assertOnlineInferenceAllowed()).not.toThrow();
    });

    it('throws a recognisable code when blocked', async () => {
        const gate = await loadGate();
        await setInferenceDisabled(true);
        expect(() => gate.assertOnlineInferenceAllowed()).toThrowError(/^ai-memory-guarded/);
        try {
            gate.assertLocalInferenceAllowed();
        } catch (error) {
            expect((error as { code?: string }).code).toBe('ai-memory-guarded');
            expect((error as Error).message).toBe('ai-memory-guarded: disabled-in-settings');
        }
    });

    it('keeps online completion alive under memory pressure, and stops local inference', async () => {
        const gate = await loadGate(true);
        await setInferenceDisabled(false);
        // 连续两次没活到稳定期 → 内存压力成立。
        storage.set('folia_ai_run_alive', '0');
        storage.set('folia_ai_unstable_runs', '1');
        vi.useFakeTimers();
        gate.installAiMemoryGate();
        expect(gate.isUnderMemoryPressure()).toBe(true);
        // 在线补全不受内存压力影响（它不占本地内存）。
        expect(gate.onlineInferenceBlockedReason()).toBeNull();
        expect(() => gate.assertOnlineInferenceAllowed()).not.toThrow();
        // 本地推理被拦住，并说明原因。
        expect(gate.localInferenceBlockedReason()).toBe('recent-oom');
        expect(() => gate.assertLocalInferenceAllowed()).toThrowError(/recent-oom/);
    });

    it('counts a launch that never reached the stable point as an unstable run', async () => {
        const gate = await loadGate(true);
        storage.set('folia_ai_run_alive', '0');
        vi.useFakeTimers();
        gate.installAiMemoryGate();
        expect(gate.readAiMemoryGateState().unstableRuns).toBe(1);
    });
});
