"use strict";
// Playlist items without re-reading them on every paint: plman.GetPlaylistItems copies the whole list (a 20 000-item
// playlist costs milliseconds), so the last few lists are kept until the playlist changes. Panels that include this
// call plDirty(pl) from on_playlist_items_added / _removed / _reordered and plDirty() from on_playlists_changed.

const PL_CACHE = new Map();   // playlist index -> FbMetadbHandleList
function plItems(pl) {
    let items = PL_CACHE.get(pl);
    if (!items) {
        items = plman.GetPlaylistItems(pl);
        if (PL_CACHE.size >= 4) PL_CACHE.delete(PL_CACHE.keys().next().value);
        PL_CACHE.set(pl, items);
    }
    return items;
}
// pl undefined: every playlist (playlists were added, removed or reordered, so the indexes moved)
function plDirty(pl) { if (pl === undefined) PL_CACHE.clear(); else PL_CACHE.delete(pl); }

// total length and size of a playlist, cached with its items
const PL_STATS = new Map();
function plStats(pl) {
    const items = plItems(pl);
    let s = PL_STATS.get(items);
    if (!s) {
        s = { count: items.Count, length: items.CalcTotalDuration(), size: items.CalcTotalSize() };
        PL_STATS.clear();
        PL_STATS.set(items, s);
    }
    return s;
}

// 1.9 GB / 312 MB
function fmtSize(b) {
    if (b >= 1e9) return (b / 1073741824).toFixed(1) + " GB";
    if (b >= 1e6) return Math.round(b / 1048576) + " MB";
    return Math.round(b / 1024) + " KB";
}

// ----------------------------------------------------------------------------------------------- instrumentals
// Instrumental versions (伴奏): a track whose title says Instrumental, Inst., Off Vocal, Karaoke, カラオケ, 伴奏 … in
// brackets, after a dash or at its end, or whose VERSION tag says so. On an album that is itself instrumental (its
// title says so) nothing counts. The Archive leaves them out when it plays an album, if "skipInstrumentals" is on
// (its context menu); the playlist manager's menu removes them from a playlist (Ctrl+Z puts them back).
const INST_WORD = /(?:^|[^a-z])(?:instrumentals?|inst\.?|off[\s-]?vocal|karaoke|backing[\s-]?tracks?|minus[\s-]?one|without[\s-]?vocals?|no[\s-]?vocals?)(?![a-z])|カラオケ|オフ\s*ボーカル|インスト|伴奏/i;
// the parts of a title that name a version: (…) […] （…） 【…】 -…- ~…~ and whatever follows " - "
const INST_PARTS = /[(\[（【〔<〈「『][^)\]）】〕>〉」』]*|[~～][^~～]+[~～]?|\s[-–—－]\s.*$|-[^-]+-\s*$/g;
function isInstrumental(title, version = "", album = "") {
    if (INST_WORD.test(album)) return false;
    if (INST_WORD.test(version)) return true;
    const t = String(title || "").trim();
    if ((t.match(INST_PARTS) || []).some(p => INST_WORD.test(p))) return true;
    // "Song Instrumental", "Song Inst.": the word at the end, after the title
    const m = t.match(/\s(\S+(?:\s\S+)?)$/);
    return !!m && new RegExp(`^(?:${INST_WORD.source})\.?$`, "i").test(m[1]);
}
const TF_INST = fb.TitleFormat("%title%\u0001$meta(version)\u0001%album%");
const instrumentalFlags = list => list && list.Count ? TF_INST.EvalWithMetadbs(list).map(s => isInstrumental(...s.split("\u0001"))) : [];
// `list` without its instrumentals, except `keep` (a track asked for by name); the whole list when nothing would be left
function dropInstrumentals(list, keep) {
    const f = instrumentalFlags(list), out = fb.CreateHandleList();
    for (let i = 0; i < list.Count; i++) {
        const h = list[i];
        if (!f[i] || (keep && h.RawPath === keep.RawPath && h.SubSong === keep.SubSong)) out.Add(h);
    }
    return out.Count ? out : list;
}
// the playlist's instrumentals (their indexes)
const playlistInstrumentals = pl => instrumentalFlags(plman.GetPlaylistItems(pl)).reduce((a, f, i) => (f && a.push(i), a), []);
function removeInstrumentals(pl) {
    const idx = playlistInstrumentals(pl);
    if (!idx.length) return 0;
    plman.UndoBackup(pl);
    plman.ClearPlaylistSelection(pl);
    plman.SetPlaylistSelection(pl, idx, true);
    plman.RemovePlaylistSelection(pl, false);
    return idx.length;
}
