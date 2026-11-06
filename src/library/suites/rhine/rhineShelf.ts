import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// src/library/suites/rhine/rhineShelf.ts
// 「莱茵生命」三维专辑架的网页侧桥。
//
// 分工照 RhineDroid：三维绘制全在原生，网页层只负责把曲库推过去、把手势转成命令。
// 架子用 TextureView 垫在 WebView 下面、WebView 透明，所以网页 UI 照常绘制在它上面。

export type RhineShelfFrame = {
    phase?: string;
    albumId?: string;
    framesSubmitted?: number;
    visibleCells?: number;
    [key: string]: unknown;
};

export type RhineShelfAlbum = {
    /** 必须是 `device-album-<数字>`：渲染器取封面时会砍掉前缀转成 Long。 */
    id: string;
    title: string;
    coverVersion?: number;
};

export type RhineShelfLibrary = {
    albums: RhineShelfAlbum[];
    /**
     * 键同 album.id，值是**封面 URL**。
     *
     * 不传 base64：网页层 fetch 在线封面会被 CORS 挡住（CDN 不给跨域），
     * 所以只把 URL 交给原生，由它下载并缓存。
     */
    coverUrls?: Record<string, string>;
};

export type RhineShelfCommand =
    | { type: 'scene-library'; columns: string[][]; selectedId?: string }
    | { type: 'scene-select'; albumId: string; axis?: string; direction?: number; immediate?: boolean }
    | { type: 'scene-drag'; rotation: number }
    | { type: 'scene-pick'; x: number; y: number }
    | { type: 'scene-overview'; active: boolean }
    | { type: 'scene-mode'; mode: 'hidden' | 'archive' | 'detail'; immediate?: boolean }
    | { type: string; [key: string]: unknown };

interface RhineShelfNative {
    show(): Promise<void>;
    hide(): Promise<void>;
    /** 离开莱茵样式：拆架子并还原宿主背景。 */
    disable(): Promise<void>;
    setLibrary(payload: RhineShelfLibrary): Promise<void>;
    command(payload: { message: RhineShelfCommand }): Promise<void>;
    addListener(eventName: string, listener: (payload: never) => void): Promise<PluginListenerHandle>;
}

/** 原生桥的唯一实例。 */
const native = registerPlugin<RhineShelfNative>('RhineShelf');

/** 只有安卓原生才有这个桥；桌面与网页恒为 false。 */
export const hasRhineShelf = (): boolean => (
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
);

export const showRhineShelf = async (): Promise<void> => {
    if (!hasRhineShelf()) return;
    await native.show();
};

export const hideRhineShelf = async (): Promise<void> => {
    if (!hasRhineShelf()) return;
    await native.hide();
};

export const disableRhineShelf = async (): Promise<void> => {
    if (!hasRhineShelf()) return;
    await native.disable();
};

export const pushRhineLibrary = async (library: RhineShelfLibrary): Promise<void> => {
    if (!hasRhineShelf()) return;
    await native.setLibrary(library);
};

export const sendRhineCommand = async (message: RhineShelfCommand): Promise<void> => {
    if (!hasRhineShelf()) return;
    await native.command({ message });
};

export const onRhineFrame = (
    listener: (frame: RhineShelfFrame) => void,
): Promise<PluginListenerHandle> | null => {
    if (!hasRhineShelf()) return null;
    return native.addListener('shelf', payload => {
        const typed = payload as unknown as { message: RhineShelfFrame };
        listener(typed.message);
    });
};
