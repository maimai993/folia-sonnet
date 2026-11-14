import { describe, expect, it } from 'vitest';

// test/unit/visualizer/kineticTuningTransport.test.ts
// 文字PV（kinetic）的 folia 侧 tuning 已退成空对象（参数全部在原版编辑台里调），
// 这里钉住两件事：tuning.ts 的 read/merge 都返回空对象；存储里旧的 22 参数值读进来也被丢弃。

describe('kinetic tuning is now an empty placeholder', () => {
    it('read() and merge() both return an empty object', async () => {
        const adapter = (await import('@/components/visualizer/kinetic/tuning')).default;
        expect(adapter.storage?.read({} as never)).toEqual({});
        expect(adapter.storage?.read({ motion: 0.9 } as never)).toEqual({});
        expect(adapter.storage?.merge({} as never, { seed: 1 } as never)).toEqual({});
    });

    it('defaults are empty and the storage key is unchanged', async () => {
        const adapter = (await import('@/components/visualizer/kinetic/tuning')).default;
        expect(adapter.defaults).toEqual({});
        expect(adapter.settingsKey).toBe('kineticTuning');
        expect(adapter.storage?.key).toBe('kinetic_tuning');
    });
});
