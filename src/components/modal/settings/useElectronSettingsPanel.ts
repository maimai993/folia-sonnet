import { startTransition, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ThemeGenerationSource } from '../../../services/themePreferences';
import { openExternalUrl } from '../../../utils/openExternalUrl';
import { isCapacitorAndroid } from '../../../platform/runtime';
import { parseNumberText } from './kit';

// src/components/modal/settings/useElectronSettingsPanel.ts
// 设置窗口里主进程那一组：AI 连接的设置草稿、保存状态、更新状态、Discord 在线状态，以及缓存目录。
// 从 SettingsModal 拆出来：状态和用它的人放在一起，窗口本身只组装页面。

export const DEFAULT_OPENAI_TEMPERATURE = '0.7';
const QUARK_DOWNLOAD_URL = 'https://pan.quark.cn/s/6e4c6fa3bc6f';
const BAIDU_DOWNLOAD_URL = 'https://pan.baidu.com/s/1f0x3g-8PMcNCO-TJ5z1rPw?pwd=flia';
const DEFAULT_UPDATE_CHANNEL: 'realeco' | 'limo' | 'cielo' | 'internal' = __APP_RELEASE_CHANNEL__ === 'limo'
    ? 'limo'
    : __APP_RELEASE_CHANNEL__ === 'cielo'
        ? 'cielo'
        : __APP_RELEASE_CHANNEL__ === 'internal'
            ? 'internal'
            : 'realeco';

/** Synchronous on purpose: the first render has to know whether the bridge is there before the isElectron state settles. */
const hasElectronBridge = () => typeof window !== 'undefined' && typeof (window as any).electron?.platform === 'string';

type ElectronSettingsPanelParams = {
    themeGenerationSource: ThemeGenerationSource;
    onChangeThemeGenerationSource: (source: ThemeGenerationSource) => void;
};

export const useElectronSettingsPanel = ({
    themeGenerationSource,
    onChangeThemeGenerationSource,
}: ElectronSettingsPanelParams) => {
    const { t } = useTranslation();

    // Electron Settings State
    // Seeded synchronously so a remembered desktop/mods section has its title on the first frame; the effect below still confirms it.
    const [isElectron, setIsElectron] = useState(hasElectronBridge);
    const [electronSettings, setElectronSettings] = useState({
        GEMINI_API_KEY: '',
        GEMINI_API_URL: '',
        // Blank: the default model, worked out when the request is made (nothing is written back).
        GEMINI_API_MODEL: '',
        AI_PROVIDER_PRESET: '',
        OPENAI_API_KEY: '',
        OPENAI_API_URL: '',
        OPENAI_API_MODEL: '',
        OPENAI_API_TEMPERATURE: DEFAULT_OPENAI_TEMPERATURE,
        OPENAI_API_STREAM: false,
        AI_PROVIDER: 'gemini',
        USE_SYSTEM_PROXY_FOR_AI: false,
        ENABLE_UPDATE_CHECK: true,
        ENABLE_AUTO_UPDATE: false,
        UPDATE_CHANNEL: DEFAULT_UPDATE_CHANNEL,
        STAGE_MODE_SOURCE: 'stage-api',
        DISCORD_RICH_PRESENCE_ENABLED: false,
    });
    const [electronSettingsLoaded, setElectronSettingsLoaded] = useState(false);
    // Keys stay in the main process; the renderer only knows which ones are saved, and the endpoint
    // the OpenAI-compatible key is bound to. The GEMINI_API_KEY / OPENAI_API_KEY fields in
    // electronSettings are drafts of a replacement key.
    const [savedElectronAiCredentials, setSavedElectronAiCredentials] = useState({
        AI_PROVIDER: 'gemini',
        GEMINI_API_KEY: false,
        OPENAI_API_KEY: false,
        OPENAI_API_KEY_ENDPOINT: null as string | null,
    });
    const [electronSaveStatus, setElectronSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
    const [updateStatus, setUpdateStatus] = useState<ElectronUpdateStatus | null>(null);
    const [discordPresenceStatus, setDiscordPresenceStatus] = useState<ElectronDiscordPresenceStatus | null>(null);
    const [cacheDirectory, setCacheDirectory] = useState<string>('');
    const [cacheDirectoryIsDefault, setCacheDirectoryIsDefault] = useState(true);
    const [cacheDirectoryStatus, setCacheDirectoryStatus] = useState<'idle' | 'choosing'>('idle');
    const isElectronRuntime = typeof window !== 'undefined' && typeof window.electron?.platform === 'string';
    const savedAiApiKey = savedElectronAiCredentials.AI_PROVIDER === 'openai'
        ? savedElectronAiCredentials.OPENAI_API_KEY
        : savedElectronAiCredentials.GEMINI_API_KEY;
    const aiApiKeyStatus: 'loading' | 'configured' | 'missing' = !isElectronRuntime
        ? 'configured'
        : !electronSettingsLoaded
            ? 'loading'
            : savedAiApiKey
                ? 'configured'
                : 'missing';

    useEffect(() => {
        if (aiApiKeyStatus === 'missing' && themeGenerationSource === 'ai') {
            onChangeThemeGenerationSource('cover');
        }
    }, [aiApiKeyStatus, onChangeThemeGenerationSource, themeGenerationSource]);

    // The four answers land while the window is still opening, and each one alone rendered the whole
    // window again. Read together and applied as one transition, they render it once, between frames.
    // Together also because the key's status is read from the settings and their "loaded" at once.
    useEffect(() => {
        const electron = (window as any).electron;
        // 只认 platform：安卓端的模组 shim 没有 platform，也没有 getSettings /
        // getCacheDirectory 这些主进程方法 —— 放过去会直接抛。
        if (!electron || typeof electron.platform !== 'string') {
            return;
        }
        setIsElectron(true);
        void Promise.allSettled([
            electron.getSettings(),
            electron.getCacheDirectory(),
            electron.getUpdateStatus?.(),
            electron.getDiscordPresenceStatus?.(),
        ]).then(([settingsAnswer, cacheDirectoryAnswer, updateAnswer, discordAnswer]) => {
            const settings = settingsAnswer.status === 'fulfilled' ? settingsAnswer.value : null;
            const cacheDirectoryResult: ElectronCacheDirectoryResult | null = cacheDirectoryAnswer.status === 'fulfilled' ? cacheDirectoryAnswer.value : null;
            startTransition(() => {
                if (settings) {
                    const { AI_API_KEYS_CONFIGURED: configuredKeys, OPENAI_API_KEY_ENDPOINT: openaiKeyEndpoint, ...rest } = settings;
                    setElectronSettings(prev => ({
                        ...prev,
                        ...rest,
                        OPENAI_API_TEMPERATURE: String(rest.OPENAI_API_TEMPERATURE ?? '').trim() || DEFAULT_OPENAI_TEMPERATURE,
                    }));
                    setSavedElectronAiCredentials({
                        AI_PROVIDER: settings.AI_PROVIDER === 'openai' ? 'openai' : 'gemini',
                        GEMINI_API_KEY: configuredKeys?.GEMINI_API_KEY === true,
                        OPENAI_API_KEY: configuredKeys?.OPENAI_API_KEY === true,
                        OPENAI_API_KEY_ENDPOINT: typeof openaiKeyEndpoint === 'string' ? openaiKeyEndpoint : null,
                    });
                }
                setElectronSettingsLoaded(true);
                if (cacheDirectoryResult?.path) {
                    setCacheDirectory(cacheDirectoryResult.path);
                    setCacheDirectoryIsDefault(cacheDirectoryResult.isDefault);
                }
                if (electron.getUpdateStatus && updateAnswer.status === 'fulfilled') {
                    setUpdateStatus(updateAnswer.value as ElectronUpdateStatus);
                }
                if (electron.getDiscordPresenceStatus && discordAnswer.status === 'fulfilled') {
                    setDiscordPresenceStatus(discordAnswer.value as ElectronDiscordPresenceStatus);
                }
            });
        });
    }, []);

    useEffect(() => {
        if (!window.electron?.onUpdateStatusChanged) {
            return;
        }

        return window.electron.onUpdateStatusChanged((status) => {
            setUpdateStatus(status);
        });
    }, []);

    useEffect(() => {
        if (!window.electron?.onDiscordPresenceStatusChanged) {
            return;
        }

        return window.electron.onDiscordPresenceStatusChanged((status) => {
            setDiscordPresenceStatus(status);
        });
    }, []);

    useEffect(() => {
        if (!updateStatus?.availableVersion || updateStatus.updateSeen || !window.electron?.markUpdateSeen) {
            return;
        }

        window.electron.markUpdateSeen(updateStatus.availableVersion).then(setUpdateStatus).catch(() => {
            // Seeing the settings panel should never fail the panel itself.
        });
    }, [updateStatus?.availableVersion, updateStatus?.updateSeen]);

    const saveElectronSettings = async () => {
        // 只认 platform：安卓端的模组 shim 没有 saveSettings。
        const bridge = (window as any).electron;
        if (bridge && typeof bridge.platform === 'string') {
            // What is saved is the number that was typed, so "0,7" is kept as 0.7 and the main process
            // reads it as that; anything that is not a number from 0 to 2 falls back to the default.
            const configuredTemperature = parseNumberText(electronSettings.OPENAI_API_TEMPERATURE);
            const temperature = configuredTemperature !== null && configuredTemperature >= 0 && configuredTemperature <= 2
                ? String(configuredTemperature)
                : DEFAULT_OPENAI_TEMPERATURE;
            setElectronSaveStatus('saving');
            setElectronSettings(prev => ({ ...prev, OPENAI_API_TEMPERATURE: temperature }));
            // Only a newly typed key is sent; an empty field keeps the saved one (clearing is its own action).
            const geminiKeyDraft = electronSettings.GEMINI_API_KEY.trim();
            const openaiKeyDraft = electronSettings.OPENAI_API_KEY.trim();
            if (geminiKeyDraft) {
                await (window as any).electron.saveSettings('GEMINI_API_KEY', geminiKeyDraft);
            }
            // Gemini 的地址没有 key 绑定，随便什么顺序；留空存空串 = 用默认地址。
            await (window as any).electron.saveSettings('GEMINI_API_URL', electronSettings.GEMINI_API_URL);
            // URL before key: a new OpenAI-compatible key is bound to the URL saved at that moment.
            await (window as any).electron.saveSettings('OPENAI_API_URL', electronSettings.OPENAI_API_URL);
            if (openaiKeyDraft) {
                await (window as any).electron.saveSettings('OPENAI_API_KEY', openaiKeyDraft);
            }
            await (window as any).electron.saveSettings('OPENAI_API_MODEL', electronSettings.OPENAI_API_MODEL);
            await (window as any).electron.saveSettings('OPENAI_API_TEMPERATURE', temperature);
            await (window as any).electron.saveSettings('OPENAI_API_STREAM', electronSettings.OPENAI_API_STREAM === true);
            await (window as any).electron.saveSettings('GEMINI_API_MODEL', electronSettings.GEMINI_API_MODEL);
            await (window as any).electron.saveSettings('AI_PROVIDER_PRESET', electronSettings.AI_PROVIDER_PRESET);
            await (window as any).electron.saveSettings('AI_PROVIDER', electronSettings.AI_PROVIDER);
            await (window as any).electron.saveSettings('USE_SYSTEM_PROXY_FOR_AI', electronSettings.USE_SYSTEM_PROXY_FOR_AI);
            await (window as any).electron.saveSettings('ENABLE_UPDATE_CHECK', electronSettings.ENABLE_UPDATE_CHECK);
            await (window as any).electron.saveSettings('ENABLE_AUTO_UPDATE', electronSettings.ENABLE_AUTO_UPDATE);
            await (window as any).electron.saveSettings('UPDATE_CHANNEL', electronSettings.UPDATE_CHANNEL);
            const savedSettings = await (window as any).electron.saveSettings('DISCORD_RICH_PRESENCE_ENABLED', electronSettings.DISCORD_RICH_PRESENCE_ENABLED);
            const configuredKeys = savedSettings?.AI_API_KEYS_CONFIGURED;
            setSavedElectronAiCredentials({
                AI_PROVIDER: electronSettings.AI_PROVIDER === 'openai' ? 'openai' : 'gemini',
                GEMINI_API_KEY: configuredKeys?.GEMINI_API_KEY === true,
                OPENAI_API_KEY: configuredKeys?.OPENAI_API_KEY === true,
                OPENAI_API_KEY_ENDPOINT: typeof savedSettings?.OPENAI_API_KEY_ENDPOINT === 'string'
                    ? savedSettings.OPENAI_API_KEY_ENDPOINT
                    : null,
            });
            // Drop the saved drafts so the field goes back to the "saved" placeholder; keep anything typed meanwhile.
            setElectronSettings(prev => ({
                ...prev,
                GEMINI_API_KEY: prev.GEMINI_API_KEY.trim() === geminiKeyDraft ? '' : prev.GEMINI_API_KEY,
                OPENAI_API_KEY: prev.OPENAI_API_KEY.trim() === openaiKeyDraft ? '' : prev.OPENAI_API_KEY,
            }));
            setElectronSaveStatus('saved');
            setTimeout(() => setElectronSaveStatus('idle'), 2000);
        }
    };

    const handleClearAiApiKey = async (key: 'GEMINI_API_KEY' | 'OPENAI_API_KEY') => {
        if (!window.electron?.saveSettings) {
            return;
        }
        const settings = await window.electron.saveSettings(key, '');
        setSavedElectronAiCredentials(prev => ({
            ...prev,
            [key]: settings?.AI_API_KEYS_CONFIGURED?.[key] === true,
            OPENAI_API_KEY_ENDPOINT: typeof settings?.OPENAI_API_KEY_ENDPOINT === 'string' ? settings.OPENAI_API_KEY_ENDPOINT : null,
        }));
        setElectronSettings(prev => ({ ...prev, [key]: '' }));
    };

    const handleToggleDiscordPresence = async (enabled: boolean) => {
        const nextSettings = {
            ...electronSettings,
            DISCORD_RICH_PRESENCE_ENABLED: enabled,
        };
        setElectronSettings(nextSettings);
        await window.electron?.saveSettings?.('DISCORD_RICH_PRESENCE_ENABLED', enabled);
        const status = await window.electron?.getDiscordPresenceStatus?.();
        if (status) {
            setDiscordPresenceStatus(status);
        }
    };

    const handleToggleUpdateCheck = async () => {
        if (!window.electron?.saveSettings) {
            return;
        }

        const nextEnabled = !electronSettings.ENABLE_UPDATE_CHECK;
        const nextSettings = {
            ...electronSettings,
            ENABLE_UPDATE_CHECK: nextEnabled,
            ENABLE_AUTO_UPDATE: nextEnabled ? electronSettings.ENABLE_AUTO_UPDATE : false,
        };

        setElectronSettings(nextSettings);
        await window.electron.saveSettings('ENABLE_UPDATE_CHECK', nextSettings.ENABLE_UPDATE_CHECK);
        if (!nextSettings.ENABLE_AUTO_UPDATE) {
            await window.electron.saveSettings('ENABLE_AUTO_UPDATE', false);
        }

        const status = await window.electron.getUpdateStatus?.();
        if (status) {
            setUpdateStatus(status);
        }
    };

    const handleToggleAutoUpdate = async () => {
        if (!window.electron?.saveSettings || !electronSettings.ENABLE_UPDATE_CHECK || !updateStatus?.autoUpdateSupported) {
            return;
        }

        const nextEnabled = !electronSettings.ENABLE_AUTO_UPDATE;
        setElectronSettings({ ...electronSettings, ENABLE_AUTO_UPDATE: nextEnabled });
        await window.electron.saveSettings('ENABLE_AUTO_UPDATE', nextEnabled);

        const status = await window.electron.getUpdateStatus?.();
        if (status) {
            setUpdateStatus(status);
        }
    };

    const handleUpdateChannelChange = async (channel: 'realeco' | 'limo' | 'cielo') => {
        if (!window.electron?.saveSettings) {
            return;
        }

        setElectronSettings((current) => ({ ...current, UPDATE_CHANNEL: channel }));
        await window.electron.saveSettings('UPDATE_CHANNEL', channel);

        const status = await window.electron.getUpdateStatus?.();
        if (status) {
            setUpdateStatus(status);
        }
    };


    const handleCheckForUpdates = async () => {
        if (!window.electron?.checkForUpdates) {
            return;
        }

        const status = await window.electron.checkForUpdates();
        setUpdateStatus(status);
    };

    const handleDownloadUpdate = async () => {
        if (!window.electron?.downloadUpdate) {
            return;
        }

        const status = await window.electron.downloadUpdate();
        setUpdateStatus(status);
    };

    const handleInstallUpdate = async () => {
        await window.electron?.quitAndInstallUpdate?.();
    };

    const handleOpenDownloadUrl = async (url: string) => {
        // Capacitor 没有 window.open 的可用落点，统一交给 openExternalUrl 走系统浏览器。
        if (isCapacitorAndroid()) {
            await openExternalUrl(url);
            return;
        }

        if (window.electron?.openExternalUrl) {
            await window.electron.openExternalUrl(url);
            return;
        }

        window.open(url, '_blank', 'noopener,noreferrer');
    };

    const handleOpenChinaDownload = () => handleOpenDownloadUrl(QUARK_DOWNLOAD_URL);
    const handleOpenBaiduDownload = () => handleOpenDownloadUrl(BAIDU_DOWNLOAD_URL);

    const handleChooseCacheDirectory = async () => {
        // 只认 platform：安卓端的模组 shim 没有 chooseCacheDirectory。
        if (typeof (window as any).electron?.platform !== 'string') {
            return;
        }

        setCacheDirectoryStatus('choosing');
        try {
            const result = await (window as any).electron.chooseCacheDirectory();
            if (result?.path) {
                setCacheDirectory(result.path);
                setCacheDirectoryIsDefault(result.isDefault);
            }
        } finally {
            setCacheDirectoryStatus('idle');
        }
    };

    const updateBadgeLabel = (() => {
        if (!electronSettings.ENABLE_UPDATE_CHECK || updateStatus?.status === 'disabled') {
            return t('options.updateCheckDisabled') || 'Disabled';
        }

        if (updateStatus?.status === 'checking') {
            return t('options.updateChecking') || 'Checking...';
        }

        if (updateStatus?.availableVersion) {
            return `${t('options.updateAvailable') || 'Found'} v${updateStatus.availableVersion}`;
        }

        if (updateStatus?.status === 'latest') {
            return t('options.updateLatest') || 'Up to date';
        }

        if (updateStatus?.status === 'error') {
            return t('options.updateCheckFailed') || 'Check failed';
        }

        if (updateStatus?.status === 'unsupported') {
            return t('options.updateUnsupported') || 'Unavailable';
        }

        return t('options.updateLatest') || 'Up to date';
    })();
    const canDownloadUpdate = Boolean(
        electronSettings.ENABLE_UPDATE_CHECK &&
        updateStatus?.autoUpdateSupported &&
        updateStatus?.availableVersion &&
        updateStatus.status !== 'downloading' &&
        updateStatus.status !== 'downloaded'
    );
    const canEnableAutoUpdate = Boolean(electronSettings.ENABLE_UPDATE_CHECK && updateStatus?.autoUpdateSupported);

    return {
        isElectron,
        electronSettings,
        setElectronSettings,
        electronSettingsLoaded,
        savedElectronAiCredentials,
        electronSaveStatus,
        updateStatus,
        discordPresenceStatus,
        aiApiKeyStatus,
        cacheDirectory,
        cacheDirectoryIsDefault,
        cacheDirectoryStatus,
        chooseCacheDirectory: handleChooseCacheDirectory,
        updateBadgeLabel,
        canDownloadUpdate,
        canEnableAutoUpdate,
        saveElectronSettings,
        handleClearAiApiKey,
        handleToggleDiscordPresence,
        handleToggleUpdateCheck,
        handleToggleAutoUpdate,
        handleUpdateChannelChange,
        handleCheckForUpdates,
        handleDownloadUpdate,
        handleInstallUpdate,
        handleOpenChinaDownload,
        handleOpenBaiduDownload,
    };
};

export type ElectronSettingsPanel = ReturnType<typeof useElectronSettingsPanel>;
