import { useEffect, useState } from 'react';

// src/hooks/useFontsEpoch.ts
// Signals when web fonts finish loading so measured-text layout can be recomputed.

/**
 * Returns a counter that increments every time the document finishes loading web fonts.
 *
 * Canvas text measurement (`measureText`, and pretext on top of it) silently falls back to another
 * face while a web font is still in flight, and the metrics can be ~16% off — enough to change where
 * a lyric line wraps. Measurement caches are keyed by the font *string*, which is identical before
 * and after the load, so a stale measurement would otherwise survive for the whole session.
 *
 * Take this as a dependency wherever measured text drives layout, and clear the matching caches when
 * it changes. `loadingdone` is observed as well as `ready`, so fonts pulled in later — a theme switch
 * or a user-uploaded lyric font — invalidate the measurements too.
 */
export const useFontsEpoch = (): number => {
    const [epoch, setEpoch] = useState(0);

    useEffect(() => {
        const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
        if (!fonts) {
            return;
        }

        let mounted = true;
        const bump = () => {
            if (mounted) {
                setEpoch(value => value + 1);
            }
        };

        fonts.ready?.then(bump).catch(() => undefined);
        fonts.addEventListener?.('loadingdone', bump);

        return () => {
            mounted = false;
            fonts.removeEventListener?.('loadingdone', bump);
        };
    }, []);

    return epoch;
};

export default useFontsEpoch;
