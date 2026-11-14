import { describe, expect, it } from 'vitest';
import { AI_PROVIDER_PRESETS, inferAiProviderFromUrl, resolveAiConnection } from '../../../shared/ai/providerRegistry.mjs';
import {
    FOLIA_WORK_API_BASE,
    FOLIA_WORK_MODEL,
    FOLIA_WORK_SHARE_PAGE_URL,
    foliaWorkAdapter,
} from '../../../shared/ai/foliawork.mjs';
import { createMachineCode, isMachineCode, maskMachineCode } from '../../../src/services/foliaMachineCode';
import { firstBody } from './adapterHarness';

// test/unit/ai/foliaworkAdapter.test.ts
// 免费渠道：一个地址与模型都写死的 OpenAI 兼容服务商，密钥是本机的机器码。
// 这里钉两件事 —— 它必须**真的**是普通 OpenAI 兼容（共用路径才能照常适用），
// 以及机器码的形状（服务端与群里的机器人都靠它认出来）。

describe('免费渠道作为一个服务商', () => {
    it('是设置页能列出来的预设，地址与模型都写死', () => {
        const preset = AI_PROVIDER_PRESETS.find(value => value.id === 'foliawork');
        expect(preset).toBeTruthy();
        if (!preset) return;
        expect(preset.baseUrl).toBe(FOLIA_WORK_API_BASE);
        expect(preset.recommendedModel).toBe(FOLIA_WORK_MODEL);
        // 没有模型列表可拉：模型写死，表单只显示不发请求。
        expect(preset.listsModels).toBe(false);
        // 温度可调。流式「支持但不开放」：表单对免费渠道隐藏了这个开关。
        expect(preset.temperature).toEqual({ min: 0, max: 2 });
    });

    it('说 OpenAI 兼容，而不是自造一个协议', () => {
        // 这一点很要紧：自造协议会让 buildCompatibleBody、分词 env、适配器不变量测试、
        // 安卓原生补全每处都要开一个例外。普通 OpenAI 兼容就没有例外。
        expect(foliaWorkAdapter.protocol).toBe('openai');
    });

    it('是这个地址解析出来的那一家', () => {
        expect(inferAiProviderFromUrl(FOLIA_WORK_API_BASE)).toBe('foliawork');
        expect(resolveAiConnection({ AI_PROVIDER: 'openai', OPENAI_API_URL: FOLIA_WORK_API_BASE, OPENAI_API_MODEL: '' }))
            .toMatchObject({
                presetId: 'foliawork',
                adapterId: 'foliawork',
                protocol: 'openai',
                apiUrl: FOLIA_WORK_API_BASE,
                model: FOLIA_WORK_MODEL,
            });
    });

    it('贡献账号那一页指向后台的 /share', () => {
        expect(FOLIA_WORK_SHARE_PAGE_URL).toMatch(/\/share$/);
    });

    it('请求体就是普通的 chat/completions，没有自定义形状', () => {
        const body = firstBody('foliawork', 'theme', FOLIA_WORK_MODEL);
        expect(Array.isArray(body.messages)).toBe(true);
        // 「只做主题」那套原生端点才有的字段，一个都不该出现。
        for (const gone of ['text', 'mode', 'policy']) {
            expect(body).not.toHaveProperty(gone);
        }
    });
});

describe('机器码', () => {
    it('是 sk- 开头的一串十六进制，机器人靠这个前缀认它', () => {
        const code = createMachineCode();
        expect(code).toMatch(/^sk-[0-9a-f]{32}$/);
        expect(isMachineCode(code)).toBe(true);
    });

    it('每次生成的都不一样', () => {
        const codes = new Set(Array.from({ length: 32 }, () => createMachineCode()));
        expect(codes.size).toBe(32);
    });

    it('不认形状不对的东西', () => {
        const bad: unknown[] = ['', 'sk-', 'sk-xyz', 'abc123', 'sk-0123456789ABCDEF0123456789ABCDEF', 42, null];
        for (const value of bad) {
            expect(isMachineCode(value)).toBe(false);
        }
    });

    it('日志里只露头尾', () => {
        const code = 'sk-0123456789abcdef0123456789abcdef';
        const masked = maskMachineCode(code);
        expect(masked).not.toBe(code);
        expect(masked.startsWith('sk-0123')).toBe(true);
        expect(masked.endsWith('cdef')).toBe(true);
    });
});
