import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
    areIndexListsEqual,
    buildHexGridCoords,
    pixelToCubeCenter,
    resolveVisibleHexIndexes,
    toCubeKey,
} from './hexViewport';
import type { HexGridCoord } from './hexViewport';

// Shared React viewport state for Folia's hex-grid card surfaces.
export interface UseFoliaHexViewportOptions {
    itemCount: number;
    spacingX: number;
    spacingY: number;
    renderRadius: number;
    renderRing: number;
    fallbackIndexRef?: RefObject<number>;
    coords?: HexGridCoord[];
}

export const useFoliaHexViewport = ({
    itemCount,
    spacingX,
    spacingY,
    renderRadius,
    renderRing,
    fallbackIndexRef,
    coords: customCoords,
}: UseFoliaHexViewportOptions) => {
    const coords = useMemo<HexGridCoord[]>(
        () => customCoords || buildHexGridCoords(itemCount, spacingX, spacingY),
        [customCoords, itemCount, spacingX, spacingY]
    );

    const coordByKey = useMemo(() => (
        new Map(coords.map((coord) => [toCubeKey(coord.cube), coord.index]))
    ), [coords]);

    const [renderedIndexes, setRenderedIndexes] = useState<number[]>([]);
    const renderedIndexesRef = useRef<number[]>([]);
    const lastVisibleCenterKeyRef = useRef('');

    useEffect(() => {
        renderedIndexesRef.current = renderedIndexes;
    }, [renderedIndexes]);

    const updateRenderedIndexesForViewport = useCallback((dx: number, dy: number, force = false) => {
        if (coords.length === 0) {
            if (renderedIndexesRef.current.length > 0) {
                renderedIndexesRef.current = [];
                setRenderedIndexes([]);
            }
            return;
        }

        const worldX = -dx;
        const worldY = -dy;
        const centerCube = pixelToCubeCenter(worldX, worldY, spacingX, spacingY);
        const centerKey = toCubeKey(centerCube);
        if (!force && centerKey === lastVisibleCenterKeyRef.current) return;

        const nextIndexes = resolveVisibleHexIndexes(
            centerCube,
            renderRing,
            coordByKey,
            coords,
            worldX,
            worldY,
            renderRadius
        );

        const fallbackIndex = fallbackIndexRef?.current ?? 0;
        if (nextIndexes.length === 0 && fallbackIndex >= 0 && fallbackIndex < coords.length) {
            nextIndexes.push(fallbackIndex);
        }

        if (areIndexListsEqual(renderedIndexesRef.current, nextIndexes)) {
            lastVisibleCenterKeyRef.current = centerKey;
            return;
        }

        lastVisibleCenterKeyRef.current = centerKey;
        renderedIndexesRef.current = nextIndexes;
        startTransition(() => {
            setRenderedIndexes(nextIndexes);
        });
    }, [coordByKey, coords, fallbackIndexRef, renderRadius, renderRing, spacingX, spacingY]);

    return {
        coords,
        renderedIndexes,
        renderedIndexesRef,
        updateRenderedIndexesForViewport,
    };
};
