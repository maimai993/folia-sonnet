import type { CollectionMutationCapabilities } from '../contracts/mutations';
import type {
    LibraryActionId,
    LibraryDeclaredActions,
    LibraryHomeActionId,
    LibrarySuiteId,
    LibrarySuiteManifest,
    LibrarySurfaceDeclaration,
    LibrarySurfaceId,
    LibrarySurfacePropsMap,
} from '../contracts/suite';

// src/library/core/model/librarySuites.ts
// suite 清单的纯规则：建索引（去重、默认 suite 必须实现全部 surface、丢掉不可用的）、按 surface 解析
// 「由哪套 suite 渲染」（没实现就回退默认 suite）、声明的动作与 core 能力取交集。
// registry.ts 只负责用 glob 发现 entry，再把清单交给这里；单测直接喂假清单。

/** 默认 suite：任何 suite 没实现的 surface 都由它渲染，所以它必须实现全部 surface。 */
export const DEFAULT_LIBRARY_SUITE_ID: LibrarySuiteId = 'grid';

export const LIBRARY_SURFACE_IDS: readonly LibrarySurfaceId[] = ['home', 'collection', 'artist'];

/** 集合 surface 的全部动作（与 LibraryActionId 一一对应，单测核对）。 */
export const LIBRARY_ACTION_IDS: readonly LibraryActionId[] = [
    'play',
    'enqueue',
    'play-scope',
    'enqueue-scope',
    'filter',
    'sort',
    'reload',
    'resume-sync',
    'remove-entry',
    'subscribe',
    'rename',
    'delete-collection',
    'resync-folder',
    'resync-all-folders',
    'export-playlist',
    'edit-entity',
    'organize-song-info',
    'match-song',
    'add-to-playlist',
    'create-playlist',
    'daily-date',
];

/** 首页 surface 的全部动作（与 LibraryHomeActionId 一一对应，单测核对）。 */
export const LIBRARY_HOME_ACTION_IDS: readonly LibraryHomeActionId[] = [
    'directory-filter',
    'directory-select',
    'directory-play-selection',
    'directory-enqueue-selection',
    'directory-create-playlist',
    'directory-remove-selection',
    'directory-rescan-root',
    'directory-remove-root',
    'directory-clear-ignore',
    'directory-manage-hidden',
    'directory-toggle-hidden',
    'home-import-folder',
    'home-refresh-folders',
    'home-import-playlist',
    'home-refresh-navidrome',
];

/**
 * 由变更控制器判定的动作 → 它在 CollectionMutationCapabilities 里的能力键。没列出的动作（播放、范围、筛选、
 * 排序、重新拉取、续传）的能力来自资源与 useCollectionActions。editCollection 不对应动作：编辑模式属于
 * renderer（网格的局部动作 toggle-edit-mode）。
 */
export const LIBRARY_ACTION_MUTATION_CAPABILITY: {
    readonly [Action in LibraryActionId]?: Exclude<keyof CollectionMutationCapabilities, 'editCollection'>;
} = {
    'remove-entry': 'removeEntry',
    subscribe: 'subscribe',
    rename: 'rename',
    'delete-collection': 'deleteCollection',
    'resync-folder': 'resyncFolder',
    'resync-all-folders': 'resyncAllFolders',
    'export-playlist': 'exportPlaylist',
    'edit-entity': 'editEntity',
    'organize-song-info': 'organizeSongInfo',
    'match-song': 'matchSong',
    'add-to-playlist': 'addToPlaylist',
    'create-playlist': 'createPlaylist',
    'daily-date': 'dailyDate',
};

const NO_EXTRA_ACTIONS: readonly string[] = Object.freeze([]);

/** 一个 surface 由哪套 suite 渲染、它声明了什么。同一组输入总是返回同一个对象（可以直接当 props 传）。 */
export type ResolvedLibrarySuiteSurface<Surface extends LibrarySurfaceId> = {
    suite: LibrarySuiteManifest;
    declaration: LibrarySurfaceDeclaration<LibrarySurfacePropsMap[Surface]>;
    declaredActions: LibraryDeclaredActions;
    /** 选中的 suite 没实现这个 surface，由默认 suite 代为渲染。 */
    isFallback: boolean;
};

export type LibrarySuiteIndex = {
    /** 可用的 suite，默认 suite 在最前，其余按 id。 */
    suites: readonly LibrarySuiteManifest[];
    defaultSuite: LibrarySuiteManifest;
    has: (suiteId: string) => boolean;
    get: (suiteId: string) => LibrarySuiteManifest | undefined;
    /** 选中的 suite 实现了就用它，否则（或 id 未知）回退默认 suite。 */
    resolve: <Surface extends LibrarySurfaceId>(surface: Surface, suiteId: string) => ResolvedLibrarySuiteSurface<Surface>;
};

const toDeclaredActions = (declaration: LibrarySurfaceDeclaration<unknown>): LibraryDeclaredActions => Object.freeze({
    actions: declaration.actions,
    extraActions: declaration.extraActions ?? NO_EXTRA_ACTIONS,
});

/**
 * 建 suite 索引。清单有问题就在启动时抛错（而不是等到某个 surface 渲染时才发现）：重复 id、
 * 默认 suite 缺失或没实现全部 surface、声明了清单之外的动作。available === false 的 suite 被丢掉。
 */
export const buildLibrarySuiteIndex = (
    manifests: readonly LibrarySuiteManifest[],
    defaultSuiteId: LibrarySuiteId = DEFAULT_LIBRARY_SUITE_ID,
): LibrarySuiteIndex => {
    const byId = new Map<string, LibrarySuiteManifest>();
    for (const manifest of manifests) {
        if (byId.has(manifest.id)) {
            throw new Error(`[LibrarySuites] Duplicate suite id "${manifest.id}"`);
        }
        for (const surface of Object.keys(manifest.surfaces) as LibrarySurfaceId[]) {
            if (!LIBRARY_SURFACE_IDS.includes(surface)) {
                throw new Error(`[LibrarySuites] Suite "${manifest.id}" declares unknown surface "${surface}"`);
            }
            const known: readonly string[] = surface === 'home' ? LIBRARY_HOME_ACTION_IDS : LIBRARY_ACTION_IDS;
            const unknownAction = manifest.surfaces[surface]?.actions.find(action => !known.includes(action));
            if (unknownAction) {
                throw new Error(`[LibrarySuites] Suite "${manifest.id}" declares unknown action "${unknownAction}" on ${surface}`);
            }
        }
        if (manifest.available !== false) byId.set(manifest.id, manifest);
    }

    const defaultSuite = byId.get(defaultSuiteId);
    if (!defaultSuite) {
        throw new Error(`[LibrarySuites] Default suite "${defaultSuiteId}" is missing`);
    }
    const missing = LIBRARY_SURFACE_IDS.filter(surface => !defaultSuite.surfaces[surface]);
    if (missing.length > 0) {
        throw new Error(`[LibrarySuites] Default suite "${defaultSuiteId}" must implement every surface; missing ${missing.join(', ')}`);
    }

    const suites = [
        defaultSuite,
        ...[...byId.values()].filter(suite => suite !== defaultSuite).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ];

    // 预先算好每个 (suite, surface) 的解析结果：宿主每次渲染都会问，答案必须是同一个对象。
    const resolved = new Map<string, Map<LibrarySurfaceId, ResolvedLibrarySuiteSurface<LibrarySurfaceId>>>();
    for (const suite of suites) {
        const perSurface = new Map<LibrarySurfaceId, ResolvedLibrarySuiteSurface<LibrarySurfaceId>>();
        for (const surface of LIBRARY_SURFACE_IDS) {
            const own = suite.surfaces[surface];
            const renderer = own ? suite : defaultSuite;
            const declaration = (own ?? defaultSuite.surfaces[surface]!) as LibrarySurfaceDeclaration<unknown>;
            const shared = resolved.get(renderer.id)?.get(surface);
            perSurface.set(surface, {
                suite: renderer,
                declaration: declaration as ResolvedLibrarySuiteSurface<LibrarySurfaceId>['declaration'],
                // 回退时与默认 suite 自己的解析共用同一份声明对象。
                declaredActions: shared?.declaredActions ?? toDeclaredActions(declaration),
                isFallback: !own,
            });
        }
        resolved.set(suite.id, perSurface);
    }

    return {
        suites,
        defaultSuite,
        has: suiteId => byId.has(suiteId),
        get: suiteId => byId.get(suiteId),
        resolve: <Surface extends LibrarySurfaceId>(surface: Surface, suiteId: string) => (
            (resolved.get(suiteId) ?? resolved.get(defaultSuite.id)!).get(surface) as unknown as ResolvedLibrarySuiteSurface<Surface>
        ),
    };
};

export const isLibraryActionDeclared = (declared: LibraryDeclaredActions, action: LibraryActionId): boolean => (
    declared.actions.includes(action)
);

/**
 * 声明 ∩ core 能力：available 是 core 此刻认为能做的动作，只留下 suite 也声明了的，顺序按 available。
 */
export const intersectDeclaredActions = (
    declared: LibraryDeclaredActions,
    available: readonly LibraryActionId[],
): LibraryActionId[] => available.filter(action => declared.actions.includes(action));

/**
 * 变更控制器判定的那部分动作：suite 声明了、且这个集合支持的（不看 enabled——进行中、加载中的动作
 * 仍然出现，只是不可用）。suite 用它决定自己的变更入口出不出现（TUI 的 Delete、星标、改名……）；
 * 命令面板走 core/model/collectionSurface 的 GRID_SURFACE_ACTION_SOURCES，结果与这里一致。
 */
export const resolveDeclaredMutationActions = (
    declared: LibraryDeclaredActions,
    capabilities: CollectionMutationCapabilities,
): LibraryActionId[] => declared.actions.filter((action): action is LibraryActionId => {
    const key = LIBRARY_ACTION_MUTATION_CAPABILITY[action as LibraryActionId];
    return key ? capabilities[key].supported : false;
});
