// src/utils/coverUrl.ts

const NON_RESIZABLE_COVER_PROTOCOLS = new Set(['blob:', 'data:', 'file:', 'filesystem:']);
const QQ_COVER_HOSTNAMES = new Set(['y.gtimg.cn', 'y.qq.com']);
const QQ_COVER_PATH_PATTERN = /(T00[12])(?:R\d+x\d+)?(M000)/;
const QQ_COVER_SMALL_SIZE = 300;
const QQ_COVER_LARGE_SIZE = 800;
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

const isQqCoverUrl = (url: URL): boolean => (
    QQ_COVER_HOSTNAMES.has(url.hostname) && QQ_COVER_PATH_PATTERN.test(url.pathname)
);

const withQqCoverSize = (url: URL, size: number | null): string => {
    url.pathname = url.pathname.replace(
        QQ_COVER_PATH_PATTERN,
        size ? `$1R${size}x${size}$2` : '$1$2',
    );
    return url.toString();
};

/**
 * Restores the original CDN asset when the source URL exposes a known resize suffix.
 */
export const getOriginalCoverUrl = (url: string | null | undefined): string => {
    const trimmedUrl = url?.trim() ?? '';
    if (!trimmedUrl) return '';

    try {
        const urlObj = new URL(trimmedUrl);
        return isQqCoverUrl(urlObj) ? withQqCoverSize(urlObj, null) : trimmedUrl;
    } catch {
        return trimmedUrl;
    }
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

        if (isQqCoverUrl(urlObj)) {
            const qqCoverSize = normalizedSize <= QQ_COVER_SMALL_SIZE
                ? QQ_COVER_SMALL_SIZE
                : normalizedSize <= QQ_COVER_LARGE_SIZE ? QQ_COVER_LARGE_SIZE : null;
            return withQqCoverSize(urlObj, qqCoverSize);
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
