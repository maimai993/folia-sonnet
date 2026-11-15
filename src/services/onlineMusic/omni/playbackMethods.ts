import type { SongResult, UnifiedSong } from '../../../types';
import type {
    AudioQualityPreference,
    MediaId,
    OmniAudioSource,
    OmniProviderId,
    OmniPlaybackReport,
    OmniRequestRunner,
    OmniSongAvailability,
    OmniSongDetail,
    OmniSongReplacement,
} from '../../../types/onlineMusic';
import { applyOmniAudioHook } from '../../hostExtensionHooks';
import { applyImportedAudioResolver } from '../importedAudioRouting';
import { toSafePlaybackUrl } from '../../../utils/appPlaybackHelpers';
import { getOnlineMusicProvider, getOnlineMusicProviderForSong, providerSupports, requireOnlineMusicProvider } from '../providerRegistry';
import { saveSongReplayGain } from '../resourceCache';
import { providerForSong, runDirectly, runRequest, runThrough, songDetailOf, unsupported } from './providerCalls';

// src/services/onlineMusic/omni/playbackMethods.ts
// Song detail and audio addresses: the quality a provider resolves a preference to, what is known
// of each URL handed out, and playback reports.

// The quality levels, lowest first.
const AUDIO_QUALITY_LEVELS: readonly AudioQualityPreference[] = ['standard', 'high', 'ultra', 'lossless', 'hires'];
// A provider that lists none of its own tells these four apart. 'ultra' is not among them: it
// is a level only for a provider that lists it, so no other provider is ever asked at it.
const UNLISTED_AUDIO_QUALITY_LEVELS: readonly AudioQualityPreference[] = ['standard', 'high', 'lossless', 'hires'];
const audioQualityLevelsOf = (providerId: OmniProviderId): readonly AudioQualityPreference[] => {
    const listed = getOnlineMusicProvider(providerId)?.playback?.audioQualityLevels;
    return listed?.length ? AUDIO_QUALITY_LEVELS.filter(level => listed.includes(level)) : UNLISTED_AUDIO_QUALITY_LEVELS;
};
// The level a provider is asked for under the stored preference, which is one value for every
// provider: the preference itself where the provider lists it, else the nearest level it lists
// at or below (its lowest where it lists none below).
const audioQualityFor = (providerId: OmniProviderId, preference: AudioQualityPreference): AudioQualityPreference => {
    const levels = audioQualityLevelsOf(providerId);
    const rank = AUDIO_QUALITY_LEVELS.indexOf(preference);
    return [...levels].reverse().find(level => AUDIO_QUALITY_LEVELS.indexOf(level) <= rank) ?? levels[0];
};

// What is known of each URL handed out by `getAudioSource`, newest last: the level it was asked for
// at, whether its provider said it plays a preview clip of the song, and where that clip starts.
// The media cache asks by URL when it saves a song's bytes: the preference may have moved since the
// URL was fetched, and the URL is where the bytes came from. Playback asks by URL whether what it
// plays is a clip, and where the clip begins in the song, wherever it got the URL from (the prefetch
// pass, or its own request). In memory and bounded; a URL that has dropped out is of an unknown
// level and not known to be a clip.
const AUDIO_SOURCE_LEVEL_LIMIT = 200;
type HandedOutAudioSource = { level: AudioQualityPreference; preview: boolean; clipStartMs?: number };
const audioSourceLevels = new Map<string, HandedOutAudioSource>();
let audioSourceMetadataVersion = 0;
// One spelling per URL: the form playback holds (`toSafePlaybackUrl`), written as the URL parser
// writes it - a deck that has played out reports its element's `currentSrc`, which is that form.
const audioSourceLevelKey = (url: string): string => {
    const playbackUrl = toSafePlaybackUrl(url) ?? url;
    try {
        return new URL(playbackUrl).href;
    } catch {
        return playbackUrl;
    }
};
const noteAudioSourceLevel = (url: string, handedOut: HandedOutAudioSource): void => {
    const key = audioSourceLevelKey(url);
    audioSourceLevels.delete(key);
    audioSourceLevels.set(key, handedOut);
    if (audioSourceLevels.size > AUDIO_SOURCE_LEVEL_LIMIT) {
        const oldestKey = audioSourceLevels.keys().next().value;
        if (oldestKey !== undefined) audioSourceLevels.delete(oldestKey);
    }
    audioSourceMetadataVersion++;
};

export const playbackMethods = {
    async getSongDetail(providerId: OmniProviderId, id: MediaId): Promise<UnifiedSong | null> {
        return requireOnlineMusicProvider(providerId).playback?.getSongDetail(id) ?? null;
    },

    // Songs by id at one provider: one OmniSongDetail for each id, in the order of `ids`. A provider
    // that looks many up in one request (`playback.getSongDetails`) is asked so, in groups of at most
    // `playback.songDetailsPerRequest` ids (all of them where it says no number), one group after
    // another; any other is asked `getSongDetail` for one id after another, never two at a time. A
    // group or an id whose request fails does not stop the others. Each of those calls to the
    // provider goes through `options.run` where the caller hands one in, for it to count and limit
    // them: once `run` refuses one (or stops waiting for it), nothing more is asked and the ids left
    // are `skipped`. The call itself rejects only for a provider that is not there.
    async getSongDetails(
        providerId: OmniProviderId,
        ids: MediaId[],
        options?: { run?: OmniRequestRunner },
    ): Promise<OmniSongDetail[]> {
        const playback = requireOnlineMusicProvider(providerId).playback;
        if (!playback || ids.length === 0) return ids.map(() => ({ status: 'missing' }));
        const run = options?.run ?? runDirectly;
        const lookUpMany = playback.getSongDetails?.bind(playback);
        if (lookUpMany) {
            const per = playback.songDetailsPerRequest;
            const size = typeof per === 'number' && Number.isSafeInteger(per) && per > 0 ? per : ids.length;
            const details: OmniSongDetail[] = [];
            for (let start = 0; start < ids.length; start += size) {
                const group = ids.slice(start, start + size);
                const outcome = await runThrough(run, () => lookUpMany(group));
                if (outcome.kind === 'refused') {
                    while (details.length < ids.length) details.push({ status: 'skipped', error: outcome.error });
                    break;
                }
                if (outcome.kind === 'failed') group.forEach(() => details.push({ status: 'failed', error: outcome.error }));
                else group.forEach((_, index) => details.push(songDetailOf(outcome.value[index])));
            }
            return details;
        }
        const details: OmniSongDetail[] = [];
        for (const id of ids) {
            const outcome = await runThrough(run, () => playback.getSongDetail(id));
            if (outcome.kind === 'refused') {
                while (details.length < ids.length) details.push({ status: 'skipped', error: outcome.error });
                break;
            }
            details.push(outcome.kind === 'failed' ? { status: 'failed', error: outcome.error } : songDetailOf(outcome.value));
        }
        return details;
    },

    canPlaySong(song: SongResult): boolean {
        return Boolean(getOnlineMusicProviderForSong(song)?.playback);
    },

    // The quality levels a provider tells apart, lowest first (`OnlinePlaybackProvider.audioQualityLevels`;
    // standard, high, lossless and hires without it): the ones the quality option shows for it.
    // Read anew on every call: a provider's list may change with its account.
    getAudioQualityLevels(providerId: OmniProviderId): readonly AudioQualityPreference[] {
        return audioQualityLevelsOf(providerId);
    },

    // The level `preference` means to a provider: the one the quality option lights, and the one
    // `getAudioSource` asks the provider for.
    resolveAudioQuality(providerId: OmniProviderId, preference: AudioQualityPreference): AudioQualityPreference {
        return audioQualityFor(providerId, preference);
    },

    async getAudioSource(song: SongResult, quality: AudioQualityPreference): Promise<OmniAudioSource | null> {
        // Imported LX sources get first chance for every online song, including ones owned by
        // another provider. A null answer (no sources, unmapped platform, all of them failed)
        // leaves the provider path exactly as it was.
        const imported = await applyImportedAudioResolver(song, quality);
        const hasImported = Boolean(imported?.url);
        const provider = hasImported ? null : providerForSong(song);
        const level = provider ? audioQualityFor(provider.id, quality) : quality;
        let source: OmniAudioSource | null = hasImported ? imported : null;
        if (!source && provider) {
            try {
                source = await runRequest(provider, 'audio', async () => await (provider.playback?.getAudioSource(song, level) ?? null));
            } catch (error) {
                // The provider gave no address. An extension may still give one, as it may where the provider answers null;
                // without one the very error goes on, for the caller to sort (failure/onlineFailureCase.ts).
                const fromHook = await applyOmniAudioHook(song, null);
                if (fromHook?.url) return fromHook;
                throw error;
            }
        }
        // Written here rather than at either caller because this is the only moment a provider ever
        // states a track's ReplayGain, and both callers - the prefetch pass and playback itself -
        // may be the one that happens to see it. See getCachedSongReplayGain for what is lost
        // otherwise: the URL is never fetched again once the bytes are cached.
        if (source?.replayGain) void saveSongReplayGain(song, source.replayGain);
        // The level asked for, not `source.quality`: a provider may serve a lower one, and a reader
        // of the media cache asks with the level the preference resolves to. Noted before the hook
        // below, so a URL an extension swaps in stays of an unknown level, and is not known to be a
        // clip: the mark is the provider's word about its own URL.
        // (A provider that lists the levels it tells apart is the exception: where it names another
        // of them, the file is that level's own, and a copy of it is kept as of that level. Kept as
        // of the level asked for, it would play in that level's place for good.)
        const listed = provider?.playback?.audioQualityLevels;
        if (source?.url) {
            noteAudioSourceLevel(source.url, {
                level: listed?.includes(source.quality) ? source.quality : level,
                preview: Boolean(source.preview),
                ...(source.preview && Number.isFinite(source.clipStartMs) && source.clipStartMs! > 0
                    ? { clipStartMs: source.clipStartMs } : {}),
            });
        }
        // Extension layers (Folium omni hooks) may swap the URL; the ReplayGain above stays the provider's.
        return applyOmniAudioHook(song, source);
    },

    // The level a URL handed out by `getAudioSource` was asked for at. Undefined for any other URL
    // (a local file, a Navidrome stream, a blob), and for one handed out too long ago to be remembered.
    levelOfAudioSource(url: string): AudioQualityPreference | undefined {
        return audioSourceLevels.get(audioSourceLevelKey(url))?.level;
    },

    // Whether a URL handed out by `getAudioSource` plays a preview clip of its song, as its provider
    // said. False for any other URL, as for one handed out too long ago to be remembered.
    isPreviewAudioSource(url: string): boolean {
        return audioSourceLevels.get(audioSourceLevelKey(url))?.preview === true;
    },

    // Cheap invalidation for playback's small per-URL cache: a provider may reuse a URL with
    // different metadata, and the bounded registry may evict a previously remembered URL.
    audioSourceMetadataVersion(): number {
        return audioSourceMetadataVersion;
    },

    // Where a URL handed out by `getAudioSource` starts inside its song, for a preview clip; 0 for a
    // whole song, any other URL, and one handed out too long ago to be remembered.
    previewClipStartMsOfAudioSource(url: string): number {
        return Math.max(0, audioSourceLevels.get(audioSourceLevelKey(url))?.clipStartMs ?? 0);
    },

    // Asked once per track, including for local and Navidrome songs, so an unsupported source is a
    // plain `false` rather than the throw `providerForSong` would raise. A song its provider
    // cannot vouch for (`canReport`) is false too.
    canReportPlayback(song: SongResult): boolean {
        const provider = getOnlineMusicProviderForSong(song);
        if (!providerSupports(provider, 'playbackReports') || !provider?.playbackReports) return false;
        return provider.playbackReports.canReport?.(song) ?? true;
    },

    async reportPlayback(song: SongResult, report: OmniPlaybackReport): Promise<void> {
        const provider = providerForSong(song);
        if (!provider.playbackReports) return unsupported(provider.id, 'playbackReports');
        await provider.playbackReports.reportPlayback(song, report);
    },

    getSongAvailability(song: SongResult): OmniSongAvailability {
        return providerForSong(song).playback?.getAvailability?.(song) ?? { state: 'unknown' };
    },

    // A lookup that fails is described as a failed request for the song's audio is: the caller tells a
    // network that failed from a version that is not there.
    async getSongReplacement(song: SongResult): Promise<OmniSongReplacement | null> {
        const provider = providerForSong(song);
        return runRequest(provider, 'audio', async () => await (provider.playback?.getReplacement?.(song) ?? null));
    },
};
