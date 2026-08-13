// src/utils/coverUrl.ts

const NON_RESIZABLE_COVER_PROTOCOLS = new Set(['blob:', 'data:', 'file:', 'filesystem:']);
export const LOCAL_COVER_THUMBNAIL_SIZES = [512, 1024] as const;

export const resolveLocalCoverThumbnailSize = (size: number): number => {
    const normalizedSize = Math.max(1, Math.round(size));
    return LOCAL_COVER_THUMBNAIL_SIZES.find(candidate => candidate >= normalizedSize)
        ?? LOCAL_COVER_THUMBNAIL_SIZES[LOCAL_COVER_THUMBNAIL_SIZES.length - 1];
};

const withLocalCoverThumbnailSize = (url: URL, size: number): string => {
    url.searchParams.set('size', String(resolveLocalCoverThumbnailSize(size)));
    return url.toString();
};

/**
 * Resolves a cover image URL to a smaller CDN variant when the source supports it.
 */
export const getSizedCoverUrl = (url: string | null | undefined, size: number): string => {
    const trimmedUrl = url?.trim() ?? '';
    if (!trimmedUrl) return '';

    const normalizedSize = Math.max(1, Math.round(size));

    try {
        const urlObj = new URL(trimmedUrl);
        if (NON_RESIZABLE_COVER_PROTOCOLS.has(urlObj.protocol)) {
            return trimmedUrl;
        }

        if (urlObj.protocol === 'folia-cover:') {
            return withLocalCoverThumbnailSize(urlObj, normalizedSize);
        }

        if (urlObj.hostname.includes('126.net')) {
            return `${urlObj.origin}${urlObj.pathname}?param=${normalizedSize}y${normalizedSize}`;
        }

        if (urlObj.pathname.includes('getCoverArt')) {
            urlObj.searchParams.set('size', String(normalizedSize));
            return urlObj.toString();
        }

        return trimmedUrl;
    } catch {
        if (trimmedUrl.startsWith('/__folia_cover/')) {
            const localUrl = new URL(trimmedUrl, 'https://folia.local');
            localUrl.searchParams.set('size', String(resolveLocalCoverThumbnailSize(normalizedSize)));
            return `${localUrl.pathname}${localUrl.search}`;
        }

        if (trimmedUrl.includes('126.net')) {
            return `${trimmedUrl.split('?')[0]}?param=${normalizedSize}y${normalizedSize}`;
        }

        return trimmedUrl;
    }
};
