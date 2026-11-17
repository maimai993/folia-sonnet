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
import { mountLiziStage, TRANSPARENT_STAGE_IDS } from './host.mjs';

/** Right after the builtin styles, in stage-number order. */
const FIRST_ORDER = 600;

/*
 * 68 个舞台共用的几款小图标（SVG path 的 d，画在宿主 24×24 的描边画框里）。
 * 舞台太多，逐个手画不现实；按序号轮着用这几款「粒子 / 波形 / 星芒 / 音符」，
 * 用户要的只是「每款都有自己的图标」，不必精确对应画面。
 */
const GLYPHS = [
    'M5 16l3-6 3 6 3-9 3 9 2-3',            // 波形
    'M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2', // 星芒
    'M4 12h3m2-5v10m4-7v4m4-6v8m2-5h2',     // 频谱柱
    'M9 18V6l10-2v12M9 18a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3zm10-2a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3z', // 双音符
    'M4 12a8 8 0 1 1 16 0 8 8 0 0 1-16 0zm8-5v10M7 9h10M7 15h10', // 舞台圆
    'M3 17c3-8 5 8 8 0s5 8 8 0M4 7h16',     // 光带
    'M12 3l2.6 6.3L21 12l-6.4 2.7L12 21l-2.6-6.3L3 12l6.4-2.7z', // 四角星
    'M5 12h2l2-6 3 12 3-9 2 6h2',            // 跳动的线
];

/** @param {Folium} folium */
export default function activate(folium) {
    STAGES.forEach((stage, index) => {
        folium.registries.visualizers.register({
            id: `s${stage.id}`,
            // 样式名只留舞台名字本身，去掉前面的编号（001 / 002 / …）——
            // 编号只是 LIZI 那边的文件序号，在 Folia 的样式选择器里是噪音。
            label: {
                'zh-CN': stage.name,
                en: stage.name,
            },
            order: FIRST_ORDER + index,
            glyph: GLYPHS[index % GLYPHS.length],
            mount: (container, ctx) => mountLiziStage(container, ctx, stage.id),
            // No per-style settings: the page is the style. The one shared switch
            // (beat shake) stays on, as LIZI shipped it.
            settings: [],
            /*
             * 大多数舞台自己画满屏画面和歌词，宿主背景/底部字幕会和它们打架，关掉。
             * 「背景很空」的那几款例外：让宿主画它的背景层，host.mjs 同时把 iframe
             * 与页面底色清成透明，于是透出的是用户选的 Folia 背景，而不是一块黑。
             */
            hostLayers: {
                background: TRANSPARENT_STAGE_IDS.has(stage.id),
                subtitles: false,
            },
        });
    });
}
