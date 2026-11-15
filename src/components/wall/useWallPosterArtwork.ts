import { useEffect, useMemo, useState } from 'react';
import { COVER_MAX_SIZE, COVER_SIZE_STEPS, getOriginalCoverUrl, getSizedCoverUrl, resolveCoverSizeStep } from '../../utils/coverUrl';
import { isHdslbImageUrl, hdslbImageBlobUrl, hdslbImageBlobUrlSync } from '../../services/bilibili/hdslbImage';

// src/components/wall/useWallPosterArtwork.ts
// Picks which variant of a cover one poster paints. The wall draws the same list (the play queue,
// or the explore page's entries) at four gears and repeats it across the plane, so handing every
// card the provider's original meant a full-size decode per instance; a card asks for the step its
// own box needs instead.

/**
 * Variants known to have decoded. A poster that pans back in, or one of the other instances of the
 * same song that a repeating wall always has, can paint one of these on its first frame instead of
 * fading up from the empty card colour. Insertion ordered, oldest evicted first; only upgrades are
 * recorded, so this stays far smaller than the number of posters on screen.
 */
const MAX_TRACKED_VARIANTS = 600;
const decodedVariants = new Map<string, true>();
/** In-flight decodes, so one URL is fetched once however many posters want it at the same moment. */
const decodingVariants = new Map<string, Promise<boolean>>();
/**
 * Variants that would not load. A local cover whose binary is missing from the asset store answers
 * 404 for every size, and without this a card would ask again on each gear change and each press.
 * Bounded like the decoded set, and for the same reason.
 */
const failedVariants = new Map<string, true>();

/** Ladder step the URL was cut at; `Infinity` stands for `COVER_MAX_SIZE`, or the provider's own asset where a poster keeps it. */
type PosterArtwork = {
    /** Cover this variant came from. A queue shift can point one slot at a different song. */
    cover: string;
    step: number;
    url: string;
};

const remember = (registry: Map<string, true>, url: string): void => {
    registry.delete(url);
    registry.set(url, true);
    while (registry.size > MAX_TRACKED_VARIANTS) {
        const oldest = registry.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        registry.delete(oldest);
    }
};

// Past the top step a poster gets COVER_MAX_SIZE, not the provider's original: a wall of distinct
// multi-megapixel covers outgrows Chromium's decode cache and each tile raster decodes one again.
// A poster that is one picture spread over a whole block (`keepOriginal`) keeps the original.
const variantUrl = (cover: string, step: number, keepOriginal = false): string => {
    if (Number.isFinite(step)) return getSizedCoverUrl(cover, step);
    return keepOriginal ? getOriginalCoverUrl(cover) : getSizedCoverUrl(cover, COVER_MAX_SIZE);
};

// Waits for a decoded frame rather than a load event: the swap that follows is then a repaint of
// something already rasterized, instead of a decode landing in the middle of the expansion spring.
const decodeVariant = (url: string): Promise<boolean> => {
    if (!url || typeof Image === 'undefined' || failedVariants.has(url)) return Promise.resolve(false);
    const pending = decodingVariants.get(url);
    if (pending) return pending;

    // B 站图床的图不经 <img> 直连：i0.hdslb.com 按热点封来源，直连隔三差五 403。
    // 这里换成原生代理取字节 → blob URL（带 B 站 Referer + 登录 cookie，风控认这个），
    // 取回来的就是一张本地图，decode 走的完全是本地字节。取不到（null）就退回原地址
    // 让它按老样子试。
    const image = new Image();
    image.decoding = 'async';
    const request = (isHdslbImageUrl(url)
        ? hdslbImageBlobUrl(url).then(local => {
            image.src = local ?? url;
            return typeof image.decode === 'function'
                ? image.decode()
                : new Promise<void>((resolve, reject) => {
                    image.onload = () => resolve();
                    image.onerror = () => reject(new Error(`Cover variant failed: ${url}`));
                });
        })
        : Promise.resolve().then(() => {
            image.src = url;
            return typeof image.decode === 'function'
                ? image.decode()
                : new Promise<void>((resolve, reject) => {
                    image.onload = () => resolve();
                    image.onerror = () => reject(new Error(`Cover variant failed: ${url}`));
                });
        }))
        .then(() => {
            remember(decodedVariants, url);
            return true;
        })
        .catch(() => {
            remember(failedVariants, url);
            return false;
        })
        .finally(() => { decodingVariants.delete(url); });
    decodingVariants.set(url, request);
    return request;
};

/**
 * Best variant of `cover` this box can paint without waiting: its own step when that is already
 * decoded, otherwise the sharpest decoded step below it, which is blurry for a moment but beats an
 * empty card. Stand-ins are only ever coarser - reaching for a decoded step above the box would
 * hand a thumbnail-sized card the full-size bitmap some other card pulled, which is the cost this
 * whole path exists to avoid. With nothing decoded the box's own step is returned and simply loads.
 */
const pickDisplay = (cover: string, targetStep: number, keepOriginal: boolean): PosterArtwork => {
    const targetUrl = variantUrl(cover, targetStep, keepOriginal);
    if (decodedVariants.has(targetUrl)) return { cover, step: targetStep, url: targetUrl };

    for (let index = COVER_SIZE_STEPS.length - 1; index >= 0; index -= 1) {
        const step = COVER_SIZE_STEPS[index];
        if (step >= targetStep) continue;
        const url = variantUrl(cover, step);
        if (decodedVariants.has(url)) return { cover, step, url };
    }

    return { cover, step: targetStep, url: targetUrl };
};

/** Fetches the variant a box of `sizePx` will need, off the path of the interaction that opens it. */
export const prewarmWallPosterArtwork = (cover: string | undefined, sizePx: number): void => {
    if (!cover) return;
    const url = variantUrl(cover, resolveCoverSizeStep(sizePx));
    if (!url || decodedVariants.has(url) || failedVariants.has(url)) return;
    void decodeVariant(url);
};

/**
 * Artwork one poster should paint for a box `sizePx` device pixels across.
 *
 * The returned URL moves up to the step the box deserves only once that step has finished decoding,
 * so a card that changes gear keeps painting what it already had for the length of the reflow
 * instead of blanking. It never trades back down either: a collapsed card holding a sharper copy
 * costs nothing to keep, while dropping to a smaller variant would buy a refetch and a second swap.
 *
 * `keepOriginal` lets a box past the top step paint the provider's original instead of
 * `COVER_MAX_SIZE` - for one picture spread over many tiles, where there is only one to decode.
 */
export const useWallPosterArtwork = (
    cover: string | undefined,
    sizePx: number,
    { keepOriginal = false }: { keepOriginal?: boolean } = {},
): string => {
    const source = cover ?? '';
    const targetStep = resolveCoverSizeStep(sizePx);
    const [ready, setReady] = useState<PosterArtwork>(() => pickDisplay(source, targetStep, keepOriginal));
    // Recomputed only when this slot changes song; the artwork of the previous one must not linger.
    const current = useMemo(
        () => (ready.cover === source ? ready : pickDisplay(source, targetStep, keepOriginal)),
        [ready, source, targetStep, keepOriginal],
    );

    useEffect(() => {
        if (!source || (current.cover === source && current.step >= targetStep)) return;
        const url = variantUrl(source, targetStep, keepOriginal);
        const upgrade = () => setReady({ cover: source, step: targetStep, url });
        if (decodedVariants.has(url)) {
            upgrade();
            return;
        }
        let cancelled = false;
        void decodeVariant(url).then(decoded => {
            if (decoded && !cancelled) upgrade();
        });
        return () => { cancelled = true; };
    }, [current, source, targetStep, keepOriginal]);

    // B 站图床的地址不能直接摆到 <img src> 上（403 见上文）：decode 已把字节经原生
    // 代理换成本地 blob，这里渲染出口同样换 —— URL 还没换好时给空串，卡片按「图未到」
    // 画占位，blob 一到下一次渲染就是它。
    const display = useMemo(() => {
        const url = current.url;
        if (!url || !isHdslbImageUrl(url)) return url;
        const local = hdslbImageBlobUrlSync(url);
        return local ?? '';
    }, [current.url]);

    return display;
};
