// src/components/command-palette/queueQuery.ts
// Parses and formats the small queue-search language used inside the command palette.

export type QueueBatchAction = 'remove' | 'next' | 'end';
export type QueueFacetKind = 'artist' | 'album';

export type ParsedQueueQuery = {
    action: QueueBatchAction | null;
    actionDraft: string | null;
    facetKind: QueueFacetKind | null;
    facetValue: string;
    facetDraft: string | null;
    isBareFacet: boolean;
    text: string;
    filterInput: string;
};

const ACTION_ALIASES: Record<string, QueueBatchAction> = {
    remove: 'remove',
    rm: 'remove',
    delete: 'remove',
    next: 'next',
    end: 'end',
};

const normalizeSpaces = (value: string) => value.trim().replace(/\s+/g, ' ');

const parseQuotedValue = (rawValue: string): string => {
    if (!rawValue.startsWith('"')) {
        return rawValue;
    }

    try {
        return JSON.parse(rawValue) as string;
    } catch {
        return rawValue.slice(1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
};

const stripActionToken = (input: string) => {
    const prefixMatch = input.match(/^\s*--([a-z-]*)(?:\s+|$)/i);
    if (prefixMatch) {
        const rawAction = prefixMatch[1].toLowerCase();
        return {
            action: ACTION_ALIASES[rawAction] ?? null,
            actionDraft: ACTION_ALIASES[rawAction] ? null : rawAction,
            filterInput: input.slice(prefixMatch[0].length),
        };
    }

    const suffixMatch = input.match(/(?:^|\s)--([a-z-]*)\s*$/i);
    if (suffixMatch && suffixMatch.index !== undefined) {
        const rawAction = suffixMatch[1].toLowerCase();
        return {
            action: ACTION_ALIASES[rawAction] ?? null,
            actionDraft: ACTION_ALIASES[rawAction] ? null : rawAction,
            filterInput: input.slice(0, suffixMatch.index),
        };
    }

    return { action: null, actionDraft: null, filterInput: input };
};

export const parseQueueQuery = (input: string): ParsedQueueQuery => {
    const actionToken = stripActionToken(input);
    const filterInput = normalizeSpaces(actionToken.filterInput);
    const explicitFacetMatch = filterInput.match(/(^|\s)@(artist|album):("(?:\\.|[^"\\])*"|[^\s]*)/i);
    const shorthandFacetMatch = explicitFacetMatch ? null : filterInput.match(/(^|\s)@([^\s]*)/);

    let facetKind: QueueFacetKind | null = null;
    let facetValue = '';
    let facetDraft: string | null = null;
    let isBareFacet = false;
    let text = filterInput;

    if (explicitFacetMatch && explicitFacetMatch.index !== undefined) {
        facetKind = explicitFacetMatch[2].toLowerCase() as QueueFacetKind;
        facetValue = parseQuotedValue(explicitFacetMatch[3]);
        facetDraft = facetValue;
        const start = explicitFacetMatch.index + explicitFacetMatch[1].length;
        text = `${filterInput.slice(0, start)} ${filterInput.slice(start + explicitFacetMatch[0].length - explicitFacetMatch[1].length)}`;
    } else if (shorthandFacetMatch && shorthandFacetMatch.index !== undefined) {
        facetDraft = shorthandFacetMatch[2];
        isBareFacet = facetDraft.length === 0;
        const start = shorthandFacetMatch.index + shorthandFacetMatch[1].length;
        text = `${filterInput.slice(0, start)} ${filterInput.slice(start + shorthandFacetMatch[0].length - shorthandFacetMatch[1].length)}`;
    }

    return {
        action: actionToken.action,
        actionDraft: actionToken.actionDraft,
        facetKind,
        facetValue,
        facetDraft,
        isBareFacet,
        text: normalizeSpaces(text).replace(/\\([@-])/g, '$1'),
        filterInput,
    };
};

const formatFacetValue = (value: string) => (/\s|"/.test(value) ? JSON.stringify(value) : value);

export const formatQueueQuery = ({
    action,
    facetKind,
    facetValue,
    text,
}: {
    action?: QueueBatchAction | null;
    facetKind?: QueueFacetKind | null;
    facetValue?: string;
    text?: string;
}) => [
    action ? `--${action}` : '',
    facetKind && facetValue ? `@${facetKind}:${formatFacetValue(facetValue)}` : '',
    normalizeSpaces(text ?? ''),
].filter(Boolean).join(' ');

export const replaceQueueAction = (input: string, action: QueueBatchAction | null): string => {
    const parsed = parseQueueQuery(input);
    return formatQueueQuery({
        action,
        facetKind: parsed.facetKind,
        facetValue: parsed.facetValue,
        text: parsed.facetDraft !== null && !parsed.facetKind
            ? `${parsed.isBareFacet ? '@' : `@${parsed.facetDraft}`} ${parsed.text}`
            : parsed.text,
    });
};

export const replaceQueueFacet = (
    input: string,
    facetKind: QueueFacetKind | null,
    facetValue = '',
): string => {
    const parsed = parseQueueQuery(input);
    return formatQueueQuery({
        action: parsed.action,
        facetKind,
        facetValue,
        text: parsed.text,
    });
};
