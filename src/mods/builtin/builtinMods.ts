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
    /** 这个模组带不带 Node 入口（mod.json 里有 `main`）。 */
    hasMain?: boolean;
}

/** Where the bundling put them (public/mods/builtin). */
const BUILTIN_BASE = '/mods/builtin';

const BUILTIN_SOURCES: readonly BuiltinModSource[] = [
    {
        id: 'mod-market',
        name: '模组市场',
        version: '1.0.1',
        author: '飛.',
        description: '把官方模组市场搬进 Folia：首页导航末尾多一个整页「模组市场」，打开就是官方站的全部模组，安装、更新都在应用里完成。直接读官方站公布的 catalog.json（带 ETag 与本地缓存，断网时退回上次的目录），按官方 / 社区 / Beta / 已安装过滤，一键安装会先核对 SHA-256 再交给宿主自己的安装器。',
        // 与 mod.json 一致：只要 filesystem.data（缓存 catalog 与下载的 zip）。
        permissions: ['filesystem.data'],
        folia: '>=0.7.21 <0.8.0',
        hasMain: true,
    },
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
        description: 'Folia 本机听歌统计与网易云榜单、时长报告；云端功能使用官方受控接口，需要 Folium 1.7。',
        // `stageLayers` 放封面层，`playback.control` 供排行里的播放 / 排队，剩下的是云端读接口。
        permissions: ['filesystem.data', 'stageLayers', 'playback.control', 'platform.netease.read'],
        experimental: ['platform.raw'],
        folia: '>=0.7.22',
        // 原始包带 index.cjs 作为 Node 入口（archive.* 由它回答）。
        hasMain: true,
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
    hasMain: source.hasMain ?? false,
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
