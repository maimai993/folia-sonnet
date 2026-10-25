import type { HmmState } from './jieba';

// src/utils/lyrics/icuFolia/jiebaData.ts
// Fetches and decodes jieba's dictionary and HMM tables from the binary files
// dev/icuFolia/icuFoliaDataPlugin.mjs emits (formats documented there). The bytes reach the
// browser as plain assets, so the WebView never runs its JS parser over megabytes of data —
// that was the cost of the old 3.9 MB module. Decoding stays a few single passes: one
// TextDecoder over the words, one varint walk, one Float64Array view per HMM state.

/** jieba's dictionary: the words, their frequencies, and jieba's frequency total. */
export interface JiebaDictData {
    /** Every dictionary word, sorted by code unit, joined with '\n'. */
    words: string;
    /** The words' frequencies in the same order, as unsigned LEB128 varints. */
    freqs: Uint8Array;
    /** The sum of all frequencies in the dictionary file. */
    total: number;
}

export interface JiebaHmmData {
    start: Record<HmmState, number>;
    trans: Record<HmmState, Partial<Record<HmmState, number>>>;
    /** Per state: the characters, and their log probabilities as float64. */
    emit: Record<HmmState, [string, Float64Array]>;
    /** Traditional -> simplified, as consecutive (traditional, simplified) character pairs. */
    t2s: string;
}

const STATES: HmmState[] = ['B', 'E', 'M', 'S'];

export const decodeJiebaDict = (bytes: Uint8Array): JiebaDictData => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const wordsByteLength = view.getUint32(0, true);
    const total = view.getFloat64(4, true);
    const words = new TextDecoder().decode(bytes.subarray(12, 12 + wordsByteLength));
    // A copy, not a view: a view would keep the multi-megabyte fetch buffer alive for as long as
    // the engine lives, and only these ~0.5 MB of varints are used after decoding.
    const freqs = bytes.slice(12 + wordsByteLength);
    return { words, freqs, total };
};

export const decodeJiebaHmm = (bytes: Uint8Array): JiebaHmmData => {
    // The float64 blocks below are viewed in place, which needs an 8-byte-aligned buffer; fetch
    // answers with a fresh ArrayBuffer, but keep the guard so a stranger buffer cannot throw.
    if (bytes.byteOffset % 8 !== 0) bytes = bytes.slice(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonByteLength = view.getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jsonByteLength))) as {
        start: JiebaHmmData['start'];
        trans: JiebaHmmData['trans'];
        emit: Record<HmmState, [string, number]>;
        t2s: string;
    };
    // The plugin pads the JSON to an 8-byte boundary so the views can start right after it, and
    // lays the states' float64 blocks down in B, E, M, S order — the same order the walk follows.
    const payloadOffset = bytes.byteOffset + 4 + jsonByteLength + ((8 - ((4 + jsonByteLength) % 8)) % 8);
    let blockOffset = payloadOffset;
    const emit = Object.fromEntries(STATES.map((state) => {
        const [chars, byteLength] = meta.emit[state];
        const logs = new Float64Array(bytes.buffer, blockOffset, byteLength / 8);
        blockOffset += byteLength;
        return [state, [chars, logs]];
    })) as JiebaHmmData['emit'];
    return { start: meta.start, trans: meta.trans, emit, t2s: meta.t2s };
};

const fetchBytes = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`[icu-folia] data fetch failed (${response.status}): ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
};

export const fetchJiebaDict = async (url: string): Promise<JiebaDictData> => decodeJiebaDict(await fetchBytes(url));
export const fetchJiebaHmm = async (url: string): Promise<JiebaHmmData> => decodeJiebaHmm(await fetchBytes(url));
