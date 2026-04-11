type PlaceholderVariant = 'artist' | 'playlist';

const svgToDataUrl = (svg: string) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

const getInitial = (label: string, fallback: string) => {
    const trimmed = label.trim();
    return (trimmed.charAt(0) || fallback).toUpperCase();
};

export const createCoverPlaceholder = (
    label: string,
    variant: PlaceholderVariant = 'playlist'
): string => {
    const configs: Record<PlaceholderVariant, { start: string; end: string; accent: string; symbol: string; }> = {
        artist: {
            start: '#d9f1ff',
            end: '#8ec5ff',
            accent: '#eff8ff',
            symbol: getInitial(label, 'A'),
        },
        playlist: {
            start: '#dbf4ff',
            end: '#7cc6f6',
            accent: '#edf9ff',
            symbol: getInitial(label, 'M'),
        },
    };

    const config = configs[variant];
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
            <defs>
                <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="${config.start}" />
                    <stop offset="100%" stop-color="${config.end}" />
                </linearGradient>
                <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9" />
                    <stop offset="100%" stop-color="${config.accent}" stop-opacity="0.15" />
                </linearGradient>
            </defs>
            <rect width="600" height="600" rx="72" fill="url(#bg)" />
            <circle cx="164" cy="154" r="128" fill="url(#glow)" opacity="0.55" />
            <circle cx="496" cy="478" r="152" fill="#ffffff" opacity="0.14" />
            <circle cx="462" cy="154" r="46" fill="#ffffff" opacity="0.28" />
            <rect x="96" y="96" width="408" height="408" rx="48" fill="#ffffff" opacity="0.14" />
            <text
                x="300"
                y="338"
                text-anchor="middle"
                font-size="180"
                font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
                font-weight="700"
                fill="#ffffff"
                opacity="0.92"
            >${config.symbol}</text>
        </svg>
    `;

    return svgToDataUrl(svg);
};

export const resolveNavidromeArtistCoverUrl = (
    artist: { coverArt?: string; artistImageUrl?: string; },
    getCoverArtUrl: (coverArtId: string, size?: number) => string,
    size = 600
): string | undefined => {
    if (artist.artistImageUrl) {
        return artist.artistImageUrl;
    }

    if (artist.coverArt) {
        return getCoverArtUrl(artist.coverArt, size);
    }

    return undefined;
};

export const pickRandomSongCoverUrl = (
    songs: Array<{ coverArt?: string; }>,
    getCoverArtUrl: (coverArtId: string, size?: number) => string,
    size = 600,
    maxAttempts = 3
): string | undefined => {
    if (!songs.length) {
        return undefined;
    }

    const pool = [...songs];

    for (let attempt = 0; attempt < maxAttempts && pool.length > 0; attempt += 1) {
        const index = Math.floor(Math.random() * pool.length);
        const [candidate] = pool.splice(index, 1);
        if (candidate?.coverArt) {
            return getCoverArtUrl(candidate.coverArt, size);
        }
    }

    return undefined;
};
