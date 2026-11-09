// src/components/modal/settings/pages/integration/market/MarketFontSection.tsx
//
// 字体市场。
//
// 交互定稿：
//   点卡片 → 弹窗问「要应用在哪里？」→ 点确认 → 弹窗原地变下载进度 → 装好自动应用。
//
// 之前的问题是点了只下载、不问去处，用户还得再翻设置改一次；字体分类也只有中文那排能用。
// 这里分类直接照抄源站导航（见 FONTS_CN_CATEGORIES），并带搜索。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { FONTS_CN_CATEGORIES, categoryPreviewText, describeFontsCnError, type FontsCnItem } from '../../../../../../services/fontMarket/fontsNetCn';
import { fontDownloadProgress } from '../../../../../../platform/foliaWallpaper';
import { isCapacitorAndroid } from '../../../../../../platform/runtime';
import FontCardPreview from './FontCardPreview';
import MarketApplyDialog, { type ApplyTargetChoice } from './MarketApplyDialog';
import { applyFontTargets } from './applyFontTargets';
import { useFontMarketTarget, type FontMarketTarget } from './useFontMarketTarget';
import { useFontsCnCatalog } from './useFontsCnCatalog';

const MarketFontSection: React.FC = () => {
    const { t } = useTranslation();
    const [category, setCategory] = useState('zh');
    const [keyword, setKeyword] = useState('');
    const { items, loading, error, hasMore, loadMore, reload } = useFontsCnCatalog(category, keyword);
    const { target, setTarget, updateAppliesTo } = useFontMarketTarget();
    const [previewText, setPreviewText] = useState(categoryPreviewText('zh'));

    // 弹窗状态
    const [pending, setPending] = useState<FontsCnItem | null>(null);
    const [progress, setProgress] = useState<number | null>(null);
    const [progressLabel, setProgressLabel] = useState('');
    const [applyError, setApplyError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const categories = useMemo(() => FONTS_CN_CATEGORIES, []);
    const grouped = useMemo(() => ({
        type: categories.filter((entry) => entry.group === 'type'),
        style: categories.filter((entry) => entry.group === 'style'),
        foundry: categories.filter((entry) => entry.group === 'foundry'),
    }), [categories]);

    /*
     * 预览默认文字按分类走。
     *
     * 用户报过「英文分类点进去一片空白」—— 原因是预览样文写死成中文，
     * 而英文字体没有汉字字形，站点渲染器给回一张空白图。
     * 分类切换时重置成该分类的默认样文，用户手动改过的则保留。
     */
    const [previewTouched, setPreviewTouched] = useState(false);
    useEffect(() => {
        if (!previewTouched) setPreviewText(categoryPreviewText(category));
    }, [category, previewTouched]);

    const choices: ApplyTargetChoice<FontMarketTarget>[] = useMemo(() => [
        { id: 'lyric', label: t('options.marketTargetLyric'), hint: t('options.marketFontTargetLyricHint') },
        /*
         * 字幕这一项**去掉了**：字幕设置里根本没有「字体」这个选项 ——
         * 只有字号、布局、透明度。勾了它不会有任何变化，
         * 留着就是在骗用户「选了字幕但什么也没发生」。
         * 等哪天真给字幕加了字体设置，再把这一条加回来。
         */
        { id: 'wallpaper', label: t('options.marketTargetWallpaper'), hint: t('options.marketFontTargetWallpaperHint'), disabled: !isCapacitorAndroid(), disabledHint: t('options.marketTargetWallpaperAndroidOnly') },
    ], [t]);

    /**
     * 确认应用：下载 → 解压 → 注册 → 记录应用范围。
     *
     * 进度来自原生的 fontDownloadProgress 事件；解压和注册很快，所以后半程直接推满。
     */
    const handleConfirm = useCallback(async (targets: FontMarketTarget[]) => {
        if (!pending) return;
        setApplyError(null);
        setProgress(0);
        setProgressLabel(t('options.marketFontProgress'));
        try {
            const { installFontsCnFont } = await import('../../../../../../services/fontMarket/fontsNetCnFont');
            /*
             * applyToApp 只在勾了「歌词字体」时才为真。
             *
             * 桌面歌词（悬浮窗）和 App 内歌词是两套字体通道：
             *   · App 内 = 网页侧注册 FontFace
             *   · 悬浮窗 = 原生渲染，要推字节（见 applyFontTargets）
             * 以前这里无条件改 App 内字体，所以单勾悬浮窗也会把播放页改掉。
             */
            const result = await installFontsCnFont(pending.id, pending.name, {
                applyToApp: targets.includes('lyric'),
            });
            if (!result.ok) {
                setApplyError(result.error ?? t('options.marketRetry'));
                setProgress(null);
                return;
            }
            setProgress(1);
            setProgressLabel(t('options.marketFontProgressInstall'));
            // 记下「这个字体用在哪」，供市场里事后改范围；字体本身已由 store 生效。
            if (result.family) {
                setTarget({ family: result.family, fontId: pending.id, name: pending.name, appliesTo: targets });
                /*
                 * 光记下来没用 —— 桌面歌词是原生画的，必须把字体字节推过去
                 * （见 applyFontTargets）。result.file 就是刚读出来的那份。
                 */
                await applyFontTargets(targets, result.file);
            }
            // 装完就关，用户能立刻在可视化里看到效果。
            setPending(null);
            setProgress(null);
        } catch {
            setApplyError(t('options.marketRetry'));
            setProgress(null);
        } finally {
            /*
             * busyId 必须**无论如何**都清掉。
             *
             * 它用来挡住「正在处理时再点第二张卡片」，而 handleCardClick 开头
             * 就是 `if (busyId) return`。之前成功路径忘了清它，
             * 于是应用完一张之后所有卡片都点不动，非得重开面板 ——
             * 就是这个原因。
             */
            setBusyId(null);
        }
    }, [pending, setTarget, t]);

    /** 点卡片：先问去处，不直接下载。 */
    const handleCardClick = (item: FontsCnItem) => {
        if (busyId) return;
        setBusyId(item.id);
        setApplyError(null);
        setProgress(null);
        setPending(item);
    };

    // 订阅原生下载进度
    const offRef = useRef<(() => void) | null>(null);
    useEffect(() => {
        let disposed = false;
        void fontDownloadProgress((payload) => {
            if (disposed || !pending) return;
            if (payload.fontId !== pending.id) return;
            if (payload.total > 0) {
                setProgress(Math.min(0.95, payload.downloaded / payload.total));
            }
        }).then((handle) => {
            offRef.current = handle;
        });
        return () => {
            disposed = true;
            offRef.current?.();
            offRef.current = null;
        };
    }, [pending]);

    const handleCloseDialog = () => {
        setPending(null);
        setProgress(null);
        setBusyId(null);
        setApplyError(null);
    };

    const renderChipRow = (label: string, entries: typeof categories) => (
        <div>
            <div className="mb-1 text-[11px] text-[var(--st-t2)]">{label}</div>
            <div className="flex flex-wrap gap-1.5">
                {entries.map((entry) => {
                    const active = category === entry.slug;
                    return (
                        <button
                            key={entry.slug}
                            type="button"
                            onClick={() => {
                                setCategory(entry.slug);
                                setPreviewTouched(false);
                                setPreviewText(categoryPreviewText(entry.slug));
                            }}
                            className={`rounded-full px-2.5 py-1 text-[12px] transition-colors ${
                                active
                                    ? 'bg-[var(--st-accent)] text-[var(--st-on-accent)]'
                                    : 'bg-[var(--st-fill)] text-[var(--st-t2)] hover:bg-[var(--st-fill2)]'
                            }`}
                        >
                            {entry.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );

    return (
        <div className="space-y-3">
            {/* 搜索 */}
            <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--st-t2)]" />
                <input
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder={t('options.marketSearchPlaceholder')}
                    className="h-8 w-full rounded-lg bg-[var(--st-fill)] pl-7 pr-8 text-[12.5px] text-[var(--st-t1)] outline-none placeholder:text-[var(--st-t2)]"
                />
                {keyword !== '' && (
                    <button
                        type="button"
                        onClick={() => setKeyword('')}
                        aria-label={t('options.marketSearchClear')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--st-t2)]"
                    >
                        <X size={13} />
                    </button>
                )}
            </div>

            {/* 分类：照抄源站导航 */}
            {keyword === '' && (
                <div className="space-y-2">
                    {renderChipRow(t('options.marketFontGroupType') || '分类', grouped.type)}
                    {renderChipRow(t('options.marketFontGroupStyle') || '风格', grouped.style)}
                    {renderChipRow(t('options.marketFontGroupFoundry') || '字库', grouped.foundry)}
                </div>
            )}

            {/* 自定义预览文字 */}
            <input
                value={previewText}
                onChange={(event) => {
                    setPreviewTouched(true);
                    setPreviewText(event.target.value);
                }}
                placeholder={t('options.marketPreviewText')}
                className="h-7 w-full rounded-lg bg-[var(--st-fill)] px-2.5 text-[12px] text-[var(--st-t1)] outline-none placeholder:text-[var(--st-t2)]"
            />

            {/* 当前应用中的字体 */}
            {target && (
                <div className="flex items-center gap-2 rounded-lg bg-[var(--st-fill)] px-2.5 py-1.5 text-[11.5px] text-[var(--st-t2)]">
                    <span className="truncate">{t('options.marketAppliedFont')}：{target.name}</span>
                    <button
                        type="button"
                        onClick={() => {
                            /*
                             * 重挑应用范围：只改记录，不重新下载。
                             * 但改完必须再 applyFontTargets 一次 ——
                             * 否则新勾上的桌面歌词那处开关还是旧的，
                             * 用户会看到「勾了没反应」。
                             * 这里不传文件：字体没变，原生那份还在。
                             */
                            updateAppliesTo(target.appliesTo);
                            void applyFontTargets(target.appliesTo);
                        }}
                        className="ml-auto shrink-0 text-[var(--st-accent)]"
                    >
                        {t('options.marketApplyTargets')}
                    </button>
                </div>
            )}

            {error && items.length === 0 && (
                <div className="rounded-lg bg-[var(--st-fill)] px-3 py-2 text-[12px] text-[var(--st-t2)]">{error}</div>
            )}

            {keyword !== '' && !loading && items.length === 0 && !error && (
                <div className="rounded-lg bg-[var(--st-fill)] px-3 py-2 text-[12px] text-[var(--st-t2)]">
                    {t('options.marketSearchEmpty')}
                </div>
            )}

            {/* 卡片：列数跟着可用宽度走，横屏时不会只在左边堆两列。 */}
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => handleCardClick(item)}
                        className="overflow-hidden rounded-xl bg-[var(--st-fill)] p-1.5 text-left transition-colors hover:bg-[var(--st-fill2)]"
                    >
                        <FontCardPreview item={item} text={previewText} />
                        <div className="mt-1 truncate px-0.5 text-[11.5px] text-[var(--st-t1)]">{item.name}</div>
                    </button>
                ))}
            </div>

            <div className="flex items-center justify-center gap-2 pt-1">
                {loading && <span className="text-[11.5px] text-[var(--st-t2)]">{t('options.marketLoading')}</span>}
                {!loading && hasMore && (
                    <button type="button" onClick={loadMore} className="rounded-lg bg-[var(--st-fill)] px-3 py-1 text-[11.5px] text-[var(--st-t2)]">
                        {t('options.marketLoadMore')}
                    </button>
                )}
                {!loading && error && items.length > 0 && (
                    <button type="button" onClick={reload} className="rounded-lg bg-[var(--st-fill)] px-3 py-1 text-[11.5px] text-[var(--st-t2)]">
                        {t('options.marketRetry')}
                    </button>
                )}
            </div>

            <MarketApplyDialog<FontMarketTarget>
                isOpen={pending !== null}
                isDaylight={false}
                title={t('options.marketApplyWhere')}
                itemName={pending?.name ?? ''}
                choices={choices}
                defaults={['lyric']}
                progress={progress}
                progressLabel={progressLabel}
                error={applyError}
                onCancel={handleCloseDialog}
                onConfirm={handleConfirm}
            />
        </div>
    );
};

export default MarketFontSection;
