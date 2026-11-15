import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { SongResult, StatusMessage } from '../../../../types';
import type {
    CollectionMutationBranches,
    CollectionMutationCapabilities,
    CollectionMutationController,
    CollectionMutationSnapshot,
    LibraryMutationResult,
} from '../../../core/collection/mutations/mutations.contract';
import type { CollectionResource } from '../../../core/shared/resource.contract';
import { TRACK_REMOVAL_ANIMATION_MS } from './useGridViewCards';

// src/library/suites/grid/collection/useGridViewMutations.ts
// GridView 的来源动作与本地状态：改名 / 删除 / 重扫 / 导出 / 加入歌单、订阅、每日推荐、删条目与四个对话框。
// 原 GridView.tsx 的状态、useCallback 与两个 effect 原样搬出（依赖数组不变）。

export interface GridViewMutationsParams {
    title: string;
    collection: any;
    collectionName?: string;
    /** 集合的变更控制器；没有时（性能探针）什么都不支持。 */
    mutations: CollectionMutationController | null;
    mutationSnapshot: CollectionMutationSnapshot;
    mutationCapabilities: CollectionMutationCapabilities;
    mutationBranches: CollectionMutationBranches;
    /** 加入歌单 / 新建歌单作用的歌（collectionView.playableTracks）。 */
    playableTracks: SongResult[];
    /** 续传与重新拉取都交给资源。 */
    resource: CollectionResource | null;
    /** 删条目时按住展示（useCollectionResourceState）。 */
    holdPresentation: (token: string) => void;
    releasePresentation: (token: string) => void;
    onBack: () => void;
    onStatusMessage?: (message: StatusMessage) => void;
    isLocalFolderCollection: boolean;
    isLocalAllSongsCollection: boolean;
    isDailyRecommendationsCollection: boolean;
    t: TFunction;
}

export const useGridViewMutations = ({
    title,
    collection,
    collectionName,
    mutations,
    mutationSnapshot,
    mutationCapabilities,
    mutationBranches,
    playableTracks,
    resource,
    holdPresentation,
    releasePresentation,
    onBack,
    onStatusMessage,
    isLocalFolderCollection,
    isLocalAllSongsCollection,
    isDailyRecommendationsCollection,
    t,
}: GridViewMutationsParams) => {
    const { canEditOwnedPlaylist, canEditProviderPlaylist } = mutationBranches;
    const [removingTrackKeys, setRemovingTrackKeys] = useState<Set<string>>(() => new Set());
    const trackRemovalTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    const trackRemovalSeqRef = useRef(0);
    const [isEditMode, setIsEditMode] = useState(false);
    const [editableTitle, setEditableTitle] = useState(title);
    const [isPlaylistPickerOpen, setIsPlaylistPickerOpen] = useState(false);
    const [isCreatePlaylistOpen, setIsCreatePlaylistOpen] = useState(false);
    const [isDeleteFolderOpen, setIsDeleteFolderOpen] = useState(false);
    /** 待确认的本地删歌：文件夹集合里删一首是真的从曲库移除（安卓还删副本），所以先问一句。 */
    const [pendingLocalRemoval, setPendingLocalRemoval] = useState<{ track: SongResult; entryKey: string } | null>(null);
    // 删除的结果可能在网格卸载之后才回来（控制器属于集合会话，不随网格卸载）：那时什么都不用做。
    const isMountedRef = useRef(false);
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    // Keeps a successfully removed card on screen until its flip-and-fade transition finishes: the resource
    // has already dropped it, the held presentation keeps showing the frame from before until the release.
    const playTrackRemovalAnimation = useCallback((trackKey: string, holdToken: string) => {
        setRemovingTrackKeys(current => new Set(current).add(trackKey));
        const timeout = setTimeout(() => {
            trackRemovalTimeoutsRef.current.delete(trackKey);
            releasePresentation(holdToken);
            setRemovingTrackKeys(current => {
                const next = new Set(current);
                next.delete(trackKey);
                return next;
            });
        }, TRACK_REMOVAL_ANIMATION_MS);
        trackRemovalTimeoutsRef.current.set(trackKey, timeout);
    }, [releasePresentation]);

    useEffect(() => () => {
        trackRemovalTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
        trackRemovalTimeoutsRef.current.clear();
    }, []);


    useEffect(() => {
        setEditableTitle(title);
        setIsEditMode(false);
    }, [collection?.id, title]);

    const canRename = mutationCapabilities.rename.supported;
    const canMatchSong = mutationCapabilities.matchSong.supported;
    const handleSourceEditToggle = useCallback(async () => {
        if (!collection) return;

        if (!isEditMode) {
            setEditableTitle(collectionName || title);
            setIsEditMode(true);
            return;
        }

        // 改名经控制器（空名字或没变时它直接返回 ok）；没改成就留在编辑模式。不能改名的集合（每日推荐）直接退出。
        if (canRename && mutations) {
            const result = await mutations.rename(editableTitle);
            if (!result.ok) return;
        }
        setIsEditMode(false);
    }, [
        canRename,
        collection,
        collectionName,
        editableTitle,
        isEditMode,
        mutations,
        title,
    ]);

    // 删除成功才返回上一层（文件夹先经确认对话框）。
    const handleDeleteSourceCollection = useCallback(async () => {
        const result = await mutations?.deleteCollection();
        if (result?.ok) onBack();
    }, [mutations, onBack]);

    const handleResyncLocalFolder = useCallback(() => void mutations?.resyncFolder(), [mutations]);
    const handleResyncAllLocalFolders = useCallback(() => void mutations?.resyncAllFolders(), [mutations]);
    const handleExportLocalPlaylist = useCallback(() => void mutations?.exportPlaylist(), [mutations]);
    const handleOrganizeSongInfo = useCallback(() => void mutations?.organizeSongInfo(), [mutations]);
    const handleEditEntity = useCallback(() => void mutations?.editEntity(), [mutations]);
    const handleSetCover = useCallback(() => void mutations?.setCover(), [mutations]);

    const handleAddNavidromeCollectionToPlaylist = useCallback(async (playlistId: string | number) => {
        await mutations?.addToPlaylist(playlistId, playableTracks);
    }, [mutations, playableTracks]);

    const handleCreateNavidromePlaylist = useCallback(async (name: string) => {
        const result = await mutations?.createPlaylist(name, playableTracks);
        if (result?.ok) setIsCreatePlaylistOpen(false);
    }, [mutations, playableTracks]);

    // 续传、重新拉取都交给资源；资源负责作废晚到的旧结果。
    const resumeBackgroundSync = () => resource?.resumeSync();
    const reloadOnlineCollection = () => resource?.reload();

    // An owned online playlist edits in place; a local or Navidrome one commits a rename on the way
    // out. Shared so the command palette and the panel button cannot end up meaning different things.
    const handleEditModeToggle = useCallback(() => {
        if (canEditOwnedPlaylist || canEditProviderPlaylist) {
            setIsEditMode(prev => !prev);
            return;
        }
        void handleSourceEditToggle();
    }, [canEditOwnedPlaylist, canEditProviderPlaylist, handleSourceEditToggle]);

    // 订阅状态在控制器第一次被订阅时取。星星一按就变：控制器先改显示，再在后台问平台，请求期间再按只改「要的」，
    // 请求跟着它走；平台没答应时星星回到平台上的样子，这里说一句（按下时的那一页已经关了也说）。
    const playlistSubscribed = mutationSnapshot.subscribed;
    const [starPresses, setStarPresses] = useState(0);
    const handleToggleSubscribe = async () => {
        if (!mutations) return;
        setStarPresses(count => count + 1);
        const result = await mutations.toggleSubscribe();
        if (!result.ok && result.reason === 'failed') {
            onStatusMessage?.({
                type: 'error',
                text: t(mutations.getSnapshot().subscribed ? 'status.collectionUnsaveFailed' : 'status.collectionSaveFailed'),
                nonce: Date.now(),
            });
        }
    };

    // Switches the virtual playlist between today's recommendations and a supported history date.
    const handleDailyRecommendationDateChange = useCallback(async (date: string, afresh = false) => {
        if (!mutations || !mutationCapabilities.dailyDate.supported) return;
        setIsEditMode(false);
        // 整表替换经控制器交给资源（加载中状态、作废晚到结果都在那里）；失败时保持原样，日期也不切。
        await mutations.setDailyDate(date, { afresh });
    }, [mutationCapabilities.dailyDate.supported, mutations]);

    // 本地文件夹（含虚拟的「全部歌曲」）里删一首是真的从曲库移除：安卓上导入时复制的那份音频也一起删，
    // 所以要确认；歌单里的「删」只是把歌挪出歌单，不用问。
    const confirmLocalSongRemoval = mutationCapabilities.removeEntry.supported
        && (isLocalFolderCollection || isLocalAllSongsCollection);

    // 删一个条目（每日推荐是「不喜欢并换一首」）：先按住展示，控制器在上游确认后立即提交给资源；成功就给卡片
    // 打上 removing 播退出动画，动画结束再放开展示，失败立即放开。entryKey 就是卡片 id：重复序号在完整的
    // 展示列表上算（不受筛选影响），控制器自己在资源里解出原始下标。
    const runRemoveTrack = useCallback(async (track: SongResult, entryKey: string) => {
        if (!mutations || trackRemovalTimeoutsRef.current.has(entryKey)) return;
        trackRemovalSeqRef.current += 1;
        // 每次点击一个 token：同一张卡连点时，被挡掉（busy）的那一次只放开自己的，不会提前放开第一次的。
        const holdToken = `remove:${entryKey}:${trackRemovalSeqRef.current}`;
        holdPresentation(holdToken);
        let result: LibraryMutationResult;
        try {
            result = await mutations.removeEntry({ entryKey, track });
        } catch (error) {
            console.error('Failed to remove track in GridView', error);
            result = { ok: false, reason: 'failed' };
        }
        if (!isMountedRef.current) return;
        if (result.ok) {
            playTrackRemovalAnimation(entryKey, holdToken);
            // 本地曲库的删歌没有「撤销」：告诉用户一声，顺便说明副本也删了。
            if (confirmLocalSongRemoval) {
                onStatusMessage?.({
                    type: 'success',
                    text: t('localMusic.songRemoved', { name: track.name }),
                    nonce: Date.now(),
                });
            }
            return;
        }
        releasePresentation(holdToken);
        if (result.reason === 'limit-reached') {
            onStatusMessage?.({
                type: 'info',
                text: t('home.noMoreDailyRecommendations'),
                nonce: Date.now(),
            });
        } else if (result.reason === 'failed') {
            onStatusMessage?.({
                type: 'error',
                text: isDailyRecommendationsCollection ? t('home.dislikeRecommendationFailed') : t('home.removeTrackFailed'),
                nonce: Date.now(),
            });
        }
    }, [
        confirmLocalSongRemoval,
        holdPresentation,
        isDailyRecommendationsCollection,
        mutations,
        onStatusMessage,
        playTrackRemovalAnimation,
        releasePresentation,
        t,
    ]);

    // 卡片上的删除按钮走这里：本地曲库的删歌先弹确认，其余照旧直接删。
    const handleRemoveTrack = useCallback(async (track: SongResult, entryKey: string) => {
        if (!confirmLocalSongRemoval) {
            await runRemoveTrack(track, entryKey);
            return;
        }
        setPendingLocalRemoval({ track, entryKey });
    }, [confirmLocalSongRemoval, runRemoveTrack]);

    // 网格项**惰性**塑形（见 lazyGridItems.ts）：length 立刻可用，真对象只在被读到下标时才塑形。
    // 原来整表 map 一遍，5000 首实测 120ms，而分页每来一页都要重算 —— 大歌单打开时卡在这里。

    return {
        removingTrackKeys,
        isEditMode,
        setEditableTitle,
        editableTitle,
        isPlaylistPickerOpen,
        setIsPlaylistPickerOpen,
        isCreatePlaylistOpen,
        setIsCreatePlaylistOpen,
        isDeleteFolderOpen,
        setIsDeleteFolderOpen,
        pendingLocalRemoval,
        setPendingLocalRemoval,
        canRename,
        canMatchSong,
        handleSourceEditToggle,
        handleDeleteSourceCollection,
        handleResyncLocalFolder,
        handleResyncAllLocalFolders,
        handleExportLocalPlaylist,
        handleOrganizeSongInfo,
        handleSetCover,
        handleEditEntity,
        handleAddNavidromeCollectionToPlaylist,
        handleCreateNavidromePlaylist,
        resumeBackgroundSync,
        reloadOnlineCollection,
        handleEditModeToggle,
        playlistSubscribed,
        starPresses,
        handleToggleSubscribe,
        handleDailyRecommendationDateChange,
        confirmLocalSongRemoval,
        runRemoveTrack,
        handleRemoveTrack,
    };
};
