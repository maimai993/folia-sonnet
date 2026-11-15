import { AnimatePresence, motion } from 'framer-motion';
import { Disc, Download, ImagePlus, ListPlus, Loader2, Pencil, Play, Plus, RefreshCw, Star, Tags, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getSizedCoverUrl } from '../../../../utils/coverUrl';
import { Button, TextField } from '../../../../components/ui';
import { useSidePanelBottomPx } from '../../../../hooks/usePlayerBottomBarBottomPx';
import { CustomSelect } from '../../../../components/shared/CustomSelect';
import type { SongResult, Theme } from '../../../../types';
import type { CollectionMutationCapabilities, CollectionMutationSnapshot } from '../../../core/collection/mutations/mutations.contract';
import { formatAlbumDate, formatAlbumDuration, toHttps } from './gridViewText';

// src/library/suites/grid/collection/GridViewCutInPanel.tsx
// GridView 左侧的切入信息面板（原 GridView.tsx 里那一整块 AnimatePresence），封面、标题、统计、描述与这一排来源动作原样搬出。

type GridViewCutInPanelProps = {
    isOpen: boolean;
    title: string;
    /** 合并后要显示的信息面板集合：描述等来自资源详情，改名来自控制器。 */
    infoCollection: any;
    coverUrl: string;
    /** 左侧动作区挂的 Ponder 目标（本地文件夹 / 在线集合），由 GridView 判定后传进来。 */
    actionsPonderTarget: string;
    isDaylight: boolean;
    theme: Theme;
    isLocalCollection: boolean;
    isLocalFolderCollection: boolean;
    isNavidromeCollection: boolean;
    isAlbumCollection: boolean;
    isDailyRecommendationsCollection: boolean;
    isCloudThemeCollection: boolean;
    /** 集合描述本身（删文件夹的文案按它的名称判断层级）。 */
    collection: any;
    loading: boolean;
    hasSearchQuery: boolean;
    displayTrackCount: number;
    contextActionTracks: SongResult[];
    playableTracks: SongResult[];
    albumAlias?: string;
    albumArtists: Array<{ id: string | number; name: string }>;
    albumPublishedAt?: number;
    albumPublisher?: string;
    mutationSnapshot: CollectionMutationSnapshot;
    mutationCapabilities: CollectionMutationCapabilities;
    isSourceActionPending: boolean;
    canRename: boolean;
    isEditMode: boolean;
    editableTitle: string;
    onEditableTitleChange: (value: string) => void;
    onToggleSourceEdit: () => void;
    onEditEntity: () => void;
    onToggleEditMode: () => void;
    canEditPlaylist: boolean;
    canReloadThisCollection: boolean;
    onReloadCollection: () => void;
    canAddNavidromeToPlaylist: boolean;
    onOpenPlaylistPicker: () => void;
    onRequestDeleteFolder: () => void;
    onDeleteCollection: () => void;
    confirmLocalSongRemoval: boolean;
    onExportPlaylist: () => void;
    onResyncFolder: () => void;
    onResyncAllFolders: () => void;
    onOrganizeSongInfo: () => void;
    onSetCover: () => void;
    showSubscribeButton: boolean;
    playlistSubscribed: boolean | null;
    isOnlineAlbum: boolean;
    starPresses: number;
    onToggleSubscribe: () => void;
    onDailyDateChange: (date: string, afresh?: boolean) => void;
    onPlayAll?: (songs: SongResult[]) => void;
    onAddAllToQueue?: (songs: SongResult[], options?: { suppressToast?: boolean }) => number | void;
    onSelectArtist?: (artistId: number | string, artist?: any, track?: SongResult) => void;
};

export const GridViewCutInPanel = ({
    isOpen,
    title,
    infoCollection,
    coverUrl,
    actionsPonderTarget,
    isDaylight,
    theme,
    isLocalCollection,
    isLocalFolderCollection,
    isNavidromeCollection,
    isAlbumCollection,
    isDailyRecommendationsCollection,
    isCloudThemeCollection,
    collection,
    loading,
    hasSearchQuery,
    displayTrackCount,
    contextActionTracks,
    playableTracks,
    albumAlias,
    albumArtists,
    albumPublishedAt,
    albumPublisher,
    mutationSnapshot,
    mutationCapabilities,
    isSourceActionPending,
    canRename,
    isEditMode,
    editableTitle,
    onEditableTitleChange,
    onToggleSourceEdit,
    onEditEntity,
    onToggleEditMode,
    canEditPlaylist,
    canReloadThisCollection,
    onReloadCollection,
    canAddNavidromeToPlaylist,
    onOpenPlaylistPicker,
    onRequestDeleteFolder,
    onDeleteCollection,
    confirmLocalSongRemoval,
    onExportPlaylist,
    onResyncFolder,
    onResyncAllFolders,
    onOrganizeSongInfo,
    onSetCover,
    showSubscribeButton,
    playlistSubscribed,
    isOnlineAlbum,
    starPresses,
    onToggleSubscribe,
    onDailyDateChange,
    onPlayAll,
    onAddAllToQueue,
    onSelectArtist,
}: GridViewCutInPanelProps) => {
    const { t } = useTranslation();
    const bottomBarPanelBottomPx = useSidePanelBottomPx();

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    data-wheel-scroll-region
                    onWheelCapture={event => event.stopPropagation()}
                    initial={{ opacity: 0, x: -60, scale: 0.95 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: -60, scale: 0.95 }}
                    transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    data-folia-cut-in-panel="true"
                    className="absolute left-6 top-24 w-80 rounded-3xl z-[80] overflow-y-auto overscroll-contain hide-scrollbar flex flex-col p-6 shadow-2xl border backdrop-blur-2xl pointer-events-auto theme-glass-panel"
                    style={{
                        bottom: bottomBarPanelBottomPx,
                        boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.2)',
                    }}
                >
                    {/* Cover Image */}
                    <div data-folia-cut-in-cover="true" className="w-full aspect-square rounded-2xl overflow-hidden shadow-lg mb-4 bg-zinc-800/20 relative shrink-0">
                        {coverUrl ? (
                            <img src={getSizedCoverUrl(toHttps(coverUrl), 512)} alt={infoCollection?.name || title} decoding="async" className="w-full h-full object-cover select-none pointer-events-none" />
                        ) : (
                            <Disc size={64} className="opacity-20 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                        )}
                        {showSubscribeButton && (
                            <Button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void onToggleSubscribe();
                                }}
                                className="absolute bottom-3 right-3 w-10 h-10 rounded-full flex items-center justify-center transition-all shadow-lg active:scale-90 z-10 border border-white/10 hover:scale-105 cursor-pointer backdrop-blur-md"
                                style={{
                                    backgroundColor: isDaylight ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.5)',
                                }}
                                tip={playlistSubscribed ? (isOnlineAlbum ? t('options.unsubscribeAlbum') : t('options.unsubscribePlaylist')) : (isOnlineAlbum ? t('options.subscribeAlbum') : t('options.subscribePlaylist'))}
                            >
                                <Star
                                    key={starPresses}
                                    size={18}
                                    className={`${starPresses > 0 ? 'star-pop ' : ''}${playlistSubscribed ? 'text-yellow-500 fill-yellow-500' : 'opacity-60 hover:opacity-100'}`}
                                    style={{ color: playlistSubscribed ? undefined : 'var(--text-primary)' }}
                                />
                            </Button>
                        )}
                    </div>

                    {/* Title & Creator */}
                    <div data-folia-cut-in-scroll="true" className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar pr-1 space-y-4 text-left min-w-0">
                        <div>
                            {canRename && isEditMode ? (
                                <TextField
                                    value={editableTitle}
                                    onChange={(event) => onEditableTitleChange(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault();
                                            void onToggleSourceEdit();
                                        }
                                    }}
                                    className="w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-xl font-bold outline-none transition-colors focus:border-sky-400"
                                    style={{ color: 'var(--text-primary)' }}
                                    autoFocus
                                />
                            ) : (
                                <Button
                                    disabled={!mutationCapabilities.editEntity.supported}
                                    onClick={onEditEntity}
                                    className="text-left text-xl font-bold line-clamp-2 leading-snug disabled:cursor-default"
                                >
                                    {infoCollection?.name || title}
                                </Button>
                            )}
                            {infoCollection?.creator && (
                                <div className="flex items-center gap-2 mt-2 text-xs opacity-60">
                                    <div className="w-5 h-5 rounded-full overflow-hidden">
                                        <img src={toHttps(infoCollection.creator.avatarUrl)} alt="avatar" className="w-full h-full object-cover" />
                                    </div>
                                    <span className="font-semibold">{infoCollection.creator.nickname}</span>
                                </div>
                            )}
                            <div className="text-[10px] opacity-40 mt-1.5">
                                {(isDailyRecommendationsCollection || infoCollection?.trackCount !== undefined) && (
                                    <span>{isDailyRecommendationsCollection ? displayTrackCount : infoCollection.trackCount} {t('home.songs')}</span>
                                )}
                                {infoCollection?.playCount !== undefined && <span> • {infoCollection.playCount} {t('playlist.plays')}</span>}
                            </div>
                            {isDailyRecommendationsCollection && (
                                <div className="mt-3 space-y-2">
                                    <div className="flex items-center gap-2">
                                        {mutationSnapshot.dailyHistoryAvailable && (
                                            <div className="min-w-0 flex-1">
                                                <CustomSelect
                                                    value={mutationSnapshot.dailyDate}
                                                    onChange={date => void onDailyDateChange(date)}
                                                    options={[
                                                        { value: '', label: t('home.todayRecommendations') },
                                                        ...mutationSnapshot.dailyHistoryDates.map(date => ({ value: date, label: date })),
                                                    ]}
                                                    placeholder={t('home.todayRecommendations')}
                                                    ariaLabel={t('home.recommendationDate')}
                                                    disabled={loading}
                                                    isDaylight={isDaylight}
                                                    theme={theme}
                                                />
                                            </div>
                                        )}
                                        <Button
                                            onClick={() => void onDailyDateChange('', true)}
                                            disabled={loading || Boolean(mutationSnapshot.dailyDate)}
                                            title={t('home.refreshRecommendations')}
                                            aria-label={t('home.refreshRecommendations')}
                                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 transition-colors hover:bg-white/10 disabled:opacity-30"
                                        >
                                            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                                        </Button>
                                    </div>
                                </div>
                            )}
                            {isAlbumCollection && (
                                <div className="mt-3 space-y-1.5 text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                    {albumAlias && (
                                        <div className="font-medium opacity-80">{albumAlias}</div>
                                    )}
                                    {albumArtists.length > 0 ? (
                                        <div className="flex flex-wrap gap-x-2 gap-y-1">
                                            {albumArtists.map((artist: { id: string | number; name: string }, index: number) => (
                                                <Button
                                                    key={`${artist.id}-${index}`}
                                                    onClick={() => onSelectArtist?.(artist.id, artist)}
                                                    className="font-semibold hover:underline"
                                                >
                                                    {artist.name}
                                                </Button>
                                            ))}
                                        </div>
                                    ) : null}
                                    {albumArtists.length === 0 && infoCollection?.albumArtist && (
                                        <div className="font-semibold">{infoCollection.albumArtist}</div>
                                    )}
                                    {(formatAlbumDate(albumPublishedAt) || albumPublisher) && (
                                        <div>
                                            {[formatAlbumDate(albumPublishedAt), albumPublisher]
                                                .filter(Boolean)
                                                .join(' • ')}
                                        </div>
                                    )}
                                    {isNavidromeCollection && (
                                        <div>
                                            {[infoCollection?.albumYear, infoCollection?.albumGenre, formatAlbumDuration(infoCollection?.albumDuration)]
                                                .filter(Boolean)
                                                .join(' • ')}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Description */}
                        {infoCollection?.description && (
                            <p data-wheel-scroll-region className="text-xs opacity-65 leading-relaxed break-words whitespace-pre-wrap max-h-40 overflow-y-auto overscroll-contain pr-1">
                                {infoCollection.description}
                            </p>
                        )}
                    </div>

                    {/* Buttons Area */}
                    <div
                        // 这一排里有重扫、整理 tag 和删除，删除是不可逆的 ——
                        // 思索把整块认成一个目标，指着哪一颗都讲得到。
                        data-ponder={actionsPonderTarget}
                        // 手机横屏那档要把这排的间距/内边距/字号一起收一档（见 androidPhoneFit.css）。
                        data-folia-cut-in-actions="true"
                        className="space-y-2 mt-4 pt-4 border-t shrink-0"
                        style={{ borderTopColor: 'color-mix(in srgb, var(--text-primary) 12%, transparent)' }}
                    >
                        <Button
                            onClick={() => {
                                if (onPlayAll && contextActionTracks.length > 0) {
                                    onPlayAll(contextActionTracks);
                                }
                            }}
                            disabled={contextActionTracks.length === 0}
                            className="w-full py-3 rounded-full font-bold text-xs transition-transform hover:scale-102 active:scale-98 flex items-center justify-center gap-1.5 shadow-md disabled:opacity-40 disabled:hover:scale-100 cursor-pointer"
                            style={{ backgroundColor: 'var(--text-primary)', color: 'var(--bg-color)' }}
                        >
                            <Play size={14} fill="currentColor" />
                            {hasSearchQuery
                                ? t('playlist.playFilteredTracks', { count: contextActionTracks.length })
                                : t('playlist.playAll')}
                        </Button>
                        <Button
                            onClick={() => {
                                if (onAddAllToQueue && contextActionTracks.length > 0) {
                                    onAddAllToQueue(contextActionTracks);
                                }
                            }}
                            disabled={contextActionTracks.length === 0}
                            className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                        >
                            <ListPlus size={14} />
                            {hasSearchQuery
                                ? t('playlist.addFilteredTracksToQueue', { count: contextActionTracks.length })
                                : t('navidrome.addToQueue')}
                        </Button>
                        {canAddNavidromeToPlaylist && (
                            <Button
                                onClick={() => onOpenPlaylistPicker()}
                                disabled={playableTracks.length === 0 || isSourceActionPending}
                                className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                            >
                                <Plus size={14} />
                                {t('localMusic.addToPlaylist')}
                            </Button>
                        )}
                        {mutationCapabilities.resyncFolder.supported && (
                            <Button
                                onClick={onResyncFolder}
                                disabled={isSourceActionPending}
                                className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                            >
                                {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                {t('localMusic.reimport')}
                            </Button>
                        )}
                        {mutationCapabilities.organizeSongInfo.supported && (
                            <Button
                                onClick={onOrganizeSongInfo}
                                className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                                <Tags size={14} />
                                {t('localMusic.organizeSongInfo')}
                            </Button>
                        )}
                        {mutationCapabilities.setCover.supported && (
                            <Button
                                onClick={onSetCover}
                                className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-800/15 dark:hover:bg-zinc-100/20"
                            >
                                <ImagePlus size={14} />
                                {t('localCollectionCover.menuLabel')}
                            </Button>
                        )}
                        {mutationCapabilities.resyncAllFolders.supported && (
                            <Button
                                onClick={onResyncAllFolders}
                                disabled={isSourceActionPending}
                                className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                            >
                                {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                {t('localMusic.reimport')}
                            </Button>
                        )}
                        {canReloadThisCollection && (
                            <Button
                                onClick={onReloadCollection}
                                disabled={loading}
                                className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                            >
                                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                                {isCloudThemeCollection ? t('playlist.reloadCloudTheme') : t('playlist.reload')}
                            </Button>
                        )}
                        {canEditPlaylist && (
                            <Button
                                onClick={onToggleEditMode}
                                disabled={isSourceActionPending}
                                // 思索靠这个属性认出它。类名会改，属性不会。
                                data-ponder="grid-view-edit-mode"
                                className={`w-full py-2.5 rounded-full text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${isEditMode ? 'bg-red-500/20 text-red-500 border border-red-500/30' : 'bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900'}`}
                            >
                                {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={14} />}
                                {isDailyRecommendationsCollection
                                    ? (isEditMode ? t('home.finishManagingRecommendations') : t('home.manageRecommendations'))
                                    : confirmLocalSongRemoval
                                        // 文件夹集合：这个开关用来逐首删歌，不是编辑歌单。
                                        ? (isEditMode ? t('localMusic.finishManaging') : t('localMusic.manageSongs'))
                                        : (isEditMode ? t('localMusic.finishEditing') : t('localMusic.editPlaylist'))}
                            </Button>
                        )}
                        {mutationCapabilities.exportPlaylist.supported && (
                            <Button
                                onClick={onExportPlaylist}
                                disabled={isSourceActionPending}
                                className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                            >
                                {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                                {t('localMusic.exportPlaylist')}
                            </Button>
                        )}
                        {mutationCapabilities.editEntity.supported && (
                            <Button
                                onClick={onEditEntity}
                                className="w-full py-2.5 rounded-full text-xs font-semibold bg-zinc-800/10 dark:bg-zinc-100/10 hover:bg-zinc-900 hover:text-zinc-100 dark:hover:bg-zinc-100 dark:hover:text-zinc-900 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                                <Pencil size={14} />
                                {t('localMusic.entityInfo', {
                                    kind: collection.type === 'album'
                                        ? t('localMusic.albumLabel')
                                        : t('localMusic.artistLabel'),
                                })}
                            </Button>
                        )}
                        {mutationCapabilities.deleteCollection.supported && (
                            <Button
                                onClick={() => isLocalFolderCollection ? onRequestDeleteFolder() : void onDeleteCollection()}
                                disabled={isSourceActionPending}
                                className="w-full py-2.5 rounded-full text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer bg-red-500/10 text-red-500 border border-red-500/25 hover:bg-red-500/20 disabled:opacity-40"
                            >
                                {isSourceActionPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                {isLocalFolderCollection
                                    ? t('localMusic.delete')
                                    : t('localMusic.deletePlaylist')}
                            </Button>
                        )}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default GridViewCutInPanel;
