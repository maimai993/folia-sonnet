import { create } from 'zustand';
import {
    clampLibraryWallWindowsPerBlock,
    normalizeLibraryWallLook,
    type LibraryWallLook,
} from '../utils/libraryWallLook';
import { normalizeLibraryWallSeamStyle, type LibraryWallSeamStyle } from '../utils/libraryWallSeamStyle';
import {
    DEFAULT_LIBRARY_WALL_SEAM_DIRECTION,
    isLibraryWallSeamDirection,
    normalizeLibraryWallSeamDirection,
    type LibraryWallSeamDirection,
} from '../utils/libraryWallSeamDirection';

// src/stores/useLibraryWallLookStore.ts
// bravais 资料库界面的墙面偏好：「透光」档位 look（实色 / 部分透明 / 全透明，默认实色）与部分透明时每块的窗数
// windowsPerBlock（1–6，默认 3）；集合磁贴的叠页边开关 collectionStackEdges（默认开，设计稿 §7.7）；
// 信息条（缝）的材质：始终透明 seamClear（默认开，用户定 2026-10-09）与实色模式的预设 seamStyle（默认主题纸色，透明开着时不生效）；
// 透出的播放页画面（backdrop）要不要画歌词文字 backdropLyrics、要不要模糊 backdropBlur（都默认关，§11「墙后的画面」）；
// 信息条的方向 seamDirection：竖向 / 横向（从块的横向缝隙裂开成横条）/ 自动（按视口宽高比）/ 自动（反向）（默认），
// 见 utils/libraryWallSeamDirection。
// 「反向」从前是这里的独立开关 seamDirectionReverse（只翻自动那一支，默认开，用户定 2026-10-24），现已并进取值列表
// 成为 'auto-reverse'（用户定 2026-10-30）：默认方向就是它，旧存档由 readStoredSeamDirection 迁移。
// 放在 app 层而不是 suite 里，因为设置 UI（components/modal/settings）不能 import suite；bravais 的 stage 读这里。
// 只在 bravais 是生效 suite 时才有界面入口（library/app/bravaisLibraryActive；界面设置的「Bravais」分组）。
//
// @note look 与 windowsPerBlock 是用户明确决定「不进外观配置导入导出」的视觉偏好（2026-10-06）。不要按
// settings-feature-integration「视觉设置必须进 buildCurrentConfig / compressConfig / decompressConfig / validKeys /
// handleImportConfig」的规则把它们补进短码或 JSON，也不进同步的视觉设置快照。
// collectionStackEdges 没有这样的用户决定，按规则进了外观配置的导入导出（visualSettingsConfig、appearanceCodec 的 bse、
// 导入确认的「资料库墙」组）；不进同步快照（同步只覆盖播放页的视觉设置）。
// seamClear / seamStyle / backdropLyrics / backdropBlur / seamDirection 同样没有用户例外，
// 按规则进外观配置导入导出（libraryWallSeamClear / libraryWallSeamStyle / libraryWallBackdropLyrics /
// libraryWallBackdropBlur / libraryWallSeamDirection，
// 短码 lwsc / lwss / lwbl / lwbb / lwsd），同样不进同步快照。
// 反过来的方向上：lwdr（旧的反向开关）**不再导出**，旧配置里的它由 decompressConfig 折算成 'auto-reverse'。
//
// 存储读写都包 try/catch：存储不可用（隐私模式、配额满）时本次会话照常用内存里的值。
// 读到非法档位回默认档，读到越界或非数字的窗数钳制 / 回默认（规则在 utils/libraryWallLook）。

const LIBRARY_WALL_LOOK_KEY = 'library_wall_look';
const LIBRARY_WALL_WINDOWS_PER_BLOCK_KEY = 'library_wall_windows_per_block';
const LIBRARY_WALL_STACK_EDGES_KEY = 'library_wall_stack_edges';
const LIBRARY_WALL_SEAM_CLEAR_KEY = 'library_wall_seam_clear';
const LIBRARY_WALL_SEAM_STYLE_KEY = 'library_wall_seam_style';
const LIBRARY_WALL_BACKDROP_LYRICS_KEY = 'library_wall_backdrop_lyrics';
const LIBRARY_WALL_BACKDROP_BLUR_KEY = 'library_wall_backdrop_blur';
const LIBRARY_WALL_SEAM_DIRECTION_KEY = 'library_wall_seam_direction';
const LIBRARY_WALL_SEAM_DIRECTION_REVERSE_KEY = 'library_wall_seam_direction_reverse';
/** 迁移标记：反向开关已经折进方向取值了，见 readStoredSeamDirection。 */
const LIBRARY_WALL_SEAM_DIRECTION_MIGRATED_KEY = 'library_wall_seam_direction_migrated';

const readStored = (key: string): string | null => {
    if (typeof window === 'undefined') return null;
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const writeStored = (key: string, value: string) => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(key, value);
    } catch {
        // Keep the value for this session when storage is unavailable.
    }
};

const readStoredLook = (): LibraryWallLook => normalizeLibraryWallLook(readStored(LIBRARY_WALL_LOOK_KEY));
const readStoredWindowsPerBlock = (): number => clampLibraryWallWindowsPerBlock(readStored(LIBRARY_WALL_WINDOWS_PER_BLOCK_KEY));
/** 默认开；只认 'false' 为关（读不到、非法值都按默认）。 */
const readStoredStackEdges = (): boolean => readStored(LIBRARY_WALL_STACK_EDGES_KEY) !== 'false';
/** 默认关的开关：只认 'true' 为开。 */
const readStoredFlag = (key: string): boolean => readStored(key) === 'true';
/**
 * 信息条方向，连带把旧存档迁移过来。
 *
 * 从前这里是「方向」+ 一个独立的「反向」开关（只翻自动那一支，默认开，用户定 2026-10-24）。现在反向成了取值里的
 * 一档 'auto-reverse'，旧存档按旧语义折过来：
 *   · 存的是 'auto' —— 看那个旧开关：'false' 才是纯「自动」，其余（含没存过开关）都是反向的；
 *   · 没存过方向、或存了不认识的 —— 旧用户的默认是「自动 + 反向开」，只有旧开关明确为 'false' 时才落 'auto'；
 *   · 存的是竖向 / 横向 —— 旧开关对它们不生效，原样返回。
 *
 * 关键是**只折一次**：迁移完写上标记，此后 'auto' 就是用户此刻选的「自动」，不再被残留的旧开关翻过去。
 * 不写标记的话，用户在新界面里明确选了「自动」，下次启动又会被折成自动（反向）—— 那就成了「改不动」。
 * 旧键 LIBRARY_WALL_SEAM_DIRECTION_REVERSE_KEY **只读不写、迁完即删**：已经发布的存储键不改名，但退休的键该收掉。
 */
const readStoredSeamDirection = (): LibraryWallSeamDirection => {
    const stored = readStored(LIBRARY_WALL_SEAM_DIRECTION_KEY);
    // 迁过了、或本来就是新界面写下的：原样认，不再折。
    if (readStored(LIBRARY_WALL_SEAM_DIRECTION_MIGRATED_KEY) === '1') {
        return isLibraryWallSeamDirection(stored) ? stored : DEFAULT_LIBRARY_WALL_SEAM_DIRECTION;
    }
    const legacyReverse = readStored(LIBRARY_WALL_SEAM_DIRECTION_REVERSE_KEY);
    const legacyReversed = legacyReverse !== 'false';
    // 旧存档里什么都没写过（新用户，或从来没动过这个设置）：直接用默认值，一个键都不写。
    if (stored === null && legacyReverse === null) return DEFAULT_LIBRARY_WALL_SEAM_DIRECTION;
    // 明确选了竖向 / 横向，或者已经是 'auto-reverse'：旧开关对它们不生效，原样返回，不用迁移。
    if (stored === 'vertical' || stored === 'horizontal' || stored === 'auto-reverse') return stored;
    // 到这里只剩两种旧状态：'auto'（要看旧开关），或存了不认识的取值（按旧默认）。
    const resolved: LibraryWallSeamDirection = stored === 'auto'
        ? (legacyReversed ? 'auto-reverse' : 'auto')
        : (legacyReverse === 'false' ? 'auto' : DEFAULT_LIBRARY_WALL_SEAM_DIRECTION);
    migrateSeamDirection(resolved);
    return resolved;
};

/**
 * 把折好的方向写进新键、打上迁移标记、删掉旧开关。
 *
 * 顺序是有意的：新键与标记都写成功之后才删旧键。存储不可用（隐私模式、配额满）时整个 catch 掉 ——
 * 这次会话照常用内存里的值，旧键留着，下次启动再迁一遍。
 */
const migrateSeamDirection = (direction: LibraryWallSeamDirection): void => {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(LIBRARY_WALL_SEAM_DIRECTION_KEY, direction);
        localStorage.setItem(LIBRARY_WALL_SEAM_DIRECTION_MIGRATED_KEY, '1');
        localStorage.removeItem(LIBRARY_WALL_SEAM_DIRECTION_REVERSE_KEY);
    } catch {
        // 见上：迁移是尽力而为的，不能让它把 store 弄挂。
    }
};
/** 信息条始终透明：默认开（用户定，2026-10-09）；只认 'false' 为关。 */
const readStoredSeamClear = (): boolean => readStored(LIBRARY_WALL_SEAM_CLEAR_KEY) !== 'false';
const readStoredSeamStyle = (): LibraryWallSeamStyle => normalizeLibraryWallSeamStyle(readStored(LIBRARY_WALL_SEAM_STYLE_KEY));

const readAll = () => ({
    look: readStoredLook(),
    windowsPerBlock: readStoredWindowsPerBlock(),
    collectionStackEdges: readStoredStackEdges(),
    seamClear: readStoredSeamClear(),
    seamStyle: readStoredSeamStyle(),
    backdropLyrics: readStoredFlag(LIBRARY_WALL_BACKDROP_LYRICS_KEY),
    backdropBlur: readStoredFlag(LIBRARY_WALL_BACKDROP_BLUR_KEY),
    seamDirection: readStoredSeamDirection(),
});

export type LibraryWallLookState = {
    look: LibraryWallLook;
    /** 部分透明时每块（12 个 slot）开几个窗；档位不是部分透明时保留原值，切回来照旧。 */
    windowsPerBlock: number;
    /** 集合磁贴（专辑 / 歌单 / 文件夹 / 每日推荐）右下边缘的叠页边；关掉时集合就是普通海报（曲目数仍在标签里）。 */
    collectionStackEdges: boolean;
    /**
     * 信息条始终透明：缝（首页窄缝 / 书脊、集合与歌手页的信息条、面板）不画实色纸，透出后面的 visualizer。
     * 开着时实色墙也不算完全遮挡（visualizer 不卸载），seamStyle 不生效。
     */
    seamClear: boolean;
    /** 信息条实色模式的预设（seamClear 开着时不生效，值保留）。 */
    seamStyle: LibraryWallSeamStyle;
    /** 透出的 visualizer（窗、透明的缝）画不画歌词文字；只影响首页墙后面，播放页照常。 */
    backdropLyrics: boolean;
    /** 透出的 visualizer 加模糊（visualizer 那一层的 CSS filter，只在有透出时生效）。 */
    backdropBlur: boolean;
    /**
     * 信息条的方向：横向时首页窄缝 / 书脊与集合、歌手页的信息条 / 书脊从块的横向缝隙裂开，墙上下分开（列表面板、表单与
     * 歌手 / 专辑海报仍是竖的开口）；自动时竖着的屏幕用横向，自动（反向）时反过来。默认自动（反向）。
     */
    seamDirection: LibraryWallSeamDirection;
    /** 非法值回默认档后再写入。 */
    setLook: (look: LibraryWallLook) => void;
    /** 先钳到 1–6 再写入。 */
    setWindowsPerBlock: (windowsPerBlock: number) => void;
    setCollectionStackEdges: (enabled: boolean) => void;
    setSeamClear: (enabled: boolean) => void;
    /** 非法值回默认（主题纸色）后再写入。 */
    setSeamStyle: (style: LibraryWallSeamStyle) => void;
    setBackdropLyrics: (enabled: boolean) => void;
    setBackdropBlur: (enabled: boolean) => void;
    /** 非法值回默认（自动（反向））后再写入。 */
    setSeamDirection: (direction: LibraryWallSeamDirection) => void;
    /** 从存储重新读一遍（存储被别处改写、或测试模拟重启时用）。 */
    hydrate: () => void;
};

const writeFlag = (key: string, enabled: boolean): boolean => {
    const value = Boolean(enabled);
    writeStored(key, String(value));
    return value;
};

export const useLibraryWallLookStore = create<LibraryWallLookState>(set => ({
    ...readAll(),
    setLook: (look) => {
        const normalized = normalizeLibraryWallLook(look);
        writeStored(LIBRARY_WALL_LOOK_KEY, normalized);
        set({ look: normalized });
    },
    setWindowsPerBlock: (windowsPerBlock) => {
        const clamped = clampLibraryWallWindowsPerBlock(windowsPerBlock);
        writeStored(LIBRARY_WALL_WINDOWS_PER_BLOCK_KEY, String(clamped));
        set({ windowsPerBlock: clamped });
    },
    setCollectionStackEdges: (enabled) => {
        const value = Boolean(enabled);
        writeStored(LIBRARY_WALL_STACK_EDGES_KEY, String(value));
        set({ collectionStackEdges: value });
    },
    setSeamClear: enabled => set({ seamClear: writeFlag(LIBRARY_WALL_SEAM_CLEAR_KEY, enabled) }),
    setSeamStyle: (style) => {
        const normalized = normalizeLibraryWallSeamStyle(style);
        writeStored(LIBRARY_WALL_SEAM_STYLE_KEY, normalized);
        set({ seamStyle: normalized });
    },
    setBackdropLyrics: enabled => set({ backdropLyrics: writeFlag(LIBRARY_WALL_BACKDROP_LYRICS_KEY, enabled) }),
    setBackdropBlur: enabled => set({ backdropBlur: writeFlag(LIBRARY_WALL_BACKDROP_BLUR_KEY, enabled) }),
    setSeamDirection: (direction) => {
        const normalized = normalizeLibraryWallSeamDirection(direction);
        writeStored(LIBRARY_WALL_SEAM_DIRECTION_KEY, normalized);
        // 用户在新界面里亲手选的：打上迁移标记，别让残留的旧开关把他选的「自动」再折一次。
        writeStored(LIBRARY_WALL_SEAM_DIRECTION_MIGRATED_KEY, '1');
        set({ seamDirection: normalized });
    },
    hydrate: () => set(readAll()),
}));
