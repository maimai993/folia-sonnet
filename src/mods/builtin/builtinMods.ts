import type { ModRuntimeInfo } from '../types';

// src/mods/builtin/builtinMods.ts
// 随包内置的模组：文件在 `public/mods/builtin/<id>/`，打进 APK 后是 `/mods/builtin/<id>/…`。
//
// 为什么要有这一份：模组平时由主进程扫描「用户的模组目录」后给出清单（`folia-mod://` 地址），
// 安卓端没有这条通道（`isModsBridgeAvailable()` 恒为 false），于是 `initFoliumClients` 直接返回，
// 一个模组都不会起。内置模组绕开安装与清单，直接把同源静态地址交给 `clientLoader`，
// 走的仍是同一套 Folium API、同一个加载与守卫流程。

interface BuiltinModSource {
    id: string;
    name: string;
    version: string | null;
    author: string | null;
    description: string | null;
    permissions: string[];
    /** 实验接口的 opt-in，和 mod.json 的 `experimental` 同义。 */
    experimental?: string[];
    folia: string | null;
}

/** Where the bundling put them (public/mods/builtin). */
const BUILTIN_BASE = '/mods/builtin';

const BUILTIN_SOURCES: readonly BuiltinModSource[] = [
    {
        id: 'vinyl-disc',
        name: '黑胶唱片',
        version: '1.7.10',
        author: 'pomepii',
        description: '一个歌词动画模式：选中后播放界面出现黑胶唱片——当前歌曲的封面作碟心，播放时唱片旋转、唱臂落下，暂停时唱臂抬起、唱片停转，歌词在唱片旁排布。参考 QQ 音乐 / 网易云音乐的黑胶效果；不选中则完全不出现，不影响其他模式。',
        permissions: [],
        folia: '>=0.7.21 <0.8.0',
    },
    {
        id: 'visualizer-jump',
        name: '跳一跳歌词特效',
        version: '1.2.0',
        author: 'tumuyan',
        description: '一个仿跳一跳小游戏的歌词特效。',
        permissions: [],
        folia: '>=0.7.21 <0.8.0',
    },
    {
        id: 'listening-archive',
        name: '听歌档案',
        version: '1.3.3',
        author: 'imicola',
        description: '本机听歌统计：听多久、最常听什么、什么时候听、单曲轨迹；界面是模组自己的那套页面。',
        // 主进程侧的 `filesystem.data` 只管模组自己的数据文件，这里没有主进程，存储走 `archive.*` 的渲染进程实现
        // （builtinRpc.ts）；`stageLayers` 放封面层，`playback.control` 供排行里的播放/排队，剩下的是云端读接口。
        permissions: ['filesystem.data', 'stageLayers', 'playback.control', 'platform.netease.read'],
        experimental: ['platform.raw'],
        folia: '>=0.7.21 <0.8.0',
    },
];

/** 内置模组的清单项：字段与主进程给的 `ModRuntimeInfo` 同形，只是客户端地址是同源静态地址。 */
export const builtinModRuntimeInfos = (): ModRuntimeInfo[] => BUILTIN_SOURCES.map(source => ({
    id: source.id,
    name: source.name,
    version: source.version,
    author: source.author,
    description: source.description,
    permissions: source.permissions,
    // 随包来的一律视为已启用且已加载：没有安装那一步，也就没有待批准的信任态。
    status: 'loaded',
    error: null,
    enabled: true,
    trustStale: false,
    signature: { status: 'unsigned', reason: null, keyId: null, keyLabel: null, signedAt: null },
    devSource: false,
    experimental: [...(source.experimental ?? [])],
    embedOrigins: [],
    folia: source.folia,
    hasMain: false,
    clientUrl: `${BUILTIN_BASE}/${source.id}/client.mjs`,
}));

/** 预览图的地址，给模组面板用。 */
export const builtinModPreviewUrl = (modId: string): string | null => {
    const source = BUILTIN_SOURCES.find(item => item.id === modId);
    if (!source) return null;
    const name = modId === 'visualizer-jump' ? 'preview.webp' : 'preview.jpg';
    return `${BUILTIN_BASE}/${source.id}/${name}`;
};

/** 这个 id 是不是随包内置的（模组面板据此隐藏「卸载」，显示「内置」）。 */
export const isBuiltinMod = (modId: string): boolean => BUILTIN_SOURCES.some(item => item.id === modId);
