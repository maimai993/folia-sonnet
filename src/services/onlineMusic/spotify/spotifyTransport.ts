import { OnlineProviderError } from '../../../types/onlineMusic';
import type { ProviderAvailability, ProviderErrorCode } from '../../../types/onlineMusic';
import { isSpotifyNativeAvailable } from './spotifyNative';
import { runSpotifyInPage } from './spotifyInPageRuntime';

// src/services/onlineMusic/spotify/spotifyTransport.ts
// The IPC boundary to electron/spotify/spotifyApiBridge.cjs. The Spotify token stays in the main
// process; a query is named here and sent there, and its answer comes back as Spotify gave it.
//
// 安卓上没有 Electron，也没有 librespot：取数改走公开 Web API，跑在**主 WebView 里**
// （见 spotifyInPageRuntime）。原生只负责 OAuth —— 收回调要一个本地端口，换 token 会撞
// CORS，这两件 WebView 都做不了（见 platform/foliaNative 的 FoliaSpotify）。

export type SpotifyOperation =
    | 'login_start' | 'login_check' | 'login_cancel' | 'login_open' | 'login_status' | 'logout'
    | 'query' | 'radio' | 'lyrics' | 'audio' | 'audio_kept' | 'audio_keep' | 'audio_probe' | 'library' | 'playlist_edit' | 'playlist_create'
    | 'playback_mode' | 'soloist_state' | 'soloist_pick' | 'soloist_key' | 'soloist_restart' | 'soloist_open'
    | 'soloist_play' | 'soloist_pause' | 'soloist_resume' | 'soloist_seek' | 'soloist_volume' | 'soloist_status'
    | 'soloist_repeat';
// The queries the main process sends for the renderer (`RENDERER_QUERIES` in the bridge).
export type SpotifyQuery =
    | 'home' | 'homeSection' | 'browsePage' | 'queryWhatsNewFeed' | 'libraryV3' | 'fetchLibraryTracks' | 'fetchPlaylist'
    | 'getAlbum' | 'queryArtistOverview' | 'queryArtistDiscographyAll' | 'searchTracks' | 'getTrack' | 'areEntitiesInLibrary';
export type SpotifyParams = Record<string, unknown>;
// `reason`: the desktop side's own word for why a sign-in failed, where it has one.
export type SpotifyBridgeResult =
    | { ok: true; data: unknown }
    | { ok: false; error: { code: ProviderErrorCode; message: string; reason?: string } };

export interface SpotifyWireLoginStart { key: string; expiresInMs: number }
/** The playlist Spotify keeps of the songs like one song. */
export interface SpotifyWireRadio { uri: string }
/** The app's own URL for a track's audio, and the file Spotify chose for it ("OGG_VORBIS_320"). */
export interface SpotifyWireAudio { url: string; format: string }
/** The playlist that was made. */
export interface SpotifyWireMadePlaylist { uri: string }
export interface SpotifyWireLyrics { timed: boolean; lines: Array<{ startMs: number; words: string }> }

/**
 * 桌面端靠 Electron 那座桥（背后是 librespot）；安卓上换成公开 Web API 跑在**主 WebView 里**
 * （见 spotifyInPageRuntime），登录由原生的 OAuth 插件负责（见 platform/foliaNative 的
 * FoliaSpotify：Java 绑 127.0.0.1:5588 收回调并换 token）。
 *
 * 两条路给的是同一套信封，所以渲染层只有这一处判断。
 */
export const getSpotifyTransportAvailability = (): ProviderAvailability => {
    if (typeof window !== 'undefined' && typeof window.electron?.spotifyRequest === 'function') {
        return { configured: true };
    }
    if (isSpotifyNativeAvailable()) return { configured: true };
    return { configured: false, reason: 'runtime-unavailable' };
};

export async function requestSpotify<T = unknown>(operation: SpotifyOperation, params: SpotifyParams = {}): Promise<T> {
    // 安卓：协议层就在本页里，直接调。
    if (isSpotifyNativeAvailable()) return (await runSpotifyInPage(operation, params)) as T;
    if (!getSpotifyTransportAvailability().configured) {
        throw new OnlineProviderError('unavailable', 'Spotify requires the desktop app', 'spotify');
    }
    const named = operation === 'query' ? `${operation} ${String(params.name)}` : operation;
    const startedAt = Date.now();
    let result: SpotifyBridgeResult;
    try { result = await window.electron!.spotifyRequest(operation, params); }
    catch {
        console.warn(`[Spotify] ${named} did not reach the desktop app`);
        throw new OnlineProviderError('network', 'Spotify desktop request failed', 'spotify');
    }
    if (!result.ok) {
        console.warn(`[Spotify] ${named} failed after ${Date.now() - startedAt}ms: ${result.error.code} (${result.error.message ?? ''})`);
        // The reason goes with the error as its cause (spotifyLoginFailure.ts reads it there).
        throw new OnlineProviderError(result.error.code, result.error.message, 'spotify', result.error.reason);
    }
    return result.data as T;
}

// One of Spotify's named queries, answered with the `data` of its reply.
export const querySpotify = <T = unknown>(name: SpotifyQuery, variables: Record<string, unknown> = {}): Promise<T> => (
    requestSpotify<T>('query', { name, variables })
);
