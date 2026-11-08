import { useEffect, useRef, useState } from 'react';
import {
    getSquareFilter,
    setSquareFilter,
    subscribeSquareCollections,
    type LxSquareFilter,
} from '../../services/onlineMusic/lxmusic/lxSquareCollections';
import {
    LX_PUBLIC_PLATFORMS,
    lxApiPlaylistTags,
    type LxPublicPlatform,
    type LxSquareTagCatalog,
} from '../../services/onlineMusic/lxmusic/lxPublicApi';
import { LxGlassChipRail, type LxChipItem } from './LxGlassRail';

// src/components/lxmusic/LxSquareToolbar.tsx
// 首页「歌单」页签在洛雪下的筛选条。
//
// 三行全部按洛雪官方那套「一层一层点进去」来做，不再自造大卡片按钮：
//   · 第一行四家平台（「全部平台」是四家混排，也就是洛雪默认那屏）；
//   · 选到某一家，第二行是那家的分类组（热门标签 / 语种 / 风格 …）；
//   · 点进某一组，第三行是这组里的标签；点标签就真的换一批歌单。
// 三行都是同一款横滑胶囊（居中、可拖动、可滚轮），第三级下面直接接歌单卡片。
//
// 分类组与标签都来自那家自己的分类目录接口，不是写死的文案：
// 见 lxPublicApi 的 lxApiPlaylistTags —— 拿到的 id 直接就是该家「按标签取歌单」的参数。

const PLATFORM_KEYS: ReadonlyArray<LxPublicPlatform | 'all'> = ['all', 'wy', 'tx', 'kg', 'kw'];
const ALL_LABEL = '全部平台';

/** 平台名一律取自 LX_PUBLIC_PLATFORMS：这里不写死任何一家中文名。 */
const platformLabel = (key: LxPublicPlatform | 'all'): string => (
    key === 'all' ? ALL_LABEL : (LX_PUBLIC_PLATFORMS.find((item) => item.key === key)?.label ?? key)
);

const PLATFORM_CHIPS: ReadonlyArray<LxChipItem> = PLATFORM_KEYS.map((key) => ({ key, label: platformLabel(key) }));

/** 标签目录每家只拉一次；空目录不缓存，下次进来还有机会重试。 */
const catalogCache = new Map<LxPublicPlatform, Promise<LxSquareTagCatalog>>();

const loadCatalog = (platform: LxPublicPlatform): Promise<LxSquareTagCatalog> => {
    const cached = catalogCache.get(platform);
    if (cached) return cached;
    const promise = lxApiPlaylistTags(platform)
        .then((catalog) => {
            if (catalog.hot.length === 0 && catalog.groups.length === 0) catalogCache.delete(platform);
            return catalog;
        })
        .catch((error) => {
            catalogCache.delete(platform);
            console.warn('[lxmusic] 分类标签加载失败：', error);
            return { hot: [], groups: [] };
        });
    catalogCache.set(platform, promise);
    return promise;
};

export const LxSquareToolbar = () => {
    const [filter, setLocalFilter] = useState<LxSquareFilter>(() => getSquareFilter());
    const [catalog, setCatalog] = useState<LxSquareTagCatalog | null>(null);
    const [groupTitle, setGroupTitle] = useState('');
    const platform = filter.platform;
    const lastPlatform = useRef(platform);

    useEffect(() => subscribeSquareCollections(() => {
        setLocalFilter(getSquareFilter());
    }), []);

    useEffect(() => {
        // 换一家平台，之前停在哪一组就不作数了：从这家自己的第一组重新开始。
        if (lastPlatform.current !== platform) {
            lastPlatform.current = platform;
            setGroupTitle('');
        }
        if (platform === 'all') {
            setCatalog(null);
            return;
        }
        let alive = true;
        setCatalog(null);
        void loadCatalog(platform).then((next) => {
            if (alive) setCatalog(next);
        });
        return () => { alive = false; };
    }, [platform]);

    // 热门标签排在第一组，后面跟那家的分组。空组不占位。
    const groups = catalog
        ? [
            { title: '热门标签', tags: catalog.hot },
            ...catalog.groups,
        ].filter((group) => group.tags.length > 0)
        : [];

    // 不额外记「当前组是否已存在」：换了平台就清空，渲染时再兜底到第一组。
    const activeGroup = groups.find((group) => group.title === groupTitle) ?? groups[0] ?? null;

    const groupChips: LxChipItem[] = groups.map((group) => ({
        key: group.title,
        label: group.title,
    }));

    const tagChips: LxChipItem[] = activeGroup
        ? [
            { key: '', label: '全部' },
            ...activeGroup.tags.map((tag) => ({ key: tag.id, label: tag.name })),
        ]
        : [];

    return (
        <div className="w-full flex flex-col gap-0.5 pt-0.5" data-lx-square-toolbar>
            <LxGlassChipRail
                items={PLATFORM_CHIPS}
                activeKey={platform}
                onSelect={(key) => setSquareFilter({ platform: key as LxSquareFilter['platform'] })}
                testId="platform"
            />
            {platform !== 'all' && catalog === null && (
                <div className="text-[11px] opacity-40 text-center py-2">正在读取分类…</div>
            )}
            {platform !== 'all' && catalog !== null && groups.length === 0 && (
                <div className="text-[11px] opacity-40 text-center py-2">这家暂时没有分类目录</div>
            )}
            {platform !== 'all' && groups.length > 0 && (
                <>
                    <LxGlassChipRail
                        items={groupChips}
                        activeKey={activeGroup?.title ?? ''}
                        onSelect={setGroupTitle}
                        testId="tag-groups"
                    />
                    {activeGroup && (
                        <LxGlassChipRail
                            items={tagChips}
                            activeKey={filter.tagId}
                            onSelect={(key) => setSquareFilter({ tagId: key })}
                            testId="tags"
                        />
                    )}
                </>
            )}
        </div>
    );
};

export default LxSquareToolbar;
