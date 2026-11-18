import { describe, expect, it } from 'vitest';
import { BUILTIN_VISUALIZER_MODES } from '@/types/visualizerModes';
import { normalizeRandomVisualizerModesWith } from '@/utils/randomVisualizerModes';

// test/unit/visualizer/randomVisualizerModesMod.test.ts
// #414：随机池必须能装下 mod 注册的样式。
//
// 选择器手上有注册表，它把 isKnown 递进 store；store 那边据此归一化。
// 不给 isKnown（存储恢复 / 配置导入）时仍按内置白名单走 —— 那两条路拿不到注册表，
// 让一个已卸载 mod 的 id 留在池里只会变成「随机到它什么也不显示」。

const MOD_MODE = 'mod:testkind:style';

const isKnownWithMod = (mode: string) => mode === MOD_MODE
    || (BUILTIN_VISUALIZER_MODES as readonly string[]).includes(mode);

describe('随机池与 mod 样式', () => {
    it('给了注册表判据后，mod 样式留在池里（#414 的回归点）', () => {
        expect(normalizeRandomVisualizerModesWith(['classic', MOD_MODE], isKnownWithMod))
            .toEqual(['classic', MOD_MODE]);
    });

    it('只选了 mod 样式时，池子里就是它', () => {
        expect(normalizeRandomVisualizerModesWith([MOD_MODE], isKnownWithMod)).toEqual([MOD_MODE]);
    });

    it('内置在前、mod 在后，重复 id 只算一次', () => {
        expect(normalizeRandomVisualizerModesWith([MOD_MODE, 'tilt', 'tilt', MOD_MODE], isKnownWithMod))
            .toEqual(['tilt', MOD_MODE]);
    });

    it('注册表认不出的 id（mod 已卸载 / 拼错）仍然被丢掉', () => {
        expect(normalizeRandomVisualizerModesWith(['classic', 'mod:gone:x'], isKnownWithMod))
            .toEqual(['classic']);
    });
});
