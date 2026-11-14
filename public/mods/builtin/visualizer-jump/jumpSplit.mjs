// mods/visualizer-jump/jumpSplit.mjs
// 一行歌词 → 每根柱子上的字。纯计算，不碰 DOM。
//
// 一根柱子 = 一次起跳：柱顶上写着那一次要读出来的那一两个音节。
// 切法从细到粗排了三档：
//   1. 先按分词切（`folium.lyrics.segmentWords(line)`）；
//   2. 词太长的再切小——`maxChunkChars` 是上限，`preferPair` 打开时尽量切成一两个字的块，
//      于是「这一路」变成「这 / 一 / 路」而不是一根柱子扛四个字；
//   3. 标点不吃掉一次起跳，黏在前一块上（行首标点例外，它自己占一块）。
//
// 拉丁词不拆：「because」切成「bec / ause」就没有词了。一个词要么整根柱子扛下来
// （柱子按字宽自动变长，字宽由 jumpMeasure 用宿主给的字体量出来），要么只在连字符、撇号处折断。
//
// 块里有两个字符串：`text` 是原样切下来的那一截（带首尾空白，逐字时刻按它的字数对齐），
// `display` 是去掉首尾空白的那一份——柱子上的字、块长与字盒都按它算。
// 空白看不见，却会把字挤到柱子的一头，所以它不参加排版，也不贴到柱子上。

/** 空白与纯标点不构成一次起跳：它们跟着前一块走。 */
const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;

/** 拉丁字母/数字按「半个字」折算：切块只数格子，不数字符。 */
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** 一个字的视觉宽度：CJK（含假名、谚文、全角）1 格，其余 0.55 格。 */
const charWidth = (char) => (WIDE_CHAR.test(char) ? 1 : 0.55);

const widthOf = (text) => Array.from(text).reduce((sum, char) => sum + charWidth(char), 0);

/** 英文词里可以折断的接缝：连字符、弯引号、撇号（`rock-and-roll`、`holdin'`）。 */
const LATIN_JOINT = /[-‐‑–—'’]/u;

/** 拉丁字母 / 数字：这两头之间不该出现断点，一个词要整个留在同一根柱子上。 */
const LATIN_WORD = /^[A-Za-z0-9]$/u;

/**
 * 把一段文字拆成「接缝」与「词」：接缝是连字符、弯引号、撇号（`rock-and-roll`、`holdin'`），
 * 接缝归前一段。返回的几截拼起来仍等于原文字。
 */
const cutLatinJoints = (text) => {
    const pieces = [];
    let current = '';
    Array.from(text).forEach((char) => {
        current += char;
        if (LATIN_JOINT.test(char)) {
            pieces.push(current);
            current = '';
        }
    });
    if (current) pieces.push(current);
    return pieces;
};

/**
 * 按视觉宽度把字符序列切成不超过 `maxChars` 的若干段。
 *
 * 中文没有词内空格，按字数竖着切就够了；英文只在接缝处断，断不动就整段留着——
 * 退回去把「hello」切成「hel / lo」比留一根长柱子难读得多。
 */
const cutByWidth = (text, maxChars) => {
    const limit = Math.max(1, maxChars);
    const pieces = [];
    let current = '';
    // 当前这段末尾连着的拉丁字母 / 数字有几个：它们还没到空档，不能在这里断。
    let run = 0;
    const flush = () => {
        if (current) pieces.push(current);
        current = '';
        run = 0;
    };
    // 空格黏在前一段上——它落在两块之间，单独占一根柱子会跳一次空气。
    Array.from(text).forEach((char) => {
        // 接缝归前一块：「holdin'」不把撇号留到下一根柱子上。
        if (LATIN_JOINT.test(char) && current.length > 0) {
            current += char;
            flush();
            return;
        }
        const width = /\s/u.test(char) ? 0 : charWidth(char);
        const nextRun = LATIN_WORD.test(char) ? run + 1 : 0;
        // 断点只落在空档上：把这一串字母追平之后还超上限才断。
        const cutting = Boolean(current)
            && widthOf(current) + width - nextRun * charWidth(char) > limit;
        if (cutting) flush();
        current += char;
        run = nextRun;
    });
    flush();
    return pieces;
};

/**
 * 一整段文字 → 几块。中文按字切（一两个字的碎步）；英文按词切。
 * 词比上限宽时先找接缝折（`rock-and-roll`），折不动就整词一块。
 */
const splitText = (text, maxChars) => {
    const words = text.split(/(?<=\s)/u).filter(Boolean);
    // 空格黏在前一段上（`(?<=\s)` 切出来的块自带尾空格），接缝再由 cutLatinJoints 拆开。
    const joints = words.length === 1 ? cutLatinJoints(text) : words.flatMap((word) => cutLatinJoints(word));
    return joints.flatMap((joint) => cutByWidth(joint, maxChars));
};

/**
 * 分词结果 → 块。`segments` 来自 `folium.lyrics.segmentWords(line)`。
 *
 * `maxChunkChars` 是每块的字宽上限（1 = 每个字一次起跳，2 = 一两个字的碎步），
 * `preferPair` 打开时长词按上限切，关掉时整词一块（老行为，长句会变得很笨重）。
 *
 * 「超上限才切」只对切得动的词有效：`because` 一类的拉丁词整体越过上限，
 * 否则英文歌词会被切得一个单词散在几根柱子上。
 */
export const splitJumpChunks = (segments, options = {}) => {
    const maxChars = Math.max(1, Math.round(Number(options.maxChunkChars) || 2));
    const preferSplit = options.preferPair !== false;
    const chunks = [];
    const push = (text) => {
        if (!text) return;
        if (!chunks.length) {
            chunks.push({ text });
            return;
        }
        // 标点总是黏到前一块，除非前一块已经贴着标点了（连续标点属于同一块）。
        if (PUNCTUATION_ONLY.test(text)) {
            chunks[chunks.length - 1].text += text;
            return;
        }
        chunks.push({ text });
    };

    /*
     * 先把太碎的段**并起来**：宿主的分词有时是一个字一段（`segmentWords` 在逐字时间轴上就是），
     * 直接一段一块会切出一屏碎柱子。并到「再并就超上限」为止——这一步只是把碎字凑够数，
     * 真正怎么切还是下面的 `splitText` 说了算。
     *
     * 只有「一格一格的字」才并（宿主的逐字时间轴就是这样），拉丁词一律各归各的：
     * 并进去之后 `splitText` 会把它和邻居看成一段，跨词的拉丁串就再也切不开了。
     */
    const merged = [];
    (segments ?? []).forEach((part) => {
        const text = part?.segment ?? '';
        if (!text) return;
        const trimmed = text.replace(/^\s+|\s+$/gu, '');
        if (PUNCTUATION_ONLY.test(text) || trimmed.length === 0) {
            // 纯标点/空白：黏到前一块，别单独占一次起跳。
            if (merged.length > 0) merged[merged.length - 1] += text;
            else merged.push(text);
            return;
        }
        const last = merged.length - 1;
        const lastTrimmed = last >= 0 ? merged[last].replace(/^\s+|\s+$/gu, '') : '';
        const lastIsGlyph = lastTrimmed.length > 0 && Array.from(lastTrimmed).every((char) => WIDE_CHAR.test(char));
        const glyphRun = Array.from(trimmed).every((char) => WIDE_CHAR.test(char));
        if (lastIsGlyph && glyphRun && widthOf(merged[last]) + widthOf(trimmed) <= maxChars) {
            merged[last] += text;
            return;
        }
        merged.push(text);
    });

    merged.forEach((text) => {
        const trimmed = text.replace(/^\s+|\s+$/gu, '');
        if (PUNCTUATION_ONLY.test(text) || trimmed.length === 0) {
            push(text);
            return;
        }
        const pieces = preferSplit && widthOf(trimmed) > maxChars ? splitText(trimmed, maxChars) : [trimmed];
        const leading = text.slice(0, text.indexOf(trimmed));
        const trailing = text.slice(text.indexOf(trimmed) + trimmed.length);
        pieces.forEach((piece, index) => {
            let slice = piece;
            if (index === 0) slice = leading + slice;
            if (index === pieces.length - 1) slice = slice + trailing;
            push(slice);
        });
    });

    return chunks.map((chunk) => ({
        ...chunk,
        /*
         * 贴到柱子上的那一份：**首尾空白不算字**。
         * 分词会把词间的空格留在块尾（`['hello ', 'world']`），空格看不见却占字宽——
         * 块长、字盒、字号、贴面位置都按它算，字就被顶到柱子的一头去了。
         * 块里原有的 `text` 仍带空白（沿时刻轴对齐要用它逐字切片），显示与排版只看 `display`。
         */
        display: chunk.text.replace(/^\s+|\s+$/gu, ''),
        chars: Array.from(chunk.text),
    }));
};

/**
 * 块里每个字的时刻。
 *
 * 优先用宿主给的 `line.words`（逐字 / 逐词时间），词内按字均分；
 * 只有一行一个跨整行的词时，那其实是「没有逐字时间」，按整行均分。
 */
const MIN_HOP = 0.02;

export const buildCharTimings = (line) => {
    if (!line) return [];
    const words = Array.isArray(line.words) ? line.words : [];
    const start = Number.isFinite(line.startTime) ? line.startTime : 0;
    const text = line.fullText ?? '';
    const end = Number.isFinite(line.endTime) && line.endTime > start
        ? line.endTime
        : start + Math.max(0.5, Array.from(text).length * 0.12);

    if (words.length > 0) {
        const timings = [];
        let horizontal = 0;
        words.forEach((word) => {
            const wordStart = Number.isFinite(word?.startTime) ? word.startTime : start;
            const wordEnd = Number.isFinite(word?.endTime) && word.endTime > wordStart ? word.endTime : end;
            const chars = Array.from(word?.text ?? '');
            if (chars.length === 0) return;
            const wordMoves = Math.abs((wordEnd - wordStart) - (end - start)) > 1e-6 || wordStart !== start;
            const step = Math.max(MIN_HOP, (wordEnd - wordStart) / chars.length);
            chars.forEach((char, charIndex) => {
                timings.push({
                    char,
                    start: wordStart + step * charIndex,
                    end: wordStart + step * (charIndex + 1),
                });
            });
            if (wordMoves) horizontal += 1;
        });
        // 一个跨整行的词等于没有逐字时间：退回按整行均分。
        if (timings.length > 0 && !(words.length === 1 && timings.length > 1)) return timings;
    }

    const chars = Array.from(text);
    const step = Math.max(MIN_HOP, (end - start) / Math.max(1, chars.length));
    return chars.map((char, charIndex) => ({
        char,
        start: start + step * charIndex,
        end: start + step * (charIndex + 1),
    }));
};

/** 把逐字时刻贴到块上：块的时间 = 首字起 → 末字止。 */
export const attachChunkTimings = (chunks, timings) => {
    let cursor = 0;
    return (chunks ?? []).map((chunk, index) => {
        const slice = (timings ?? []).slice(cursor, cursor + chunk.chars.length);
        cursor += chunk.chars.length;
        const first = slice[0];
        const last = slice[slice.length - 1];
        return {
            ...chunk,
            index,
            chars: slice.length > 0 ? slice : chunk.chars,
            startTime: first ? first.start : 0,
            endTime: last ? last.end : (first ? first.start + MIN_HOP : 0),
        };
    });
};

/**
 * 一行最后落成几块：块数只由「切多细」决定，不再按每行跳数硬合并——
 * 合并会让「这一路」又粘回去，正是之前那版看起来太粗的原因。
 * 上限只是保护：一行 30 个字的块数太多时，按比例放大每块的字宽上限重切一次由调用方做
 * （见 resolveChunkCap）；这里给出上限值本身。
 */
export const resolveChunkCap = (options = {}) => {
    const count = Math.max(0, Math.round(Number(options.charCount) || 0));
    const cap = Math.max(2, Math.round(Number(options.maxChunks) || 12));
    // 一行再长也不让跳数爆掉：块数上限，保证一行里每次都还看得清人。
    return count === 0 ? cap : Math.min(cap, Math.max(2, count));
};
