import { OnlineProviderError } from '../../types/onlineMusic';
import type { OnlineMusicProvider, OnlineProviderId, ProviderCapabilities } from '../../types/onlineMusic';
import type { SongResult } from '../../types';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { neteaseProvider } from './netease/neteaseProvider';
import { kugouProvider } from './kugou/kugouProvider';
import { qqProvider } from './qq/qqProvider';
import { bodianProvider } from './bodian/bodianProvider';
import { ytmProvider } from './ytm/ytmProvider';
import { spotifyProvider } from './spotify/spotifyProvider';
/*
 * 汽水有两套实现：fork 这份（`./qishuiProvider`，走本机 nativeBridge 的手机协议扫码，
 * 车机/手机两套协议都在这里）与上游 v0.7.22 新增的 `./qishui/qishuiProvider`（桌面端
 * electron + qishui-music-api 包那条）。**只能注册一份**，否则同 id 互相盖掉。
 * 保留 fork 这份：安卓包上没有 electron，且手机协议的扫码/Cookie 修复只在这边。
 * 上游那份连同 `test/unit/qishui/` 先留着（vite-env 的桥类型还引它），不注册。
 */
import { qishuiProvider } from './qishuiProvider';
import { appleMusicProvider } from './appleMusic/appleMusicProvider';
// 上游 fnmusic 那份没有 import：注册的是本 fork 的 feiniu，见文件末尾的说明。
import { feiniuProvider } from './feiniuProvider';
import { installLxAudioRouting, lxmusicProvider } from './lxmusic/lxmusicProvider';

// src/services/onlineMusic/providerRegistry.ts

const providers = new Map<OnlineProviderId, OnlineMusicProvider>();

// Folium mods register and remove providers at runtime, after the UI first read the list. The version
// lets that UI (through omni, see useOnlineProviderPlatform) notice instead of keeping a stale list.
let registryVersion = 0;
const registryListeners = new Set<() => void>();

const announceRegistryChange = () => {
    registryVersion += 1;
    registryListeners.forEach(listener => listener());
};

export const registerOnlineMusicProvider = (provider: OnlineMusicProvider): void => {
    providers.set(provider.id, provider);
    announceRegistryChange();
};

export const unregisterOnlineMusicProvider = (providerId: OnlineProviderId): void => {
    if (providers.delete(providerId)) announceRegistryChange();
};

/** Bumped by every registration and removal. */
export const getOnlineMusicProviderRegistryVersion = (): number => registryVersion;

/** Calls `listener` after every registration and removal; returns the unsubscribe function. */
export const subscribeOnlineMusicProviderRegistry = (listener: () => void): (() => void) => {
    registryListeners.add(listener);
    return () => {
        registryListeners.delete(listener);
    };
};

export const getOnlineMusicProvider = (providerId: OnlineProviderId): OnlineMusicProvider | null => (
    providers.get(providerId) || null
);

export const listOnlineMusicProviders = (): OnlineMusicProvider[] => Array.from(providers.values());

export const requireOnlineMusicProvider = (providerId: OnlineProviderId): OnlineMusicProvider => {
    const provider = getOnlineMusicProvider(providerId);
    if (!provider) {
        throw new OnlineProviderError('unavailable', `Online music provider is not registered: ${providerId}`, providerId);
    }
    return provider;
};

export const providerSupports = (
    provider: OnlineMusicProvider | null | undefined,
    capability: keyof ProviderCapabilities,
): boolean => Boolean(provider?.capabilities[capability]);

export const getOnlineMusicProviderForSong = (song: SongResult): OnlineMusicProvider | null => {
    const sourceRef = getPlaybackSourceRef(song);
    return sourceRef.kind === 'online' ? getOnlineMusicProvider(sourceRef.providerId) : null;
};

// A provider can keep its audio in a cache of its own (`playback.keepAudio`): Spotify's files are
// encrypted where Spotify keeps them, and the desktop side keeps them on disk that way, without
// their key. Nothing writes such a song to the media cache; its audio is asked of the provider's
// cache instead, by the URL the song plays from, and a kept file is read by reading that URL.
export const keepsOwnSongAudio = (song: SongResult): boolean => {
    const playback = getOnlineMusicProviderForSong(song)?.playback;
    return Boolean(playback?.keepAudio && playback.hasKeptAudio);
};

// A provider that cannot be asked, or fails in any way, holds nothing.
const askProviderCache = async (song: SongResult, ask: 'hasKeptAudio' | 'keepAudio', url: string): Promise<boolean> => {
    try {
        return Boolean(await getOnlineMusicProviderForSong(song)?.playback?.[ask]?.(url));
    } catch {
        return false;
    }
};

/** Whether the provider's own cache holds the file `url` plays. */
export const hasProviderKeptSongAudio = (song: SongResult, url: string): Promise<boolean> => askProviderCache(song, 'hasKeptAudio', url);

/** Puts the file `url` plays into the provider's own cache; resolves to whether it is there. */
export const keepProviderSongAudio = (song: SongResult, url: string): Promise<boolean> => askProviderCache(song, 'keepAudio', url);

export const canPlayOnlineMusicSong = (song: SongResult): boolean => {
    const provider = getOnlineMusicProviderForSong(song);
    return (providerSupports(provider, 'playback') && Boolean(provider?.playback))
        || (providerSupports(provider, 'externalPlayback') && Boolean(provider?.externalPlayback) && provider?.externalPlayback?.canPlay?.(song) !== false);
};

/** The provider sounds this song in a player of its own outside this app. */
export const canPlaySongExternally = (song: SongResult): boolean => {
    const provider = getOnlineMusicProviderForSong(song);
    return providerSupports(provider, 'externalPlayback') && Boolean(provider?.externalPlayback);
};

export const requireOnlineMusicProviderForSong = (song: SongResult): OnlineMusicProvider => {
    const sourceRef = getPlaybackSourceRef(song);
    if (sourceRef.kind !== 'online') {
        throw new OnlineProviderError('unsupported', `Song is not from an online provider: ${sourceRef.kind}`);
    }
    return requireOnlineMusicProvider(sourceRef.providerId);
};

registerOnlineMusicProvider(neteaseProvider);
registerOnlineMusicProvider(kugouProvider);
registerOnlineMusicProvider(qqProvider);
registerOnlineMusicProvider(bodianProvider);
registerOnlineMusicProvider(ytmProvider);
registerOnlineMusicProvider(spotifyProvider);

registerOnlineMusicProvider(qishuiProvider);

registerOnlineMusicProvider(appleMusicProvider);
// 飞牛只注册本 fork 那一份。
//
// 上游 v0.7.26 带来了另一份 `fnmusic`（fnmusic/ 目录）：凭据交给主进程 safeStorage，播放走
// `folia-fnmusic://` 自定义协议 —— 只有 Electron 有主进程，所以它只在桌面上成立，安卓上发不出
// 请求。本 fork 的 `feiniu`（feiniu* 根目录）凭据留在 Web 会话存储，请求走 foliaNative 的原生
// HTTP（安卓 OkHttp），没插件时回落到 fetch，桌面与安卓都能用。
//
// 两份都注册会让平台列里出现两个「飞牛」，用户分不清该点哪个，所以只留本 fork 这一份。上游那份
// 的文件保留着（未注册），将来若要做桌面专属的凭据加固可以在这里换回来。
// 注意：`fnmusic` 的 i18n 键仍被本用于飞牛表单（fnmusic.serverUrl / fnmusic.username 等），
// 那是共用文案，不是「注册了 fnmusic 平台」。
registerOnlineMusicProvider(feiniuProvider);
// 洛雪音源：用户导入的自定义音源聚合 provider（搜索复用原生 provider，播放 / 歌词用导入的音源续地址）。
registerOnlineMusicProvider(lxmusicProvider);
// 装上 omni 的「取地址之前」扩展点：导入音源后，其它 provider 的歌也先问音源，
// 音源交不出地址才回落到各家自己的播放接口。没导入音源时这层直接让路。
installLxAudioRouting();
