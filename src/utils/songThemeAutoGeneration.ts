import type { LyricData, SongResult } from '../types';
import { getPlaybackSongKey, getPlaybackSourceRef } from './appPlaybackGuards';

// src/utils/songThemeAutoGeneration.ts
// Pure guards for deciding whether playback should auto-generate a song AI theme.

export type SongThemeAutoGenerationDecisionInput = {
    enabled: boolean;
    currentSong: SongResult | null;
    lyrics: LyricData | null;
    isLyricsLoading: boolean;
    hasAttempted: boolean;
    hasCachedTheme: boolean;
    // Cover-derived themes read the artwork, not the lyrics, so they need no prompt source.
    requiresPromptSource?: boolean;
};

export const getSongThemeAutoGenerationKey = (song: SongResult | null) => (
    song ? getPlaybackSongKey(song) : null
);

/**
 * 这首歌是不是视频平台的投稿（B 站）。
 *
 * 只看播放来源：本地库和别的音乐平台都不受影响。视频稿的「歌词」是字幕，
 * 输入本来就不适合做主题，所以自动生成对它一律不跑。
 */
export const isSongFromVideoPlatform = (song: SongResult): boolean => {
    const ref = getPlaybackSourceRef(song);
    return ref.kind === 'online' && ref.providerId === 'bilibili';
};

export const hasSongThemePromptSource = (song: SongResult, lyrics: LyricData | null) => (
    Boolean(song.isPureMusic) || Boolean((lyrics?.lines.length ?? 0) > 0)
);

export const isSongThemeGenerationStillCurrent = ({
    latestSongKey,
    targetSongKey,
    enabled,
}: {
    latestSongKey: string | null;
    targetSongKey: string;
    enabled: boolean;
}) => latestSongKey === targetSongKey && enabled;

/**
 * 这首歌要不要**自动**生成 AI 主题。
 *
 * 除了那些开关，这里还挡掉一类歌：视频平台（B 站）的投稿。
 *
 * 为什么挡：那类曲目的「歌词」是字幕，或者干脆没有；而且一条投稿常常是十几分钟
 * 的综艺 / 翻唱合集，为它跑一次主题生成既等不到像样的输入，又白白花掉一次请求
 * （用户报的「B 站的播放不要尝试去生成 AI 主题」）。手动点「生成主题」仍然可用 ——
 * 拦的只是自动那一路。
 */
export const shouldRequestSongThemeAutoGeneration = ({
    enabled,
    currentSong,
    lyrics,
    isLyricsLoading,
    hasAttempted,
    hasCachedTheme,
    requiresPromptSource = true,
}: SongThemeAutoGenerationDecisionInput) => {
    if (!enabled || !currentSong || isLyricsLoading || hasAttempted || hasCachedTheme) {
        return false;
    }
    if (isSongFromVideoPlatform(currentSong)) return false;

    return requiresPromptSource ? hasSongThemePromptSource(currentSong, lyrics) : true;
};
