// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import AiProviderSettings from '../../../src/components/modal/settings/pages/ai/AiProviderSettings';
import { SettingsPageContext, type ElectronSettingsState, type SettingsPageContextValue } from '../../../src/components/modal/settings/pages/settingsPageContext';
import { readMachineCode } from '../../../src/services/foliaMachineCode';

// 桌面设置页：服务商**可选**，但选中免费渠道（foliawork）时那一套字段换成
// 机器码（可复制）+ 剩余积分 + 贡献账号，密钥/模型/流式都藏起来。
//
// 这里钉的正是那两件事：可选、以及免费渠道自己的样子。剩余积分走的是
// services/foliaCredits，测试里把它换掉（不打网络）。
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../src/services/foliaCredits', () => ({
    fetchFoliaCredits: vi.fn().mockResolvedValue({ bound: true, disabled: false, remaining: 30, limit: 30, used: 0 }),
}));

let root: Root | null = null;
let host: HTMLDivElement;
const save = vi.fn().mockResolvedValue(undefined);
const setElectronSettings = vi.fn();

const base: ElectronSettingsState = {
    AI_PROVIDER: 'openai', AI_PROVIDER_PRESET: 'foliawork',
    OPENAI_API_URL: 'https://apiai.tangbot.xyz/v1', OPENAI_API_MODEL: 'deepseek-v4.1-flash',
    OPENAI_API_KEY: '', OPENAI_API_TEMPERATURE: '0.7', OPENAI_API_STREAM: false,
    GEMINI_API_URL: '', GEMINI_API_KEY: '', GEMINI_API_MODEL: 'gemini-selected', USE_SYSTEM_PROXY_FOR_AI: false,
    ENABLE_UPDATE_CHECK: true, ENABLE_AUTO_UPDATE: false, UPDATE_CHANNEL: 'realeco',
    STAGE_MODE_SOURCE: '', DISCORD_RICH_PRESENCE_ENABLED: false,
};

const render = async (patch: Partial<ElectronSettingsState> = {}) => {
    const value = { viewProps: { desktop: { model: {
        electronSettings: { ...base, ...patch }, setElectronSettings, onSaveElectronSettings: save,
        electronSaveStatus: 'idle', savedAiApiKeys: { GEMINI_API_KEY: false, OPENAI_API_KEY: false },
        savedOpenAIKeyEndpoint: null, onClearAiApiKey: vi.fn(),
    } } } } as unknown as SettingsPageContextValue;
    if (!root) {
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    }
    await act(async () => {
        root!.render(React.createElement(SettingsPageContext.Provider, { value }, React.createElement(AiProviderSettings)));
    });
};

const text = () => host.textContent ?? '';
const buttonLabelled = (key: string) => [...host.querySelectorAll('button')].find(item => item.textContent === key);

/** 选中的是免费渠道时的设置（base 就是）。 */
const FREE: Partial<ElectronSettingsState> = {};

/** 选中的是别的服务商时的设置（Gemini）。 */
const GEMINI: Partial<ElectronSettingsState> = {
    AI_PROVIDER: 'gemini', AI_PROVIDER_PRESET: 'gemini', OPENAI_API_URL: '', OPENAI_API_MODEL: '',
};

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    root = null;
    vi.clearAllMocks();
    delete (window as any).electron;
    localStorage.clear();
});

describe('服务商可选', () => {
    it('有服务商下拉：这一版是「默认选免费」，不是「只能免费」', async () => {
        await render(FREE);
        expect(host.querySelectorAll('[role="combobox"]').length).toBeGreaterThan(0);
    });

    it('选中别家时，密钥与模型这些照旧可填', async () => {
        await render(GEMINI);
        expect(host.querySelectorAll('input[type="password"]').length).toBeGreaterThan(0);
        expect(host.querySelectorAll('[role="combobox"]').length).toBeGreaterThan(0);
        expect(text()).not.toContain('options.aiMachineCodeTitle');
        expect(text()).not.toContain('options.aiCreditsTitle');
    });
});

describe('选中免费渠道时', () => {
    it('画机器码 + 复制按钮，并且不画密钥框', async () => {
        await render(FREE);
        const code = readMachineCode();
        expect(code).toMatch(/^sk-[0-9a-f]{32}$/);
        expect(text()).toContain(code);
        expect(buttonLabelled('options.aiMachineCodeCopy')).toBeTruthy();
        expect(host.querySelectorAll('input[type="password"]')).toHaveLength(0);
    });

    it('画剩余积分，并给一个刷新按钮', async () => {
        await render(FREE);
        expect(text()).toContain('options.aiCreditsTitle');
        expect(text()).toContain('options.aiCreditsRemaining');
        expect(buttonLabelled('options.aiCreditsRefresh')).toBeTruthy();
    });

    it('画贡献账号入口', async () => {
        await render(FREE);
        expect(text()).toContain('options.aiShareAccountTitle');
        expect(buttonLabelled('options.aiShareAccountAction')).toBeTruthy();
    });

    it('点复制会把机器码写进剪贴板', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await render(FREE);
        await act(async () => { buttonLabelled('options.aiMachineCodeCopy')!.click(); });
        expect(writeText).toHaveBeenCalledWith(readMachineCode());
    });

    it('模型不给改（写死），温度仍可调', async () => {
        await render(FREE);
        // 模型写死在界面上，没有模型选择框
        expect(text()).toContain('deepseek-v4.1-flash');
        // 温度那一行还在（唯一能调的旋钮）
        expect(text()).toContain('options.openaiApiTemperature');
    });
});
