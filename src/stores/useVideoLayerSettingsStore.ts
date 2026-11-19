import { create } from 'zustand';
import { getStoredBoolean, getStoredString, setStoredBoolean } from './storagePrimitives';
import {
    canPersistVideoLayerFile,
    clearNativeVideoLayerPick,
    clearVideoLayerFileHandle,
    loadVideoLayerFileHandle,
    pickVideoLayerFile,
    readNativeVideoLayerPick,
    readVideoLayerFileHandle,
    saveVideoLayerFileHandle,
} from '../services/videoLayerFile';
import { isCapacitorAndroid } from '../platform/runtime';

// src/stores/useVideoLayerSettingsStore.ts
// The built-in video layer behind the lyrics: a muted video (a picked local file, else a URL) that
// follows playback. Deliberately outside the appearance import/export payload, and therefore out of
// the OBS sources too (they are configured from that same payload). The local file is a handle in
// this window's IndexedDB: a shortcode cannot carry it, and an OBS browser source runs in OBS's own
// browser profile, which cannot open it.
//
// On Android there is no such handle: the native side keeps one copy of the video in the app's
// private directory and this window only holds a loopback URL to it, re-asked on every start
// (its port is assigned per process, so a stored URL would go stale).

export type VideoLayerFit = 'cover' | 'contain';

/** `needs-permission`: a stored pick exists but the browser wants a click to read it again. */
export type VideoLayerLocalFileStatus = 'none' | 'ready' | 'needs-permission';

/**
 * 注入进这一层的地址带这个固定前缀。
 *
 * 它只做一件事：让「这一条是别处临时放进来的」和「这一条是用户自己选的」分得开。
 * 注入方（播放页的 MV 层）写进来时加前缀，清理时只清带前缀的 —— 用户自己设的视频
 * 永远不会被误删。真正交给 `<video>` 之前用 stripInjectPrefix 剥掉。
 */
export const INJECT_URL_PREFIX = 'folia-mv://';

/** 这个地址是不是别处临时注入的。 */
export const isInjectedVideoUrl = (url: string | null | undefined): boolean => (
    typeof url === 'string' && url.startsWith(INJECT_URL_PREFIX)
);

/** 剥掉注入前缀，拿到真正要播的地址；不是注入的就原样返回。 */
export const stripInjectPrefix = (url: string | null | undefined): string | null => {
    if (typeof url !== 'string' || url.length === 0) return null;
    return url.startsWith(INJECT_URL_PREFIX) ? url.slice(INJECT_URL_PREFIX.length) : url;
};

/** 给要注入的地址加上前缀。 */
export const withInjectPrefix = (url: string): string => (
    url.startsWith(INJECT_URL_PREFIX) ? url : `${INJECT_URL_PREFIX}${url}`
);

export const VIDEO_LAYER_OPACITY_BOUNDS = { min: 0.1, max: 1 } as const;
const VIDEO_LAYER_OPACITY_DEFAULT = 0.6;

const VIDEO_LAYER_ENABLED_KEY = 'video_layer_enabled';
const VIDEO_LAYER_URL_KEY = 'video_layer_url';
const VIDEO_LAYER_OPACITY_KEY = 'video_layer_opacity';
const VIDEO_LAYER_FIT_KEY = 'video_layer_fit';

export const clampVideoLayerOpacity = (value: number) => (
    Number.isFinite(value)
        ? Math.max(VIDEO_LAYER_OPACITY_BOUNDS.min, Math.min(VIDEO_LAYER_OPACITY_BOUNDS.max, value))
        : VIDEO_LAYER_OPACITY_DEFAULT
);

const persistString = (key: string, value: string) => {
    if (typeof window !== 'undefined') localStorage.setItem(key, value);
};

/**
 * 视频层开关上一次是被谁写的。
 *
 * 只有「这一段的开关该不该由我们关回去」用得上它：`setVideoLayerEnabled` 不带来源时算用户写的，
 * 用户写一次，租约就放弃回滚资格（见 services/videoLayerEnabledLease）。只活在内存里，
 * 不落盘 —— 重启之后没有任何租约欠着，上个进程是谁写的都没有意义。
 */
export type VideoLayerEnabledWriter = 'user' | 'lease';

export type VideoLayerSettingsState = {
    videoLayerEnabled: boolean;
    /**
     * 开关上一次写入的来源。**只由 setVideoLayerEnabled 写**，别处不要直接 set 它。
     *
     * 初值记成 `'user'`：开关的初值来自 `getStoredBoolean(..., false)`，盘上的值分不清
     * 「上一轮租约写的 false」和「用户自己关的」；而这个进程里还没有过任何租约，
     * 没东西欠着回滚，把初值算成用户的就是唯一不会误关的答案。
     */
    lastSetBy: VideoLayerEnabledWriter;
    videoLayerUrl: string;
    videoLayerOpacity: number;
    videoLayerFit: VideoLayerFit;
    /** Runtime only: what the <video> plays — a blob URL for a picked file, or Android's loopback URL. */
    localFileUrl: string | null;
    localFileName: string | null;
    localFileStatus: VideoLayerLocalFileStatus;
    /** False where the pick falls back to <input type=file> and is forgotten on restart. */
    canPersistLocalFile: boolean;
    /**
     * 别人临时塞进来的一条画面流，优先于用户自己选的视频。
     *
     * 只活在这次运行里：不落盘、不进设置，重启就没了，用户原本选的视频随后原样回来。
     * B 站 MV 走的就是这条路 —— 它不是什么新的一层背景，只是这一层临时换了源。
     */
    injectedUrl: string | null;
    setInjectedUrl: (url: string | null) => void;
    /**
     * 写开关并落盘。不带 `by` 就是用户自己动的（设置页的开关、命令面板的切换、用户选本地文件）；
     * 服务层的自动写入（市场背景、视频层开关租约）要带上自己的来源，租约只回滚来源仍是
     * `'lease'` 的那一次。
     */
    setVideoLayerEnabled: (enabled: boolean, by?: VideoLayerEnabledWriter) => void;
    setVideoLayerUrl: (url: string) => void;
    setVideoLayerOpacity: (opacity: number) => void;
    setVideoLayerFit: (fit: VideoLayerFit) => void;
    /** Opens the file picker; resolves to the picked name, or null when cancelled. */
    pickLocalFile: () => Promise<string | null>;
    clearLocalFile: () => Promise<void>;
    /**
     * 只把界面上的本地文件摘掉，不动原生那份。
     *
     * `clearLocalFile` 里有原生调用，原生不 resolve 时整条链会卡住；市场换视频那条路
     * 不能等它 —— 等不到就会一直画着上一支视频。这里给一个纯同步的脱手口。
     */
    setLocalFileDropped: () => void;
    /** Rebuilds the pick from the stored handle without prompting. */
    restoreLocalFile: () => Promise<void>;
    /** Asks the browser again for a stored pick whose permission lapsed. Needs a user gesture. */
    regrantLocalFile: () => Promise<void>;
};

// A pick or clear in this session supersedes the stored one, so it also counts as restored.
let restoreStarted = false;

export const useVideoLayerSettingsStore = create<VideoLayerSettingsState>((set, get) => {
    // Bumped by every pick/clear so a slow restore or re-grant cannot overwrite a newer choice.
    let fileRevision = 0;

    /** Only blob URLs are ours to revoke: Android's is a loopback address owned by the native server. */
    const revokePrevious = () => {
        const previous = get().localFileUrl;
        if (previous && previous.startsWith('blob:')) URL.revokeObjectURL(previous);
    };

    const showSource = (url: string, name: string) => {
        revokePrevious();
        set({ localFileUrl: url, localFileName: name, localFileStatus: 'ready' });
    };

    const showFile = (file: File) => showSource(URL.createObjectURL(file), file.name);

    const dropFile = () => {
        revokePrevious();
        set({ localFileUrl: null, localFileName: null, localFileStatus: 'none' });
    };

    const loadStoredFile = async (request: boolean) => {
        const revision = fileRevision;
        // Android: the copy lives in the app's private directory; ask native for its current URL.
        if (isCapacitorAndroid()) {
            const native = await readNativeVideoLayerPick();
            if (!native || revision !== fileRevision) return;
            showSource(native.url, native.name);
            return;
        }
        const handle = await loadVideoLayerFileHandle();
        if (!handle || revision !== fileRevision) return;
        let result: Awaited<ReturnType<typeof readVideoLayerFileHandle>>;
        try {
            result = await readVideoLayerFileHandle(handle, request);
        } catch (error) {
            console.warn('[VideoLayer] Failed to read the stored video handle:', error);
            return;
        }
        if (revision !== fileRevision) return;
        if (result.status === 'ready') {
            showFile(result.file);
        } else if (result.status === 'needs-permission') {
            set({ localFileName: handle.name, localFileStatus: 'needs-permission' });
        } else {
            // The file was moved or deleted; forget the handle rather than retrying every start.
            await clearVideoLayerFileHandle();
            if (revision === fileRevision) dropFile();
        }
    };

    return {
        videoLayerEnabled: getStoredBoolean(VIDEO_LAYER_ENABLED_KEY, false),
        // 初值一律算用户写的，理由见 lastSetBy 的类型注释。
        lastSetBy: 'user',
        videoLayerUrl: getStoredString(VIDEO_LAYER_URL_KEY, ''),
        videoLayerOpacity: clampVideoLayerOpacity(Number(getStoredString(VIDEO_LAYER_OPACITY_KEY, String(VIDEO_LAYER_OPACITY_DEFAULT)))),
        videoLayerFit: getStoredString(VIDEO_LAYER_FIT_KEY, 'cover') === 'contain' ? 'contain' : 'cover',
        localFileUrl: null,
        localFileName: null,
        localFileStatus: 'none',
        canPersistLocalFile: canPersistVideoLayerFile(),
        // 运行时注入的那条：不读盘，所以重启一定是 null。
        injectedUrl: null,
        setInjectedUrl: (url) => {
            /*
             * 这里**不碰 videoLayerEnabled**。
             *
             * 以前注入就顺手把开关打开并落盘（「注入了就把它露出来」）。问题是注入方不止
             * 「用户点了看这个视频」一处：播放页的 MV 层在背景预览里也会注入，于是只看一眼
             * 「MV」背景，这一层就被永久打开了，之后收起面板、换别的背景都关不回去
             * （issue #432）。要不要露出来是注入方的事，见 services/videoLayerEnabledLease：
             * 借的时候把开关打开并记成来源 `'lease'`，还的时候只回滚来源还是 `'lease'` 的那一次。
             */
            set({ injectedUrl: url });
        },
        setVideoLayerEnabled: (enabled, by = 'user') => {
            set({ videoLayerEnabled: enabled, lastSetBy: by });
            setStoredBoolean(VIDEO_LAYER_ENABLED_KEY, enabled);
        },
        setVideoLayerUrl: (url) => {
            const normalized = url.trim();
            set({ videoLayerUrl: normalized });
            persistString(VIDEO_LAYER_URL_KEY, normalized);
        },
        setVideoLayerOpacity: (opacity) => {
            const normalized = clampVideoLayerOpacity(opacity);
            set({ videoLayerOpacity: normalized });
            persistString(VIDEO_LAYER_OPACITY_KEY, String(normalized));
        },
        setVideoLayerFit: (fit) => {
            set({ videoLayerFit: fit });
            persistString(VIDEO_LAYER_FIT_KEY, fit);
        },
        pickLocalFile: async () => {
            const picked = await pickVideoLayerFile();
            if (!picked) return null;
            fileRevision += 1;
            restoreStarted = true;
            if (picked.handle) await saveVideoLayerFileHandle(picked.handle);
            else await clearVideoLayerFileHandle();
            if (picked.url) showSource(picked.url, picked.name);
            else if (picked.file) showFile(picked.file);
            get().setVideoLayerEnabled(true);
            return picked.name;
        },
        clearLocalFile: async () => {
            fileRevision += 1;
            restoreStarted = true;
            dropFile();
            await clearVideoLayerFileHandle();
            // 安卓那一端删的是私有目录里的副本：不清，下次开回来它又回来了。
            await clearNativeVideoLayerPick();
        },
        setLocalFileDropped: () => {
            // 和 clearLocalFile 一样要把 revision 推上去，否则一个迟到的 restore 会把它写回来。
            fileRevision += 1;
            restoreStarted = true;
            dropFile();
        },
        restoreLocalFile: () => loadStoredFile(false),
        regrantLocalFile: () => loadStoredFile(true),
    };
});

/**
 * Restores the pick from an earlier session, once. Called lazily by the layer and the settings
 * section rather than at import time, so windows that never show the layer never touch IndexedDB.
 */
export const ensureVideoLayerFileRestored = () => {
    if (restoreStarted) return;
    restoreStarted = true;
    void useVideoLayerSettingsStore.getState().restoreLocalFile();
};
