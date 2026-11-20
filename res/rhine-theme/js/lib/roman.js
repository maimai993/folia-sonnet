"use strict";
// Romanized lyrics: a line in Latin letters under each lyric line (line.r), for songs in Japanese or Korean, when
// "Romanized lyrics" is on (MENU › Audio Archive › Lyrics source, STATE.lyricsRoma).
//   Korean    converted here, from the Hangul itself (Revised Romanization, with the sound changes a singer makes
//             inside a word: 감사합니다 → gamsahamnida, 좋아 → joa, 같이 → gachi). Nothing is sent anywhere.
//   Japanese  kanji cannot be read without a dictionary, so the romaji come from NetEase Cloud Music (music.163.com),
//             which has them for many songs: the track's artist, title and length are sent to find the song (as for
//             its translations, lib/translate.js), and its romaji are laid onto the lyrics by their text.

// ------------------------------------------------------------------------------------------------------ Korean
const HG_INITIAL = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const HG_VOWEL = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
// each final as [what it sounds like before a consonant or at the end, what moves on to a following vowel]
const HG_FINAL = [["", ""], ["k", "g"], ["k", "kk"], ["k", "s"], ["n", "n"], ["n", "j"], ["n", "n"], ["t", "d"], ["l", "r"], ["l", "g"],
                  ["l", "m"], ["l", "b"], ["l", "s"], ["l", "t"], ["p", "p"], ["l", "r"], ["m", "m"], ["p", "b"], ["p", "s"], ["t", "s"],
                  ["t", "ss"], ["ng", ""], ["t", "j"], ["t", "ch"], ["k", "k"], ["t", "t"], ["p", "p"], ["t", ""]];
// a final whose consonant moves on keeps its first part (ㄺ in 읽어: l + geo); the single ones keep nothing
const HG_KEEP = { 3: "k", 5: "n", 9: "l", 10: "l", 11: "l", 12: "l", 13: "l", 14: "l", 18: "p" };
const HG_H = new Set([6, 15, 27]);   // finals with ㅎ: ㄶ ㅀ ㅎ
const hgSyllable = c => c >= 0xac00 && c <= 0xd7a3;
function romanizeHangul(text) {
    const s = [...String(text || "")], out = [];
    for (let i = 0; i < s.length; i++) {
        const c = s[i].codePointAt(0);
        if (!hgSyllable(c)) { out.push(s[i]); continue; }
        const n = c - 0xac00, L = Math.floor(n / 588), V = Math.floor(n % 588 / 28), T = n % 28;
        const prev = i > 0 && hgSyllable(s[i - 1].codePointAt(0)) ? (s[i - 1].codePointAt(0) - 0xac00) % 28 : -1;
        // the initial: what the previous syllable's final leaves it (a final that moved on, or a sound change)
        let ini = HG_INITIAL[L];
        if (prev > 0) {
            if (L === 11) ini = V === 20 && prev === 7 ? "j" : V === 20 && prev === 25 ? "ch" : HG_FINAL[prev][1];   // 같이 gachi
            else if (HG_H.has(prev) && [0, 3, 12].includes(L)) ini = ["k", "t", "ch"][[0, 3, 12].indexOf(L)];       // 좋다 jota
            else if (L === 18 && [1, 7, 17, 22].includes(prev)) ini = { 1: "k", 7: "t", 17: "p", 22: "ch" }[prev];    // 축하 chuka
            else if ((L === 5 && (prev === 4 || prev === 8)) || (L === 2 && prev === 8)) ini = "l";                   // 신라 silla, 빨리 ppalli, 설날 seollal
            else if (L === 5) ini = "n";                                                                               // 종로 jongno, 독립 dongnip
        }
        // the final: before a vowel it has moved on; before ㄴ ㅁ (and ㄹ) a stop turns nasal; ㅎ goes into the next sound
        let fin = HG_FINAL[T][0];
        const next = i + 1 < s.length && hgSyllable(s[i + 1].codePointAt(0)) ? Math.floor((s[i + 1].codePointAt(0) - 0xac00) / 588) : -1;
        if (T && next >= 0) {
            if (next === 11) fin = T === 21 ? "ng" : HG_KEEP[T] || "";
            else if (next === 2 || next === 6 || next === 5) fin = fin === "k" ? "ng" : fin === "t" ? "n" : fin === "p" ? "m" : T === 4 && next === 5 ? "l" : fin === "l" && next === 2 ? "l" : fin;
            else if (HG_H.has(T) && [0, 3, 12].includes(next)) fin = T === 6 ? "n" : T === 15 ? "l" : "";
            else if (next === 18 && [1, 7, 17, 22].includes(T)) fin = "";
        }
        out.push(ini + HG_VOWEL[V] + fin);
    }
    return out.join("");
}

// ---------------------------------------------------------------------------------------------------- the lines
const ROMA = { gen: 0 };
// Adds line.r to lyrics L of `handle` when romanized lyrics are on and the song is in Japanese or Korean; onUpdate()
// runs when NetEase's romaji arrive.
function romanizeLyrics(handle, L, onUpdate) {
    const gen = ++ROMA.gen;
    if (!STATE.lyricsRoma || !L || !handle) return;
    const texts = L.lines.map(l => l.a).filter(a => a && /\S/.test(a));
    if (!texts.length || L.lines.some(l => l.r)) return;
    const lang = detectLang(texts);
    if (lang === "ko") { for (const l of L.lines) if (/[가-힣]/.test(l.a)) l.r = romanizeHangul(l.a); return; }
    if (lang !== "ja") return;
    neteaseFetch(handle, c => {
        if (gen !== ROMA.gen || !c || !c.romalrc) return;   // another track started, or NetEase has none
        // NetEase's own lyrics carry them by time; others take them by matching text, like the community translation
        if (L.source === "NETEASE") {
            const R = new Map((parseLrc(c.romalrc) || []).map(l => [Math.round(l.t * 10), l.a]));
            for (const l of L.lines) l.r = R.get(Math.round(l.t * 10)) || "";
        } else {
            const R = new Map((parseLrc(c.romalrc) || []).map(l => [Math.round(l.t * 10), l.a]));
            const N = (parseLrc(c.lrc) || []).filter(l => !NE_CREDIT.test(l.a) && lyrKey(l.a)).map(l => ({ k: lyrKey(l.a), v: R.get(Math.round(l.t * 10)) || "" }));
            if (layOnto(L, N, "r") < Math.max(1, L.lines.length / 3)) { for (const l of L.lines) l.r = ""; return; }   // not the same song
        }
        onUpdate();
    }, { roma: true });
}
