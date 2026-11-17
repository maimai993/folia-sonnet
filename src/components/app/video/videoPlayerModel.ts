// src/components/app/video/videoPlayerModel.ts
// 播放层的纯部分：类型、常量、本地偏好读写、播放地址解析、时间格式与快捷键表。
// 组件本身（VideoPlayer）只留状态与画面，这些都在这里，避免一个文件越滚越长（CI 有 800 行上限）。

import { fetchVideoText } from '../../../services/videoSources/net';
import type { CmsPlayLine } from '../../../services/videoSources/cms';

export type VideoEpisode = { name: string; url: string };

export type Props = {
    /** 剧名。 */
    title: string;
    /** 剧集海报，做这一层的封面/背景。 */
    cover?: string;
    /** 这一部剧的所有线路（换线路等于换片源，也就是换清晰度）。 */
    lines: CmsPlayLine[];
    /** 当前线路下标。 */
    lineIndex: number;
    /** 换线路。 */
    onLineChange: (index: number) => void;
    /** 当前线路的可选集。 */
    episodes: VideoEpisode[];
    /** 正在播的是第几集。 */
    index: number;
    /** 换集。 */
    onIndexChange: (index: number) => void;
    onClose: () => void;
};

/** 基础快进快退步长：跟 PotPlayer / mpv 的 5 秒一致，Shift 跳到 30 秒。 */
export const STEP_SECONDS = 5;
export const STEP_SECONDS_LONG = 30;
export const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
/** 控制条亮着多久就走开（毫秒）。 */
export const CHROME_LINGER_MS = 3000;
/** 画质增强与各项画面偏好的存储键。 */
export const PREFS_KEY = 'folia-video-prefs';
export const ENHANCE_KEY = 'folia-video-enhance';
/** 断点续播的存储键前缀。 */
export const POS_PREFIX = 'folia-video-pos';

export type LoopMode = 'off' | 'episode' | 'list';
export type AspectMode = 'contain' | 'cover' | 'fill';

/** 记在本地的一整套画面/声音偏好。 */
export type Prefs = {
    volume: number;
    speed: number;
    aspect: AspectMode;
    rotate: number;
    mirror: boolean;
    brightness: number;
    contrast: number;
    saturation: number;
};

export const DEFAULT_PREFS: Prefs = {
    volume: 1,
    speed: 1,
    aspect: 'contain',
    rotate: 0,
    mirror: false,
    brightness: 1,
    contrast: 1,
    saturation: 1,
};

export const readPrefs = (): Prefs => {
    try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        if (!raw) return { ...DEFAULT_PREFS };
        const parsed = JSON.parse(raw) as Partial<Prefs>;
        return { ...DEFAULT_PREFS, ...parsed };
    } catch {
        return { ...DEFAULT_PREFS };
    }
};

export const writePrefs = (prefs: Prefs) => {
    try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* 存不进就只管这一次 */ }
};

export const isHls = (url: string) => /\.m3u8($|\?)/i.test(url);

/** 从一个播放网页里抠出真正的媒体地址；抠不到返回空串。 */
export const resolvePageMedia = async (pageUrl: string): Promise<string> => {
    try {
        const response = await fetchVideoText(pageUrl);
        if (!response.ok) return '';
        const match = response.bodyText.match(/["'(]([^"'()\\\s]*\.m3u8[^"'()\\\s]*)/i);
        if (!match) return '';
        // 页面里常给相对路径（/20250923/xxx/index.m3u8?sign=…），按页面地址补成绝对地址。
        try {
            return new URL(match[1], pageUrl).toString();
        } catch {
            return '';
        }
    } catch {
        return '';
    }
};

export const clock = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (value: number) => String(value).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
};

/** hls.js 报上来的档位。 */
export type Level = { index: number; height: number; bitrate: number };

export type PanelTab = 'cover' | 'episodes' | 'subtitle' | 'quality' | 'more';

/** 右键菜单的一条：能点的叶子、带子菜单的分支、或者一道分隔线。 */
export type MenuLeaf = { kind: 'leaf'; label: string; hint?: string; checked?: boolean; disabled?: boolean; run: () => void };
export type MenuBranch = { kind: 'branch'; label: string; children: MenuLeaf[] };
export type MenuEntry = MenuLeaf | MenuBranch | { kind: 'line' };

/** 快捷键一览（F1 打开）：菜单里标的键位和这里是同一份。 */
export const KEYMAP: Array<[string, string]> = [
    ['空格 / K', '播放·暂停'],
    ['← / →', '快退·快进 5 秒（Shift 30 秒）'],
    ['J / L', '快退·快进 10 秒'],
    ['↑ / ↓', '音量 +/− 5%'],
    ['M', '静音切换'],
    ['滚轮', '调音量（Shift+滚轮 快进·快退）'],
    ['单击画面', '播放·暂停（双击左右两侧各 ±10 秒）'],
    ['双击画面', '全屏 / 退出全屏'],
    ['F / Enter', '全屏 / 退出全屏'],
    ['Esc', '逐级返回：菜单 → 面板 → 全屏 → 选集'],
    ['P / N (PgUp·PgDn)', '上一集 · 下一集'],
    ['[ / ]', '倍速 ∓10%'],
    ['{ / }', '倍速减半 / 加倍'],
    ['Backspace', '回到片头（Shift 恢复 1× 倍速）'],
    [', / .', '逐帧后退 / 前进'],
    ['1–9 / 0', '跳到 10%–90% / 片头'],
    ['L', '循环：关 → 单集 → 列表'],
    ['B', '按一下设起点 A，再按一下设终点 B（A-B 循环）'],
    ['S', '截图（存下载目录）'],
    ['V', '字幕开关'],
    ['H', '画质增强'],
    ['W', '缩放：适应 → 铺满 → 裁剪'],
    ['R', '画面旋转 90°'],
    ['T', '画中画（浮在最上层的小窗）'],
    ['I', '媒体信息面板'],
    ['F1 / ?', '这份快捷键一览'],
];
