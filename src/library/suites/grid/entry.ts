import type { LibrarySuiteManifest } from '../../core/contracts/suite';
import Grid3D from './home/Grid3D';
import GridCollectionSurface from './collection/GridCollectionSurface';
import GridArtistSurface from './artist/GridArtistSurface';
import { CollectionMorphOverlay } from './transitions/CollectionMorphOverlay';
import { gridHostTransitions } from './transitions/gridHostTransitions';

// src/library/suites/grid/entry.ts
// 网格 suite（默认 suite）：实现全部三个 surface，任何别的 suite 没实现的 surface 都由它渲染。
//
// 这里的组件是即时 import，不是 React.lazy——这是默认 suite 唯一的例外（别的 entry 必须 lazy，
// test/unit/library/suiteEntries.test.ts 检查）：
// - Grid3D 在首屏。lazy 会让首页第一次渲染先挂起、等一个 chunk，React 19 还会为 Suspense 的揭示节流，
//   首屏因此晚出现；
// - 移形换影要在首页卡片被点的那一刻量到网格集合层的 hero，转场层也必须从挂载起就在（捕获首页卡片的点击）。
//   集合层或转场层 lazy 的话，第一次打开集合时它们还没加载，第一次转场就会丢；
// - registry 只被首页外壳（Home）、集合宿主和 suite 切换引用，而它们本来就静态 import 这些组件，
//   即时 import 不会把网格拉进任何原本不含它的模块。

const grid: LibrarySuiteManifest = {
    id: 'grid',
    labelKey: 'libraryTui.rendererGrid',
    surfaces: {
        // 首页的动作（目录批量、隐藏……）P3 再声明。
        home: { component: Grid3D, actions: [] },
        collection: {
            component: GridCollectionSurface,
            actions: [
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
            ],
            extraActions: ['toggle-info-panel', 'toggle-track-list', 'toggle-edit-mode'],
        },
        artist: {
            component: GridArtistSurface,
            // 歌手页：播放 / 入队单曲与热门歌曲、筛选、编辑本地歌手实体。
            actions: ['play', 'enqueue', 'play-scope', 'enqueue-scope', 'filter', 'edit-entity'],
        },
    },
    transitions: {
        Overlay: CollectionMorphOverlay,
        ...gridHostTransitions,
    },
};

export default grid;
