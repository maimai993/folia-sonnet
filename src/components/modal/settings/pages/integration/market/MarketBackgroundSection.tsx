// src/components/modal/settings/pages/integration/market/MarketBackgroundSection.tsx
//
// 背景市场：视频与静态图片，来自 Moewalls / 哲风壁纸 / 壁纸汇。
//
// 交互与字体市场一致：点一张 → 弹窗问「要应用在哪里？」→ 确认后原地显示下载进度。
//
// 视频动辄几十上百 MB，所以下载一律走原生，界面只显示进度与结果。

import React, { useEffect, useMemo, useState } from 'react';
import { TextField } from '../../../../../../components/ui';
import { Button } from '../../../../../../components/ui';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import {
    BACKGROUND_MARKET_SOURCES,
    getMarketCategories,
    type BackgroundMarketItem,
    type BackgroundMarketSourceId,
} from '../../../../../../services/backgroundMarket';
import { useBackgroundMarket } from './useBackgroundMarket';
import { useMarketFilterStore } from './MarketFilterSlot';
import { useBackgroundApplyTarget, type BackgroundTarget } from './useBackgroundApplyTarget';
import { applyMarketBackground } from '../../../../../../services/backgroundMarket/apply';
import { subscribeBackgroundProgress } from '../../../../../../services/backgroundMarket/progress';
import MarketApplyDialog, { type ApplyTargetChoice } from './MarketApplyDialog';
import MarketRotationSection from './MarketRotationSection';

/**
 * part 同 MarketFontSection：'all' 整段、'filters' 只画筛选、'content' 只画卡片。
 */
const MarketBackgroundSection: React.FC<{ part?: 'all' | 'filters' | 'content' }> = ({ part = 'all' }) => {
    const { t } = useTranslation();
    /* 同字体区块：筛选条件放共享 store，横屏时左右两栏才是同一份状态。 */
    const {
        backgroundSource: source,
        backgroundCategory: category,
        backgroundKeyword: keyword,
        set: setFilter,
    } = useMarketFilterStore();
    const setSource = (next: BackgroundMarketSourceId) => setFilter({ backgroundSource: next });
    const setCategory = (next: string) => setFilter({ backgroundCategory: next });
    const setKeyword = (next: string) => setFilter({ backgroundKeyword: next });
    const { items, loading, error, hasMore, loadMore, reload } = useBackgroundMarket(source, category, keyword);
    const { target, setTarget } = useBackgroundApplyTarget();

    const [pending, setPending] = useState<BackgroundMarketItem | null>(null);
    const [progress, setProgress] = useState<number | null>(null);
    const [progressLabel, setProgressLabel] = useState('');
    const [applyError, setApplyError] = useState<string | null>(null);
    /** 应用成功但需要说明的情况（比如要先去系统设置放行壁纸）。 */
    const [notice, setNotice] = useState<string | null>(null);

    const categories = getMarketCategories(source);

    /*
     * 两个目标对图片和视频都成立：
     *   · 图片 → App 内切到莫奈并设成自定义图
     *   · 视频 → App 内走「歌词后方视频层」，填地址并自动打开
     * 所以这里不再禁用任何一项。
     */
    /*
     * 「歌词样式的莫奈背景」只对**图片**开放。
     *
     * 莫奈那一层画的是静图（封面派生图 / 上传的图），视频放不进去 ——
     * 视频要去的是「App 内」的视频层。所以这一项在视频上直接不出现，
     * 而不是出现了再禁用（禁用的项用户会一直点）。
     */
    const choices: ApplyTargetChoice<BackgroundTarget>[] = useMemo(() => {
        const entries: ApplyTargetChoice<BackgroundTarget>[] = [
            { id: 'wallpaper', label: t('options.marketTargetBackground_wallpaper'), hint: t('options.marketTargetBackgroundWallpaperHint') },
            { id: 'app', label: t('options.marketTargetBackground_app'), hint: t('options.marketTargetBackgroundAppHint') },
        ];
        if (!pending || pending.kind === 'image') {
            entries.push({
                id: 'monet',
                label: t('options.marketTargetBackground_monet'),
                hint: t('options.marketTargetBackgroundMonetHint'),
            });
        }
        return entries;
    }, [t, pending]);

    // 订阅下载进度（视频才有，图片通常是瞬时的）
    useEffect(() => {
        const unsubscribe = subscribeBackgroundProgress((value) => setProgress(value));
        return unsubscribe;
    }, []);

    /*
     * 不再收裁切与旋转：桌面壁纸那边原生已经默认按 90° 摆好（壁纸站几乎全是横屏），
     * 用户不用再自己框一次，取景框就此拿掉。
     */
    const handleConfirm = async (targets: BackgroundTarget[]) => {
        if (!pending) return;
        setApplyError(null);
        setProgress(0);
        setProgressLabel(t('options.marketBackgroundProgress'));
        try {
            const result = await applyMarketBackground(pending, targets);
            if (!result.ok) {
                setApplyError(result.error ?? t('options.marketRetry'));
                setProgress(null);
                return;
            }
            setTarget({
                kind: pending.kind,
                name: pending.name,
                appliesTo: targets,
            });
            // 需要去系统设置放行时，别让弹窗一关就没了提示。
            if (result.notice) setNotice(result.notice);
            setPending(null);
            setProgress(null);
        } catch {
            setApplyError(t('options.marketRetry'));
            setProgress(null);
        }
    };

    const closeDialog = () => {
        setPending(null);
        setProgress(null);
        setApplyError(null);
    };

    /*
     * 筛选那一段：随机轮换 + 来源 + 搜索 + 分类。
     * 横屏时整体挪到左栏，右栏只留卡片（见 MarketPage）。
     */
    const filterBlock = (
        <>
            {/* 随机轮换：隔一段时间自己换一张 */}
            <MarketRotationSection />

            {/* 源 */}
            <div className="flex gap-1.5">
                {BACKGROUND_MARKET_SOURCES.map((entry) => {
                    const active = source === entry.id;
                    return (
                        <Button
                            key={entry.id}
                            onClick={() => {
                                setSource(entry.id);
                                setCategory('');
                                setKeyword('');
                            }}
                            className={`flex-1 rounded-lg px-2 py-1.5 text-[12px] transition-colors ${
                                active
                                    ? 'bg-[var(--st-accent)] text-[var(--st-on-accent)]'
                                    : 'bg-[var(--st-fill)] text-[var(--st-t2)] hover:bg-[var(--st-fill2)]'
                            }`}
                        >
                            {entry.label}
                        </Button>
                    );
                })}
            </div>

            {/* 搜索 */}
            <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--st-t2)]" />
                <TextField
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder={t('options.marketSearchBackgroundPlaceholder')}
                    className="h-8 w-full rounded-lg bg-[var(--st-fill)] pl-7 pr-8 text-[12.5px] text-[var(--st-t1)] outline-none placeholder:text-[var(--st-t2)]"
                />
                {keyword !== '' && (
                    <Button
                        onClick={() => setKeyword('')}
                        aria-label={t('options.marketSearchClear')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--st-t2)]"
                    >
                        <X size={13} />
                    </Button>
                )}
            </div>

            {/* 分类 */}
            {keyword === '' && categories.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                    {categories.map((entry) => {
                        const active = category === entry.slug;
                        return (
                            <Button
                                key={entry.slug}
                                onClick={() => setCategory(entry.slug)}
                                className={`rounded-full px-2.5 py-1 text-[11.5px] ${
                                    active
                                        ? 'bg-[var(--st-accent)] text-[var(--st-on-accent)]'
                                        : 'bg-[var(--st-fill)] text-[var(--st-t2)]'
                                }`}
                            >
                                {entry.label}
                            </Button>
                        );
                    })}
                </div>
            )}

            {/* 当前应用中的背景 */}
            {target && (
                <div className="flex items-center gap-2 rounded-lg bg-[var(--st-fill)] px-2.5 py-1.5 text-[11.5px] text-[var(--st-t2)]">
                    <span className="truncate">
                        {t('options.marketAppliedBackground')}：{target.name || t('options.marketAppliedBackgroundUntitled')}
                    </span>
                </div>
            )}

            {error && items.length === 0 && (
                <div className="rounded-lg bg-[var(--st-fill)] px-3 py-2 text-[12px] text-[var(--st-t2)]">{error}</div>
            )}

            {notice && (
                <div className="rounded-lg bg-[var(--st-fill)] px-3 py-2 text-[12px] text-[var(--st-t2)]">
                    {notice}
                </div>
            )}

            {keyword !== '' && !loading && items.length === 0 && !error && (
                <div className="rounded-lg bg-[var(--st-fill)] px-3 py-2 text-[12px] text-[var(--st-t2)]">
                    {t('options.marketSearchEmpty')}
                </div>
            )}
        </>
    );

    const contentBlock = (
        <>
            {loading && items.length === 0 && (
                <div className="py-10 text-center text-[13px] text-[var(--st-t2)]">{t('options.marketLoading')}</div>
            )}

            {/*
             * 卡片网格按宽度自适应。
             *
             * 竖屏时 2 列刚好；横屏或大屏下如果仍固定 2 列，
             * 每张卡被拉得很宽、右边留一大片空 ——
             * 所以让列数跟着可用宽度走：至少 150px 一列，放得下几列就放几列。
             */}
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                {items.map((item) => (
                    <Button
                        key={item.id}
                        onClick={() => {
                            setApplyError(null);
                            setProgress(null);
                            setPending(item);
                        }}
                        className="overflow-hidden rounded-xl bg-[var(--st-fill)] p-1.5 text-left transition-colors hover:bg-[var(--st-fill2)]"
                    >
                        <div className="relative aspect-video overflow-hidden rounded-lg bg-[var(--st-fill2)]">
                            {item.thumbnailUrl && (
                                <img
                                    src={item.thumbnailUrl}
                                    alt=""
                                    loading="lazy"
                                    className="h-full w-full object-cover"
                                />
                            )}
                            {item.kind === 'video' && (
                                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">
                                    {t('options.marketKindVideo')}
                                </span>
                            )}
                        </div>
                        <div className="mt-1 truncate px-0.5 text-[11.5px] text-[var(--st-t1)]">{item.name}</div>
                    </Button>
                ))}
            </div>

            <div className="flex items-center justify-center gap-2 pt-1">
                {loading && items.length > 0 && <span className="text-[11.5px] text-[var(--st-t2)]">{t('options.marketLoading')}</span>}
                {!loading && hasMore && (
                    <Button onClick={loadMore} className="rounded-lg bg-[var(--st-fill)] px-3 py-1 text-[11.5px] text-[var(--st-t2)]">
                        {t('options.marketLoadMore')}
                    </Button>
                )}
                {!loading && error && items.length > 0 && (
                    <Button onClick={reload} className="rounded-lg bg-[var(--st-fill)] px-3 py-1 text-[11.5px] text-[var(--st-t2)]">
                        {t('options.marketRetry')}
                    </Button>
                )}
            </div>
        </>
    );

    return (
        <div className="space-y-3">
            {part !== 'content' && filterBlock}
            {part !== 'filters' && contentBlock}

            <MarketApplyDialog<BackgroundTarget>
                isOpen={pending !== null}
                isDaylight={false}
                title={t('options.marketApplyWhere')}
                itemName={pending?.name ?? ''}
                choices={choices}
                /*
                 * 默认只勾「桌面壁纸」。
                 *
                 * 以前两项都勾着，用户以为只选了桌面，结果播放页也被改了 ——
                 * 两个地方差别很大（一个动系统壁纸，一个动 App 内背景），
                 * 不该替他一起决定。想两处都换就自己再点一下。
                 */
                defaults={['wallpaper']}
                progress={progress}
                progressLabel={progressLabel}
                error={applyError}
                onCancel={closeDialog}
                onConfirm={handleConfirm}
            />
        </div>
    );
};

export default MarketBackgroundSection;
