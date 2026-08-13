// src/components/folia-grid/gridMapQuery.ts
// Parses explicit GridMap query mode and builds command/path completions without touching React state.

export interface GridMapQueryableItem {
    id: string | number;
    name: string;
    path?: string;
    description?: string;
    summary?: string;
}

export type GridMapPathOperator = 'path' | 'under';

export interface GridMapPathCondition {
    operator: GridMapPathOperator;
    path: string;
}

export interface ParsedGridMapQuery {
    mode: 'basic' | 'syntax';
    raw: string;
    textTerms: string[];
    pathConditions: GridMapPathCondition[];
    valid: boolean;
    error?: 'missing-command-argument' | 'unterminated-quote';
}

export interface GridMapQuerySuggestion {
    id: string;
    kind: 'command' | 'path';
    label: string;
    detail?: string;
    completedQuery: string;
}

const SYNTAX_PREFIX = '/';
const QUERY_COMMANDS: GridMapPathOperator[] = ['path', 'under'];

export const isGridMapSyntaxQuery = (query: string): boolean => query.trimStart().startsWith(SYNTAX_PREFIX);

export const getGridMapSyntaxBody = (query: string): string => {
    const trimmedStart = query.trimStart();
    return trimmedStart.startsWith(SYNTAX_PREFIX) ? trimmedStart.slice(1) : query;
};

export const normalizeGridMapPath = (value: string): string => value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');

interface TokenizedQuery {
    tokens: string[];
    unterminatedQuote: boolean;
}

const tokenizeQuery = (value: string): TokenizedQuery => {
    const tokens: string[] = [];
    let current = '';
    let quoted = false;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"') {
            quoted = !quoted;
            continue;
        }
        if (/\s/.test(character) && !quoted) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += character;
    }

    if (current) tokens.push(current);
    return { tokens, unterminatedQuote: quoted };
};

export const parseGridMapQuery = (query: string): ParsedGridMapQuery => {
    if (!isGridMapSyntaxQuery(query)) {
        const term = query.trim().toLocaleLowerCase();
        return {
            mode: 'basic',
            raw: query,
            textTerms: term ? [term] : [],
            pathConditions: [],
            valid: true,
        };
    }

    const tokenized = tokenizeQuery(getGridMapSyntaxBody(query));
    const textTerms: string[] = [];
    const pathConditions: GridMapPathCondition[] = [];

    for (let index = 0; index < tokenized.tokens.length; index += 1) {
        const token = tokenized.tokens[index];
        const normalizedToken = token.toLocaleLowerCase();
        if (normalizedToken === 'path' || normalizedToken === 'under') {
            const path = normalizeGridMapPath(tokenized.tokens[index + 1] || '');
            if (!path) {
                return {
                    mode: 'syntax',
                    raw: query,
                    textTerms,
                    pathConditions,
                    valid: false,
                    error: 'missing-command-argument',
                };
            }
            pathConditions.push({ operator: normalizedToken, path });
            index += 1;
            continue;
        }
        if (normalizedToken) textTerms.push(normalizedToken);
    }

    return {
        mode: 'syntax',
        raw: query,
        textTerms,
        pathConditions,
        valid: !tokenized.unterminatedQuote,
        error: tokenized.unterminatedQuote ? 'unterminated-quote' : undefined,
    };
};

const getSearchableText = (item: GridMapQueryableItem): string => [
    item.name,
    item.description,
    item.summary,
]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();

export const matchesGridMapQuery = (
    item: GridMapQueryableItem,
    parsed: ParsedGridMapQuery,
): boolean => {
    if (!parsed.valid) return false;

    const searchableText = getSearchableText(item);
    if (!parsed.textTerms.every(term => searchableText.includes(term))) return false;

    const itemPath = normalizeGridMapPath(item.path || item.name).toLocaleLowerCase();
    return parsed.pathConditions.every(condition => {
        const conditionPath = normalizeGridMapPath(condition.path).toLocaleLowerCase();
        return condition.operator === 'path'
            ? itemPath === conditionPath
            : itemPath === conditionPath || itemPath.startsWith(`${conditionPath}/`);
    });
};

const escapeQuotedPath = (path: string): string => path.replace(/"/g, '\\"');

const rankPath = (path: string, query: string): number => {
    const normalizedPath = path.toLocaleLowerCase();
    const normalizedQuery = query.toLocaleLowerCase();
    if (!normalizedQuery) return 3;
    if (normalizedPath.startsWith(normalizedQuery)) return 0;
    if (normalizedPath.split('/').some(segment => segment.startsWith(normalizedQuery))) return 1;
    if (normalizedPath.includes(normalizedQuery)) return 2;
    return Number.POSITIVE_INFINITY;
};

const buildCommandSuggestions = (query: string, body: string): GridMapQuerySuggestion[] => {
    const match = /(^|\s)([a-z]*)$/i.exec(body);
    if (!match) return [];

    const candidate = match[2].toLocaleLowerCase();
    const tokenStart = match.index + match[1].length;
    const beforeToken = body.slice(0, tokenStart);
    return QUERY_COMMANDS
        .filter(command => command.startsWith(candidate))
        .map(command => ({
            id: `command-${command}`,
            kind: 'command' as const,
            label: command,
            detail: command,
            completedQuery: `/${beforeToken}${command} `,
        }));
};

const buildPathSuggestions = (
    body: string,
    items: readonly GridMapQueryableItem[],
): GridMapQuerySuggestion[] => {
    const match = /(^|\s)(path|under)\s+(?:"([^"]*)|([^\s]*))$/i.exec(body);
    if (!match) return [];

    const operator = match[2].toLocaleLowerCase() as GridMapPathOperator;
    const candidate = match[3] ?? match[4] ?? '';
    const commandStart = match.index + match[1].length;
    const beforeCommand = body.slice(0, commandStart);
    const paths = new Map<string, GridMapQueryableItem>();
    items.forEach(item => {
        const path = normalizeGridMapPath(item.path || item.name);
        if (path && !paths.has(path.toLocaleLowerCase())) paths.set(path.toLocaleLowerCase(), item);
    });

    return Array.from(paths.values())
        .map(item => ({
            item,
            path: normalizeGridMapPath(item.path || item.name),
        }))
        .map(entry => ({ ...entry, rank: rankPath(entry.path, candidate) }))
        .filter(entry => Number.isFinite(entry.rank))
        .sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path))
        .slice(0, 8)
        .map(({ item, path }) => ({
            id: `path-${operator}-${path}`,
            kind: 'path' as const,
            label: path,
            detail: item.description,
            completedQuery: `/${beforeCommand}${operator} "${escapeQuotedPath(path)}"`,
        }));
};

export const getGridMapQuerySuggestions = (
    query: string,
    items: readonly GridMapQueryableItem[],
): GridMapQuerySuggestion[] => {
    if (!isGridMapSyntaxQuery(query)) return [];
    const body = getGridMapSyntaxBody(query);
    const pathSuggestions = buildPathSuggestions(body, items);
    return pathSuggestions.length > 0 ? pathSuggestions : buildCommandSuggestions(query, body);
};
