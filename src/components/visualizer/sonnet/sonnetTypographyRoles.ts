import type { SonnetSemanticSegment } from './types';

// src/components/visualizer/sonnet/sonnetTypographyRoles.ts
// Selects deterministic typography emphasis roles without coupling them to a layout template.
export type SonnetSegmentRole = 'hero' | 'semi-hero' | 'support' | 'decoration';

export const isSonnetEmphasisRole = (role: SonnetSegmentRole) => (
    role === 'hero' || role === 'semi-hero'
);

export const getSonnetVisibleSegmentLength = (segment: SonnetSemanticSegment) => (
    segment.graphemes.filter(item => item.char.trim().length > 0).length
);

export const scoreSonnetHeroSegment = (segment: SonnetSemanticSegment) => {
    const lengthScore = Math.min(getSonnetVisibleSegmentLength(segment), 8) * 14;
    const durationScore = Math.min(2.5, Math.max(0, segment.endTime - segment.startTime)) * 18;
    return lengthScore + durationScore;
};

export const findSonnetHeroSegmentIndex = (
    segments: SonnetSemanticSegment[],
) => {
    let bestIndex = segments.findIndex(segment => segment.isWordLike);
    let bestScore = -Infinity;
    segments.forEach((segment, index) => {
        if (!segment.isWordLike || getSonnetVisibleSegmentLength(segment) === 0) return;
        const score = scoreSonnetHeroSegment(segment);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });
    return Math.max(0, bestIndex);
};

export const findSonnetSemiHeroSegmentIndex = (
    segments: SonnetSemanticSegment[],
    heroIndex: number,
) => {
    const beforeHero = segments
        .map((segment, index) => ({ segment, index }))
        .filter(({ segment, index }) => (
            index < heroIndex
            && segment.isWordLike
            && getSonnetVisibleSegmentLength(segment) > 0
        ));
    if (beforeHero.length < 6) return -1;

    // Keep the secondary emphasis in the earlier block instead of crowding the main hero.
    const candidates = beforeHero.slice(0, -2);
    let bestIndex = -1;
    let bestScore = -Infinity;
    candidates.forEach(({ segment, index }) => {
        const score = scoreSonnetHeroSegment(segment);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });
    return bestIndex;
};
