import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

// dev/icuFolia/icuFoliaDataPlugin.mjs
// Builds icu-folia's Chinese data into two binary asset files, from jieba's own files in
// dev/icuFolia/jieba (see the README there) and OpenCC's tables, plus the Vite virtual modules
// that hand the runtime their URLs:
//
//   virtual:icu-folia-dict  jieba's 349k-word dictionary    -> icu-folia-dict.bin
//   virtual:icu-folia-hmm   jieba's HMM tables + t2s map    -> icu-folia-hmm.bin
//
// Why files and not JS: the module this replaced was 3.9 MB of string literals that the WebView's
// JS parser had to chew through the first time word segmentation was needed (perceptible on
// low-end phones). As plain assets the bytes skip the parser entirely; the runtime
// (src/utils/lyrics/icuFolia/jiebaData.ts) fetches the URL and decodes in single passes, keeping
// the property that made the old module fast to load: nothing is parsed or sorted at load, only
// decoded. The two files also stay under the PWA precache's 5 MB per-file limit on their own.
//
// Binary formats (decoded in jiebaData.ts):
//   dict: u32 LE wordsByteLength | f64 LE total | UTF-8 words joined '\n' | unsigned LEB128 freqs
//   hmm:  u32 LE jsonByteLength | UTF-8 JSON, zero-padded to an 8-byte boundary | float64 LE
//         blocks per state in B, E, M, S order; the JSON holds each block's byte length
//
// URL resolution per environment, so every consumer fetches the same bytes the same way:
//   build   a normal hashed Vite asset, emitted here and referenced via ROLLUP_FILE_URL
//   serve   a dev-server middleware serves the bytes from memory
//   test    a data: URL, so vitest runs the same fetch-and-decode path as the browser

export const DICT_MODULE_ID = 'virtual:icu-folia-dict';
export const HMM_MODULE_ID = 'virtual:icu-folia-hmm';
const RESOLVED = new Map([DICT_MODULE_ID, HMM_MODULE_ID].map(id => [id, `\0${id}`]));

const JIEBA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jieba');

/** The two large tables are committed gzipped (see jieba/README.md); the small ones stay plain. */
const dataPath = (file) => path.join(JIEBA_DIR, fs.existsSync(path.join(JIEBA_DIR, `${file}.gz`)) ? `${file}.gz` : file);
const readData = (file) => {
    const raw = fs.readFileSync(dataPath(file));
    return (dataPath(file).endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
};

/** Code-unit order, which is what the runtime's `<` comparisons see. */
const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Unsigned LEB128: most dictionary frequencies are small, so this is ~1.3 bytes a word. */
const encodeVarints = (values) => {
    const bytes = [];
    for (let value of values) {
        while (value >= 0x80) {
            bytes.push((value & 0x7f) | 0x80);
            value = Math.floor(value / 0x80);
        }
        bytes.push(value);
    }
    return Buffer.from(bytes);
};

const HMM_STATE_ORDER = ['B', 'E', 'M', 'S'];

/**
 * The dictionary as one binary file. `words` must already be in code-unit order, `freqs` aligned
 * with it; `total` is jieba's frequency total, stored rather than recomputed because the runtime
 * cannot replay its exact floating-point summation order (dict.txt insertion order).
 */
export const encodeDictBinary = (words, freqs, total) => {
    const wordsBytes = Buffer.from(words.join('\n'), 'utf8');
    const header = Buffer.alloc(12);
    header.writeUInt32LE(wordsBytes.length, 0);
    header.writeDoubleLE(total, 4);
    return Buffer.concat([header, wordsBytes, encodeVarints(freqs)]);
};

/**
 * The HMM tables as one binary file. `meta.emit` maps each state to [characters, log probs]; the
 * probabilities go into the float64 payload, the rest into a small JSON header. The header is
 * padded so every Float64Array view lands on an 8-byte boundary.
 */
export const encodeHmmBinary = (meta) => {
    const blocks = [];
    const emitMeta = {};
    for (const state of HMM_STATE_ORDER) {
        const [chars, logs] = meta.emit[state];
        const bytes = Buffer.from(new Float64Array(logs).buffer);
        blocks.push(bytes);
        emitMeta[state] = [chars, bytes.length];
    }
    const json = Buffer.from(JSON.stringify({
        start: meta.start,
        trans: meta.trans,
        emit: emitMeta,
        t2s: meta.t2s,
    }), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    const padding = Buffer.alloc((8 - ((4 + json.length) % 8)) % 8);
    return Buffer.concat([header, json, padding, ...blocks]);
};

const buildDictBinary = () => {
    const entries = new Map();
    for (const line of readData('dict.txt').split('\n')) {
        const [word, freq] = line.trim().split(' ');
        if (!word) continue;
        // A repeated word (the file has one, B超) keeps its last frequency and counts once towards
        // the total. That is jieba-rs's behaviour, not Python jieba's (which counts every line), and
        // it is observable: the total sets where exact floating-point ties land.
        entries.set(word, Number(freq));
    }
    let total = 0;
    entries.forEach(freq => { total += freq; });
    const words = [...entries.keys()].sort(compareCodeUnits);
    if (words.some(word => word.includes('\n'))) throw new Error('jieba dict: a word contains a newline');
    return encodeDictBinary(words, words.map(word => entries.get(word)), total);
};

/** jieba's finalseg tables are Python dict literals with '\uXXXX' keys, which JSON can read once quoted. */
const readPythonTable = (file) => {
    const source = readData(file);
    return JSON.parse(source.slice(source.indexOf('{')).replace(/'/g, '"'));
};

/** Every character whose simplified form is a different single character, as "tstst..." pairs. */
const buildT2sPairs = () => {
    // 't', not 'tw': the table also runs on simplified text, and the Taiwan preset rewrites two valid
    // simplified characters (么 -> 幺, 著 -> 着), which breaks 为什么 and 著名.
    const convert = OpenCC.Converter({ from: 't', to: 'cn' });
    let pairs = '';
    const ranges = [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]];
    for (const [from, to] of ranges) {
        for (let code = from; code <= to; code += 1) {
            const char = String.fromCharCode(code);
            const simplified = convert(char);
            if (simplified !== char && simplified.length === 1) pairs += char + simplified;
        }
    }
    return pairs;
};

const buildHmmBinary = () => {
    const emit = readPythonTable('prob_emit.py');
    // Per state: the characters as one string and their log probabilities as float64, exact, so the
    // Viterbi sums come out bit-for-bit as jieba's.
    const emitPacked = Object.fromEntries(Object.entries(emit).map(([state, table]) => {
        const chars = Object.keys(table);
        const logs = new Float64Array(chars.map(char => table[char]));
        return [state, [chars.join(''), Array.from(logs)]];
    }));
    return encodeHmmBinary({
        start: readPythonTable('prob_start.py'),
        trans: readPythonTable('prob_trans.py'),
        emit: emitPacked,
        t2s: buildT2sPairs(),
    });
};

export const icuFoliaDataPlugin = () => {
    let command = 'serve';
    let isTest = false;
    const buildBinary = (moduleId) => (moduleId === DICT_MODULE_ID ? buildDictBinary() : buildHmmBinary());
    // The extension must be part of the name: Vite's asset file template takes [extname] from it,
    // and a bare name emits files like `icu-folia-dict-<hash>.` that no glob pattern can match.
    const assetName = (moduleId) => (moduleId === DICT_MODULE_ID ? 'icu-folia-dict.bin' : 'icu-folia-hmm.bin');
    const devPath = (moduleId) => (moduleId === DICT_MODULE_ID ? '/@icu-folia-data/dict.bin' : '/@icu-folia-data/hmm.bin');

    return {
        name: 'icu-folia-data',
        configResolved(config) {
            command = config.command;
            isTest = config.mode === 'test';
        },
        resolveId(id) {
            return RESOLVED.get(id) ?? null;
        },
        load(id) {
            if (id !== RESOLVED.get(DICT_MODULE_ID) && id !== RESOLVED.get(HMM_MODULE_ID)) {
                return null;
            }
            // `id` is the resolved id (prefixed with '\0'); everything below keys off the plain one.
            const moduleId = id === RESOLVED.get(DICT_MODULE_ID) ? DICT_MODULE_ID : HMM_MODULE_ID;
            if (moduleId === DICT_MODULE_ID) {
                this.addWatchFile(dataPath('dict.txt'));
            } else {
                ['prob_start.py', 'prob_trans.py', 'prob_emit.py'].forEach(file => this.addWatchFile(dataPath(file)));
            }
            if (command === 'build') {
                const referenceId = this.emitFile({ type: 'asset', name: assetName(moduleId), source: buildBinary(moduleId) });
                return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
            }
            if (isTest) {
                const bytes = buildBinary(moduleId);
                return `export default ${JSON.stringify(`data:application/octet-stream;base64,${bytes.toString('base64')}`)};`;
            }
            // Dev server: the middleware below answers this URL with the bytes from memory.
            return `export default ${JSON.stringify(devPath(moduleId))};`;
        },
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = new URL(req.url ?? '/', 'http://localhost');
                const moduleId = url.pathname === '/@icu-folia-data/dict.bin' ? DICT_MODULE_ID
                    : url.pathname === '/@icu-folia-data/hmm.bin' ? HMM_MODULE_ID : null;
                if (!moduleId) {
                    next();
                    return;
                }
                res.setHeader('Content-Type', 'application/octet-stream');
                res.setHeader('Cache-Control', 'no-store');
                res.end(buildBinary(moduleId));
            });
        },
    };
};
