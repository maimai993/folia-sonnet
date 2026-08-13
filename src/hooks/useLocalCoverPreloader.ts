import { useEffect, useMemo } from 'react';
import { isLocalCoverAssetUrl } from '../services/localCoverAssetUrl';

// src/hooks/useLocalCoverPreloader.ts
// Pre-decodes viewport-near stable local covers with bounded concurrency and no React state updates.

const PRELOAD_CONCURRENCY = 4;
const NEIGHBOR_INDEX_RADIUS = 12;
const INITIAL_INDEX_COUNT = 24;
const decodedUrls = new Set<string>();
const pendingUrls = new Map<string, Promise<void>>();

const decodeImage = (url: string): Promise<void> => {
  const pending = pendingUrls.get(url);
  if (pending) return pending;
  const request = (async () => {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    decodedUrls.add(url);
  })().catch(() => undefined).finally(() => {
    pendingUrls.delete(url);
  });
  pendingUrls.set(url, request);
  return request;
};

export const useLocalCoverPreloader = (
  coverUrls: Array<string | undefined>,
  renderedIndexes: number[],
): void => {
  const candidates = useMemo(() => {
    const indexes = new Set<number>();
    if (renderedIndexes.length === 0) {
      for (let index = 0; index < Math.min(INITIAL_INDEX_COUNT, coverUrls.length); index += 1) indexes.add(index);
    } else {
      renderedIndexes.forEach(index => {
        const start = Math.max(0, index - NEIGHBOR_INDEX_RADIUS);
        const end = Math.min(coverUrls.length - 1, index + NEIGHBOR_INDEX_RADIUS);
        for (let candidate = start; candidate <= end; candidate += 1) indexes.add(candidate);
      });
    }
    return Array.from(indexes)
      .sort((left, right) => left - right)
      .map(index => coverUrls[index])
      .filter(isLocalCoverAssetUrl);
  }, [coverUrls, renderedIndexes]);

  useEffect(() => {
    if (typeof Image === 'undefined') return;
    let cancelled = false;
    const queue = candidates.filter(url => !decodedUrls.has(url));
    const workers = Array.from({ length: Math.min(PRELOAD_CONCURRENCY, queue.length) }, async () => {
      while (!cancelled) {
        const url = queue.shift();
        if (!url) return;
        await decodeImage(url);
      }
    });
    void Promise.all(workers);
    return () => {
      cancelled = true;
    };
  }, [candidates]);
};
