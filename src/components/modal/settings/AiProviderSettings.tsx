import React, { useState, useSyncExternalStore } from 'react';
import { Check, Cloud, Copy, ExternalLink, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
    readAiSettings,
    writeAiSettings,
    AI_PROVIDER_IDS,
    aiPresetOf,
    aiProtocolOf,
    type AiProviderId,
} from '../../../services/aiSettings';
import { GEMINI_DEFAULT_API_BASE } from '../../../../shared/geminiEndpoint.mjs';
import { resolveAiCloudCacheUrl } from '../../../services/aiCloudCache';
import { STAGE_CACHE_KIND } from '../../../services/aiStage';
import {
    getFoliaCloudSettingsVersion,
    readFoliaCloudSettings,
    subscribeFoliaCloudSettings,
    updateFoliaCloudSettings,
} from '../../../services/foliaCloud';
import { createAiFetch } from '../../../services/aiNativeFetch';
import { Select, Toggle } from './kit';
import {
    getDirectorStateVersion,
    readDirectorSettings,
    subscribeDirectorState,
    updateDirectorSettings,
} from '../../../services/lyricDirector/state';
import { listDirectorModes, describeHostDirectorMode } from '../../../services/lyricDirector/catalog';
import { getVisualizerModeLabel, VISUALIZER_REGISTRY } from '@/components/visualizer/registry';
import {
    testConfiguredAiConnection,
    type AiConnectionTestResult,
} from '../../../services/aiThemeClient';
import { Button, TextField } from '@/components/ui';
import { ensureMachineCode } from '../../../services/foliaMachineCode';
import { fetchFoliaCredits, type FoliaCredits } from '../../../services/foliaCredits';
import { FOLIA_WORK_SHARE_PAGE_URL } from '../../../../shared/ai/foliawork.mjs';
import { openExternalUrl } from '../../../utils/openExternalUrl';
import { FoliaCheckinButton, copyMachineCode } from './pages/ai/FoliaCreditsRow';

// src/components/modal/settings/AiProviderSettings.tsx
// 安卓/网页版没有 Electron 主进程，AI 凭据由用户自己填并保存在本机 —— 这是「AI 主题」在
// App 里能用的前提（generateThemeFromLyrics 的第三条路，见 services/aiThemeClient.ts）。
// 桌面版沿用主进程的 AI 设置，这里不参与。
//
// 界面与上游桌面版同一套（服务商一个下拉，字段随服务商变），服务商清单也同一份
// （shared/ai/providerRegistry.mjs）；差别只在凭据放哪 —— 上游交主进程保存，这里即改即存
// 到本机。每家自己的 Key、模型与站点分开记，切过去再切回来都还在。

type AiProviderSettingsProps = {
    settingsCardClass: string;
    isDaylight: boolean;
};

type TestState = 'idle' | 'running' | 'done';

/*
 * A probe key the cache can be asked about. It is a well-known MD5, never
 * written to, so "connected" only ever means "the endpoint answered".
 */
const CLOUD_CACHE_PROBE_KEY = '00000000000000000000000000000000';

/*
 * 选完供应商，下一步就是去拿 Key。
 *
 * 各家开放平台的入口都不好找，而且改过好几次 —— 与其让用户自己去搜，不如把链接
 * 直接摆在选项下面。没有把握的（站点要登录才看得到、或经常改版）就不给，别指错路。
 */
const PROVIDER_CONSOLE_URLS: Partial<Record<AiProviderId, string>> = {
    gemini: 'https://aistudio.google.com/apikey',
    deepseek: 'https://platform.deepseek.com/api_keys',
    openai: 'https://platform.openai.com/api-keys',
    anthropic: 'https://console.anthropic.com/settings/keys',
    kimi: 'https://platform.moonshot.cn/console/api-keys',
    glm: 'https://open.bigmodel.cn/usercenter/apikeys',
    qwen: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key',
    mimo: 'https://platform.xiaomimimo.com/apikey',
};

const AiProviderSettings: React.FC<AiProviderSettingsProps> = ({ settingsCardClass, isDaylight }) => {
    const { t } = useTranslation();
    const [settings, setSettings] = useState(() => readAiSettings());
    const [testState, setTestState] = useState<TestState>('idle');
    const [testResult, setTestResult] = useState<AiConnectionTestResult | null>(null);
    // The cloud cache switch lives next to the credential because that is what
    // it substitutes for — but it works with the credential left empty.
    useSyncExternalStore(subscribeFoliaCloudSettings, getFoliaCloudSettingsVersion);
    const cloudCache = readFoliaCloudSettings();
    const [cacheProbe, setCacheProbe] = useState<{ state: TestState; ok: boolean; text: string }>({
        state: 'idle',
        ok: false,
        text: '',
    });
    // The director's own switches live in its own persistence, and the panel tab
    // can change them while this card is open — this is only the redraw trigger,
    // the values are read during render.
    useSyncExternalStore(subscribeDirectorState, getDirectorStateVersion);
    const directorSettings = readDirectorSettings();

    /*
     * 剩余额度：进来问一次，「刷新」再问一次。
     * 四种状态要分清 —— 没绑定 / 已停用 / 查不到 / 有数字，别糊成一句话。
     */
    const [creditsState, setCreditsState] = React.useState<'loading' | 'ready' | 'unknown'>('loading');
    const [credits, setCredits] = React.useState<FoliaCredits | null>(null);
    const refreshCredits = async (): Promise<void> => {
        setCreditsState('loading');
        const result = await fetchFoliaCredits();
        setCredits(result);
        setCreditsState(result === null ? 'unknown' : 'ready');
    };
    React.useEffect(() => { void refreshCredits(); }, []);

    // 即改即存：没有「保存」按钮，避免用户填完忘了提交。
    const update = (patch: Parameters<typeof writeAiSettings>[0]) => {
        setSettings(writeAiSettings(patch));
        setTestState('idle');
        setTestResult(null);
    };

    const runTest = async () => {
        if (testState === 'running') return;
        setTestState('running');
        setTestResult(null);
        const result = await testConfiguredAiConnection();
        setTestResult(result);
        setTestState('done');
    };

    const runCacheProbe = async () => {
        setCacheProbe({ state: 'running', ok: false, text: '' });
        const startedAt = Date.now();
        try {
            const response = await createAiFetch()(
                resolveAiCloudCacheUrl(STAGE_CACHE_KIND, CLOUD_CACHE_PROBE_KEY),
                { method: 'GET', headers: { Accept: 'application/json' } },
            );
            if (!response.ok) {
                setCacheProbe({
                    state: 'done',
                    ok: false,
                    text: `${t('options.cloudCacheProbeFailed')} HTTP ${response.status}`,
                });
                return;
            }
            await response.json().catch(() => null);
            setCacheProbe({
                state: 'done',
                ok: true,
                text: `${t('options.cloudCacheProbeOk')} · ${Date.now() - startedAt} ms`,
            });
        } catch (error) {
            setCacheProbe({
                state: 'done',
                ok: false,
                text: `${t('options.cloudCacheProbeFailed')} ${String((error as Error)?.message ?? error)}`,
            });
        }
    };

    const fieldClass = 'w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-sm focus:outline-none focus:border-white/30 transition-colors';
    const ghostButtonClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/15 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-default';
    const rowDividerClass = isDaylight ? 'border-black/5' : 'border-white/5';

    /*
     * 这份清单要能划掉**所有**样式，包括 mod 投稿的那些（mod:<modId>:<id>）。catalog 在叶子层，
     * 不认识注册表，所以由这里把 mod 的条目递进去；mod 名字取 entry 的 labelKey/fallback，
     * 与随机池同一个来源，两边叫法不会打架。
     */
    const modModes = VISUALIZER_REGISTRY.filter((entry) => entry.mode.startsWith('mod:'));
    const modModeIds = new Set(modModes.map((entry) => entry.mode));
    const directorModes = listDirectorModes(
        (key) => t(key),
        modModes.map((entry) => describeHostDirectorMode(entry.mode, getVisualizerModeLabel(entry.mode, t))),
    );

    /* The two switches the AI lyric animation director answers to. They sit
     * under the credential because that is what gates them: no key configured,
     * nothing is ever decided. */
    const renderDirectorToggle = (
        label: string,
        description: string,
        active: boolean,
        onChange: (next: boolean) => void,
    ) => (
        <div className="flex items-center justify-between gap-4 text-left">
            <div className="space-y-1 min-w-0">
                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{label}</div>
                <div className="text-xs opacity-50 max-w-[380px]" style={{ color: 'var(--text-secondary)' }}>
                    {description}
                </div>
            </div>
            {/* 开关统一用 kit 那一颗（样子就是原来云缓存这颗），别再就地手写一个。 */}
            <Toggle checked={active} onChange={onChange} label={label} />
        </div>
    );

    const toggleBlockedMode = (mode: string) => {
        const current = readDirectorSettings().blockedModes;
        const next = current.includes(mode)
            ? current.filter((entry) => entry !== mode)
            : [...current, mode];
        updateDirectorSettings({ blockedModes: next });
    };

    /* 一行设置：左边名字，右边控件（与上游桌面版同一个排法）。 */
    const renderRow = (label: string, control: React.ReactNode, hint?: string) => (
        <div className="space-y-1.5 text-left">
            <div className="flex items-center justify-between gap-4">
                <span className="text-sm opacity-70 shrink-0" style={{ color: 'var(--text-secondary)' }}>{label}</span>
                {control}
            </div>
            {hint && (
                <span className="block text-[10px] opacity-45" style={{ color: 'var(--text-secondary)' }}>{hint}</span>
            )}
        </div>
    );

    const provider = settings.provider;
    /*
     * 免费渠道（foliawork）：密钥是本机的机器码，模型与地址写死。
     * 其余服务商照旧 —— 这是「默认选免费」，不是「只能免费」。
     */
    const isFreeChannel = provider === 'foliawork';
    const machineCode = isFreeChannel ? ensureMachineCode() : '';
    const preset = aiPresetOf(provider);
    const protocol = aiProtocolOf(provider);
    const endpoints = preset?.endpoints ?? [];
    const currentBaseUrl = provider === 'custom'
        ? settings.customApiUrl.trim()
        : settings.apiBaseUrls[provider]?.trim() || preset?.baseUrl || '';
    const activeEndpoint = endpoints.find((endpoint) => endpoint.baseUrl === currentBaseUrl);
    const consoleUrl = PROVIDER_CONSOLE_URLS[provider];
    const apiKey = provider === 'gemini' ? settings.geminiApiKey : settings.apiKeys[provider] ?? '';

    const creditsLabel = ((): string => {
        if (creditsState === 'loading') return t('options.aiCreditsLoading');
        if (creditsState === 'unknown') return t('options.aiCreditsUnknown');
        if (!credits?.bound) return t('options.aiCreditsUnbound');
        if (credits.disabled) return t('options.aiCreditsDisabled');
        if (credits.remaining === null) return t('options.aiCreditsUnlimited');
        return t('options.aiCreditsRemaining', { remaining: credits.remaining });
    })();

    return (
        <div className={`rounded-xl border overflow-hidden ${settingsCardClass}`}>
            <div className={`flex flex-wrap items-center justify-between gap-4 p-4 border-b ${rowDividerClass}`}>
                <div className="space-y-1 text-left min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        <Sparkles size={15} className="opacity-70" aria-hidden="true" />
                        {t('ui.aiTheme')}
                    </div>
                    <div className="text-xs opacity-50 max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                        {t('options.aiThemeDesc')}
                    </div>
                </div>
            </div>

            <div className={`p-4 space-y-4 border-b ${rowDividerClass}`}>
                {renderRow(
                    t('options.aiProvider'),
                    <Select<AiProviderId>
                        value={provider}
                        options={AI_PROVIDER_IDS.map((id) => ({ value: id, label: t('options.aiProvider_' + id) }))}
                        onChange={(id) => update({ provider: id })}
                        name={t('options.aiProvider')}
                    />,
                )}
                {endpoints.length > 1 && provider !== 'custom' && renderRow(
                    t('options.aiEndpoint'),
                    <Select
                        value={activeEndpoint?.id ?? ''}
                        options={[
                            ...(activeEndpoint ? [] : [{ value: '', label: currentBaseUrl }]),
                            ...endpoints.map((endpoint) => ({ value: endpoint.id, label: t('options.aiEndpoint_' + endpoint.id) })),
                        ]}
                        onChange={(id) => {
                            const next = endpoints.find((endpoint) => endpoint.id === id);
                            if (next) update({ apiBaseUrls: { ...settings.apiBaseUrls, [provider]: next.baseUrl } });
                        }}
                        name={t('options.aiEndpoint')}
                    />,
                )}
                {provider === 'custom' && renderRow(
                    t('options.openaiApiUrl'),
                    <TextField
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={settings.customApiUrl}
                        onChange={(event) => update({ customApiUrl: event.target.value })}
                        placeholder="https://api.openai.com/v1 or https://api.deepseek.com"
                        className={fieldClass}
                        style={{ color: 'var(--text-primary)' }}
                    />,
                )}
                {provider === 'gemini' && renderRow(
                    t('options.geminiApiUrl'),
                    <TextField
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={settings.geminiApiUrl}
                        onChange={(event) => update({ geminiApiUrl: event.target.value })}
                        placeholder={GEMINI_DEFAULT_API_BASE}
                        className={fieldClass}
                        style={{ color: 'var(--text-primary)' }}
                    />,
                    t('options.geminiApiUrlDesc'),
                )}

                {!isFreeChannel && (
                <div className="space-y-1.5 text-left">
                    <label className="block space-y-1">
                        <span className="text-sm opacity-70" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.aiApiKey')}
                            {provider !== 'custom' && preset?.label ? ` · ${preset.label}` : ''}
                        </span>
                        <TextField
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            value={apiKey}
                            onChange={(event) => update(provider === 'gemini'
                                ? { geminiApiKey: event.target.value }
                                : { apiKeys: { ...settings.apiKeys, [provider]: event.target.value } })}
                            placeholder={provider === 'gemini' ? 'AIza...' : 'sk-...'}
                            className={fieldClass}
                            style={{ color: 'var(--text-primary)' }}
                        />
                    </label>
                    {consoleUrl && (
                        <a
                            href={consoleUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-[11px] font-medium underline underline-offset-2 opacity-60 hover:opacity-100 transition-opacity"
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            {t('options.openProviderConsole', { provider: t('options.aiProvider_' + provider) })}
                            <ExternalLink size={11} aria-hidden="true" />
                        </a>
                    )}
                </div>
                )}

                {/* 免费渠道：机器码（可复制）+ 剩余额度 + 贡献账号 */}
                {isFreeChannel && (
                    <>
                        <div className="space-y-1.5 text-left">
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-sm opacity-70 shrink-0" style={{ color: 'var(--text-secondary)' }}>
                                    {t('options.aiMachineCodeTitle')}
                                </span>
                                <code className="text-[11px] break-all text-right select-all" style={{ color: 'var(--text-primary)' }}>
                                    {machineCode}
                                </code>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    onClick={() => void copyMachineCode(machineCode, t)}
                                    className={ghostButtonClass}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    <Copy size={13} />
                                    {t('options.aiMachineCodeCopy')}
                                </Button>
                                <Button
                                    onClick={() => void refreshCredits()}
                                    className={ghostButtonClass}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    <RefreshCw size={13} className={creditsState === 'loading' ? 'animate-spin' : ''} />
                                    {t('options.aiCreditsRefresh')}
                                </Button>
                            </div>
                            <span className="block text-[10px] opacity-45" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.aiMachineCodeHint')}
                            </span>
                        </div>
                        {renderRow(
                            t('options.aiCreditsTitle'),
                            <span className="text-[11px] opacity-70" style={{ color: 'var(--text-primary)' }}>{creditsLabel}</span>,
                            t('options.aiCreditsNote'),
                        )}
                        {/*
                            签到：只有确认「已经绑定」才让点（没绑就签到等于对着空气点按钮），
                            点开是内嵌的 Turnstile 小框，通过后由 koishi 那边加积分。
                        */}
                        <FoliaCheckinButton credits={credits} onCheckedIn={() => { void refreshCredits(); }} />
                        <div className="space-y-1.5 text-left">
                            <Button
                                onClick={() => { void openExternalUrl(FOLIA_WORK_SHARE_PAGE_URL); }}
                                className={ghostButtonClass}
                                style={{ color: 'var(--text-primary)' }}
                            >
                                <ExternalLink size={13} />
                                {t('options.aiShareAccountAction')}
                            </Button>
                            <span className="block text-[10px] opacity-45" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.aiShareAccountWarning')}
                            </span>
                        </div>
                    </>
                )}

                {!isFreeChannel && protocol !== 'gemini' && renderRow(
                    t('options.aiModel'),
                    <TextField
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={settings.apiModels[provider] ?? ''}
                        onChange={(event) => update({ apiModels: { ...settings.apiModels, [provider]: event.target.value } })}
                        placeholder={preset?.recommendedModel || 'gpt-5.6-luna / deepseek-v4-flash'}
                        className={fieldClass}
                        style={{ color: 'var(--text-primary)' }}
                    />,
                    t('options.openaiApiModelDesc'),
                )}
                {protocol === 'openai' && preset?.temperature && renderRow(
                    t('options.openaiApiTemperature'),
                    <TextField
                        type="number"
                        min={preset.temperature.min}
                        max={preset.temperature.max}
                        step="0.1"
                        value={settings.apiTemperature}
                        onChange={(event) => update({ apiTemperature: event.target.value })}
                        placeholder="0.7"
                        className={`${fieldClass} max-w-[140px]`}
                        style={{ color: 'var(--text-primary)' }}
                    />,
                )}
                {!isFreeChannel && protocol === 'openai' && preset?.stream && (
                    <div className="flex items-center justify-between gap-4 text-left">
                        <div className="space-y-1 min-w-0">
                            <div className="text-sm opacity-70" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.openaiApiStream')}
                            </div>
                            <div className="text-xs opacity-50 max-w-[380px]" style={{ color: 'var(--text-secondary)' }}>
                                {t('options.openaiApiStreamDesc')}
                            </div>
                        </div>
                        <Toggle
                            checked={settings.apiStream}
                            onChange={(next) => update({ apiStream: next })}
                            label={t('options.openaiApiStream')}
                        />
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-3 text-left">
                    <Button
                        onClick={() => void runTest()}
                        disabled={testState === 'running'}
                        className={ghostButtonClass}
                        style={{ color: 'var(--text-primary)' }}
                    >
                        {testState === 'running'
                            ? <Loader2 size={13} className="animate-spin" />
                            : <Sparkles size={13} />}
                        {testState === 'running' ? t('options.aiTestRunning') : t('options.aiTestConnection')}
                    </Button>
                    {testState === 'done' && testResult && (
                        <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                            {testResult.ok
                                ? <Check size={12} className="text-green-400" />
                                : <X size={12} className="text-red-400" />}
                            {testResult.ok
                                ? `${t('options.aiTestSuccess')} · ${t('options.aiTestDuration')} ${testResult.durationMs} ms`
                                    + `${testResult.model ? ` · ${t('options.aiTestModel')} ${testResult.model}` : ''}`
                                : `${t('options.aiTestFailed')}${testResult.error ? `: ${testResult.error}` : ''}`}
                        </span>
                    )}
                </div>
                {testState === 'done' && testResult?.ok && testResult.reply && (
                    <div className="text-[11px] opacity-55 break-words text-left" style={{ color: 'var(--text-secondary)' }}>
                        {testResult.reply}
                    </div>
                )}

                <div className="text-[10px] opacity-45 text-left" style={{ color: 'var(--text-secondary)' }}>
                    {t('options.aiKeyStoredLocally')}
                </div>

                <div className="space-y-3 pt-1 text-left">
                    {renderDirectorToggle(
                        t('aiDirector.allowAutoMode'),
                        t('aiDirector.allowAutoModeDesc'),
                        directorSettings.autoOnSongChange,
                        (next) => updateDirectorSettings({ autoOnSongChange: next }),
                    )}
                    {renderDirectorToggle(
                        t('aiDirector.allowAutoParams'),
                        t('aiDirector.allowAutoParamsDesc'),
                        directorSettings.applyParams,
                        (next) => updateDirectorSettings({ applyParams: next }),
                    )}
                </div>

                <div className="space-y-2 pt-1 text-left">
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('aiDirector.blockedModes')}
                    </div>
                    <div className="text-xs opacity-50 max-w-[380px]" style={{ color: 'var(--text-secondary)' }}>
                        {t('aiDirector.blockedModesDesc')}
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {directorModes.map((mode) => {
                            const blocked = directorSettings.blockedModes.includes(mode.id);
                            return (
                                <Button
                                    key={mode.id}
                                    aria-pressed={blocked}
                                    onClick={() => toggleBlockedMode(mode.id)}
                                    title={mode.hint}
                                    className={`px-2.5 py-1 rounded-full border text-xs transition-opacity ${modModeIds.has(mode.id) ? 'border-[color:var(--st-accent)]/40' : (isDaylight ? 'border-black/15' : 'border-white/15')} ${blocked ? 'line-through opacity-55' : 'opacity-90'}`}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    {mode.label}
                                </Button>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* 云缓存：紧挨着 AI 歌词配置下面，默认打开；没填 Key 也能拉。
                不再单独套一张带边框的卡 —— 外层已经是 kit 的 Group 卡片，这里再套一层
                就是三层边框。改成组内的一行，用一条发丝线和上面分开。 */}
            <div className="p-4">
                <div className={`flex flex-wrap items-center justify-between gap-4 pb-4 border-b ${rowDividerClass}`}>
                    <div className="space-y-1 text-left min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            <Cloud size={15} className="opacity-70" aria-hidden="true" />
                            {t('options.cloudCache')}
                        </div>
                        <div className="text-xs opacity-50 max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.cloudCacheDesc')}
                        </div>
                    </div>
                    {/* 开关统一用 kit 那一颗：这一颗的样子本来就是照它定的。 */}
                    <Toggle
                        checked={cloudCache.enabled}
                        onChange={() => updateFoliaCloudSettings({ enabled: !cloudCache.enabled })}
                        label={t('options.cloudCache')}
                    />
                </div>

                <div className="pt-4 space-y-3">
                    <label className="block space-y-1 text-left">
                        <span className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.cloudCacheBaseUrl')}
                        </span>
                        <TextField
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={cloudCache.baseUrl}
                            onChange={(event) => updateFoliaCloudSettings({ baseUrl: event.target.value })}
                            placeholder="https://apif.tangbot.xyz"
                            className={fieldClass}
                            style={{ color: 'var(--text-primary)' }}
                        />
                        <span className="block text-[10px] opacity-45" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.cloudCacheBaseUrlDesc')}
                        </span>
                    </label>

                    <div className="flex flex-wrap items-center gap-3 text-left">
                        <Button
                            onClick={() => void runCacheProbe()}
                            disabled={cacheProbe.state === 'running'}
                            className={ghostButtonClass}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {cacheProbe.state === 'running'
                                ? <Loader2 size={13} className="animate-spin" />
                                : <Cloud size={13} />}
                            {cacheProbe.state === 'running'
                                ? t('options.aiTestRunning')
                                : t('options.cloudCacheProbe')}
                        </Button>
                        {cacheProbe.state === 'done' && (
                            <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                {cacheProbe.ok
                                    ? <Check size={12} className="text-green-400" />
                                    : <X size={12} className="text-red-400" />}
                                {cacheProbe.text}
                            </span>
                        )}
                    </div>

                    <div className="text-[10px] opacity-45 text-left" style={{ color: 'var(--text-secondary)' }}>
                        {t('options.cloudCachePrivacy')}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AiProviderSettings;
