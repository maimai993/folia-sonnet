// src/components/folia-grid/gridMapSearch.ts
// Keeps GridMap basic search semantics independent from its React surface.

export interface GridMapSearchableItem {
    name: string;
    path?: string;
    description?: string;
    summary?: string;
}

export const matchesGridMapSearch = (
    item: GridMapSearchableItem,
    query: string,
): boolean => {
    const terms = query
        .trim()
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    if (terms.length === 0) return true;

    const searchableText = [item.name, item.path, item.description, item.summary]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
    return terms.every(term => searchableText.includes(term));
};
