// mods/lizi-stages/client.mjs
// All 68 stage pages of LIZI's lyric-glass player, each registered as its own
// lyric style. That is the whole point of this shape: every page shows up in
// the style picker next to the builtin ones, so switching between them is the
// normal style switch — no settings page, no stage dropdown.
//
// Each page is kept verbatim in ./stages and runs in an <iframe>; host.mjs
// speaks the same __c100 protocol the pages were built for.

/** @typedef {import('../folium').FoliumClientApi} Folium */

import { STAGES } from './data.mjs';
import { mountLiziStage } from './host.mjs';

/** Right after the builtin styles, in stage-number order. */
const FIRST_ORDER = 600;

/** @param {Folium} folium */
export default function activate(folium) {
    STAGES.forEach((stage, index) => {
        folium.registries.visualizers.register({
            id: `s${stage.id}`,
            label: {
                'zh-CN': `${stage.id} ${stage.name}`,
                en: `${stage.id} ${stage.name}`,
            },
            order: FIRST_ORDER + index,
            mount: (container, ctx) => mountLiziStage(container, ctx, stage.id),
            // No per-style settings: the page is the style. The one shared switch
            // (beat shake) stays on, as LIZI shipped it.
            settings: [],
            // Every page paints its own full-screen set and its own lyrics on top
            // of the audio; the host's backdrop and bottom subtitles would fight
            // them.
            hostLayers: { background: false, subtitles: false },
        });
    });
}
