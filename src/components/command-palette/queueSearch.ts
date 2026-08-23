import type { SongResult } from '../../types';
import {
    formatQueueQuery,
    parseQueueQuery,
    type ParsedQueueQuery,
    type QueueBatchAction,
    type QueueFacetKind,
} from './queueQuery';
import {
    getCurrentQueueIndex,
    getSongQueueFacets,
    normalizeQueueSearchText as normalize,
    type QueueSearchEntry,
} from './queueSearchIndex';

export { buildQueueSearchIndex } from './queueSearchIndex';

// src/components/command-palette/queueSearch.ts
// Builds a metadata index once per queue and evaluates queue syntax without touching provider APIs.

export type QueueSearchSuggestion = {
    id: string;
    type: 'action' | 'facet';
    replacement: string;
    action?: QueueBatchAction;
    facetKind?: QueueFacetKind;
    label?: string;
    count?: number;
    isCurrent?: boolean;
};

export type QueueSearchMatch = {
    entry: QueueSearchEntry;
    score: number;
    reasons: QueueFacetKind[];
};

export type QueueSearchEvaluation = {
    parsed: ParsedQueueQuery;
    matches: QueueSearchMatch[];
    suggestions: QueueSearchSuggestion[];
    eligibleTargetIndices: number[];
    skippedCurrentCount: number;
    hasMeaningfulFilter: boolean;
};

const buildFacetSuggestions = (
    index: QueueSearchEntry[],
    currentSong: SongResult | null,
    parsed: ParsedQueueQuery,
): QueueSearchSuggestion[] => {
    if (parsed.facetDraft === null) return [];

    const currentFacetKeys = new Set(currentSong ? getSongQueueFacets(currentSong).map(facet => facet.key) : []);
    const groups = new Map<string, { kind: QueueFacetKind; label: string; keys: Set<string>; indices: Set<number>; isCurrent: boolean; }>();
    for (const entry of index) {
        for (const facet of entry.facets) {
            if (parsed.facetKind && facet.kind !== parsed.facetKind) continue;
            const groupKey = `${facet.kind}:${facet.normalizedLabel}`;
            const group = groups.get(groupKey) ?? {
                kind: facet.kind,
                label: facet.label,
                keys: new Set<string>(),
                indices: new Set<number>(),
                isCurrent: false,
            };
            group.keys.add(facet.key);
            group.indices.add(entry.queueIndex);
            group.isCurrent ||= currentFacetKeys.has(facet.key);
            groups.set(groupKey, group);
        }
    }

    const draft = normalize(parsed.facetDraft);
    const groupedFacets = [...groups.values()];
    if (
        parsed.facetKind
        && parsed.facetValue
        && groupedFacets.some(group => group.kind === parsed.facetKind && normalize(group.label) === draft)
    ) {
        return [];
    }

    return groupedFacets
        .filter(group => parsed.isBareFacet ? group.isCurrent : normalize(group.label).includes(draft))
        .sort((left, right) => {
            if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
            const leftPrefix = normalize(left.label).startsWith(draft);
            const rightPrefix = normalize(right.label).startsWith(draft);
            if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
            return right.indices.size - left.indices.size || left.label.localeCompare(right.label);
        })
        .slice(0, 6)
        .map(group => ({
            id: `facet:${group.kind}:${normalize(group.label)}`,
            type: 'facet' as const,
            facetKind: group.kind,
            label: group.label,
            count: group.indices.size,
            isCurrent: group.isCurrent,
            replacement: formatQueueQuery({
                action: parsed.action,
                facetKind: group.kind,
                facetValue: group.label,
                text: parsed.text,
            }),
        }));
};

const buildActionSuggestions = (parsed: ParsedQueueQuery): QueueSearchSuggestion[] => {
    if (parsed.actionDraft === null) return [];
    const draft = normalize(parsed.actionDraft);
    return (['remove', 'next', 'end'] as QueueBatchAction[])
        .filter(action => action.startsWith(draft))
        .map(action => ({
            id: `action:${action}`,
            type: 'action' as const,
            action,
            replacement: formatQueueQuery({
                action,
                facetKind: parsed.facetKind,
                facetValue: parsed.facetValue,
                text: parsed.facetDraft !== null && !parsed.facetKind
                    ? `${parsed.isBareFacet ? '@' : `@${parsed.facetDraft}`} ${parsed.text}`
                    : parsed.text,
            }),
        }));
};

export const evaluateQueueSearch = (
    index: QueueSearchEntry[],
    currentSong: SongResult | null,
    input: string,
): QueueSearchEvaluation => {
    const parsed = parseQueueQuery(input);
    const facetSuggestions = buildFacetSuggestions(index, currentSong, parsed);
    const currentFacets = currentSong ? getSongQueueFacets(currentSong) : [];
    const currentFacetKeys = new Set(currentFacets.map(facet => facet.key));
    const facetDraft = normalize(parsed.facetValue || parsed.facetDraft || '');
    const normalizedText = normalize(parsed.text);

    const matches = index.flatMap((entry): QueueSearchMatch[] => {
        let reasons: QueueFacetKind[] = [];
        let facetMatches = true;
        if (parsed.isBareFacet) {
            reasons = entry.facets
                .filter(facet => currentFacetKeys.has(facet.key))
                .map(facet => facet.kind)
                .filter((kind, facetIndex, kinds) => kinds.indexOf(kind) === facetIndex);
            facetMatches = reasons.length > 0;
        } else if (parsed.facetDraft !== null) {
            const matchingFacets = entry.facets.filter(facet => (
                (!parsed.facetKind || facet.kind === parsed.facetKind)
                && facet.normalizedLabel.includes(facetDraft)
            ));
            reasons = matchingFacets.map(facet => facet.kind)
                .filter((kind, facetIndex, kinds) => kinds.indexOf(kind) === facetIndex);
            facetMatches = matchingFacets.length > 0;
        }

        if (!facetMatches || (normalizedText && !entry.searchText.includes(normalizedText))) {
            return [];
        }

        const startsWithText = normalizedText
            ? normalize(entry.song.name).startsWith(normalizedText) || String(entry.queueIndex + 1).startsWith(normalizedText)
            : false;
        return [{ entry, reasons, score: (startsWithText ? 120 : 100) - entry.queueIndex }];
    }).sort((left, right) => right.score - left.score);

    const currentQueueIndex = getCurrentQueueIndex(index, currentSong);
    const targetIndices = matches.map(match => match.entry.queueIndex);
    const eligibleTargetIndices = targetIndices.filter(queueIndex => queueIndex !== currentQueueIndex);

    return {
        parsed,
        matches,
        suggestions: [...buildActionSuggestions(parsed), ...facetSuggestions],
        eligibleTargetIndices,
        skippedCurrentCount: targetIndices.length - eligibleTargetIndices.length,
        hasMeaningfulFilter: Boolean(normalizedText || parsed.facetDraft !== null),
    };
};
