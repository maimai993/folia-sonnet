import { OnlineProviderError } from '../../types/onlineMusic';
import type { ProviderErrorCode } from '../../types/onlineMusic';

// src/services/onlineMusic/bodianTransport.ts

export const BODIAN_OPERATIONS = [
    'search', 'song_detail', 'audio', 'lyrics', 'login_qr_key', 'login_qr_create', 'login_qr_check',
    'login_qr_cancel', 'login_status', 'logout', 'user_playlists', 'user_albums', 'liked_songs',
    'playlist_detail', 'playlist_tracks', 'album_detail', 'album_tracks', 'artist_detail',
    'artist_songs', 'artist_albums', 'recommendations', 'home_module', 'ai_playlist_detail',
    'personal_fm', 'like_song',
    'subscribe_playlist', 'subscribe_album', 'playlist_tracks_add', 'playlist_tracks_del',
] as const;
export type BodianOperation = typeof BODIAN_OPERATIONS[number];
export type BodianParams = Record<string, string | number | boolean | undefined>;
export type BodianBridgeResult = { ok: true; data: unknown } | {
    ok: false; error: { code: ProviderErrorCode; message: string };
};

export const getBodianTransportAvailability = () => (
    typeof window !== 'undefined' && typeof window.electron?.bodianRequest === 'function'
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
);

export async function requestBodian<T = unknown>(operation: BodianOperation, params: BodianParams = {}): Promise<T> {
    if (!getBodianTransportAvailability().configured) {
        throw new OnlineProviderError('unavailable', 'Bodian requires the desktop app', 'bodian');
    }
    let result: BodianBridgeResult;
    // Omni consumers request 150/1000-row batches; Bodian serves at most 100 and returns its own cursor.
    const boundedParams = Number.isSafeInteger(params.limit) && Number(params.limit) > 100
        ? { ...params, limit: 100 } : params;
    try { result = await window.electron!.bodianRequest(operation, boundedParams); }
    catch { throw new OnlineProviderError('network', 'Bodian desktop request failed', 'bodian'); }
    if (!result.ok) throw new OnlineProviderError(result.error.code, result.error.message, 'bodian');
    return result.data as T;
}
