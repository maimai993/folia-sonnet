import { LyricParserFactory } from './lyrics/LyricParserFactory';
import type { LyricData } from '../types';
import type { NavidromeConfig, NavidromeSong, StructuredLyric } from '../types/navidrome';
import { navidromeApi } from '../services/navidromeService';
import { getProviderSongMetadata } from '../services/onlineMusic/songMetadata';
import { hasEnhancedStructuredLines, hasRenderableLyrics } from './appPlaybackHelpers';

// Navidrome lyric selection and hydration helpers kept outside App.tsx.
export const selectPreferredStructuredLyric = (items: StructuredLyric[] | null | undefined): StructuredLyric | null => {
    if (!items?.length) {
        return null;
    }

    const nonEmptyItems = items.filter(item => item.line?.some(line => (line.value || '').trim().length > 0));
    if (nonEmptyItems.length === 0) {
        return null;
    }

    return nonEmptyItems.find(item => item.kind === 'main' && hasEnhancedStructuredLines(item))
        || nonEmptyItems.find(item => item.kind === 'main')
        || nonEmptyItems.find(hasEnhancedStructuredLines)
        || nonEmptyItems.find(item => item.synced)
        || nonEmptyItems[0];
};

export const resolvePreferredNavidromeLyrics = async (
    navidromeSong: Pick<NavidromeSong, 'cachedStructuredLyrics' | 'cachedPlainLyrics'>
): Promise<LyricData | null> => {
    const cachedStructuredLyrics = navidromeSong.cachedStructuredLyrics;
    const structuredLyrics = Array.isArray(cachedStructuredLyrics)
        ? cachedStructuredLyrics.filter(line => (line.value || '').trim().length > 0)
        : cachedStructuredLyrics;

    if (structuredLyrics && (Array.isArray(structuredLyrics) ? structuredLyrics.length > 0 : structuredLyrics.line.length > 0 || structuredLyrics.cueLine?.length)) {
        const parsedStructuredLyrics = await LyricParserFactory.parse({ type: 'navidrome', structuredLyrics });
        if (hasRenderableLyrics(parsedStructuredLyrics)) {
            return parsedStructuredLyrics;
        }
    }

    const plainLyrics = navidromeSong.cachedPlainLyrics?.trim();
    if (plainLyrics) {
        const parsedPlainLyrics = await LyricParserFactory.parse({ type: 'navidrome', plainLyrics });
        if (hasRenderableLyrics(parsedPlainLyrics)) {
            return parsedPlainLyrics;
        }
    }

    return null;
};

export const hydrateNavidromeLyricPayload = async (config: NavidromeConfig, navidromeSong: NavidromeSong): Promise<void> => {
    const navidromeId = navidromeSong.navidromeData?.id;
    if (!navidromeId) {
        return;
    }

    const hasCurrentStructuredLyrics = !Array.isArray(navidromeSong.cachedStructuredLyrics)
        && Boolean(navidromeSong.cachedStructuredLyrics?.line.length || navidromeSong.cachedStructuredLyrics?.cueLine?.length);
    if (!hasCurrentStructuredLyrics) {
        try {
            const structuredLyrics = await navidromeApi.getLyricsBySongId(config, navidromeId);
            const preferredStructuredLyrics = selectPreferredStructuredLyric(structuredLyrics);

            if (preferredStructuredLyrics?.line?.length || preferredStructuredLyrics?.cueLine?.length) {
                navidromeSong.cachedStructuredLyrics = preferredStructuredLyrics;
            }
            if (!preferredStructuredLyrics?.line?.length && !navidromeSong.cachedPlainLyrics) {
                const artistName = getProviderSongMetadata(navidromeSong).artists[0]?.name || '';
                const plainLyrics = await navidromeApi.getLyrics(config, artistName, navidromeSong.name);
                if (plainLyrics?.trim()) {
                    navidromeSong.cachedPlainLyrics = plainLyrics;
                }
            }
        } catch (e) {
            console.warn('[App] Failed to fetch Navidrome lyrics:', e);
        }
    }
};
