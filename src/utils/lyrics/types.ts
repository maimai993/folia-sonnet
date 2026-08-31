import { LyricData } from '../../types';
import type { LyricParseFormat } from './parserCore';
import type { StructuredLyric, StructuredLyricLine } from '../../types/navidrome';

export type UnifiedLyric = LyricData;

export interface LyricProcessingOptions {
    includeInterludes?: boolean;
    filterPattern?: string | null;
    songId?: number;
    fetchChorusRanges?: (songId: number) => Promise<Array<{ startTime: number; endTime: number }>>;
}

// 歌词开头制作人员（staff / credits）块的处理契约，跨 utils / store / 设置面板共用。
export type LyricStaffPolicy = 'keep' | 'smart' | 'hide';
export type LyricStaffVerdict = 'none' | 'keep' | 'retime' | 'hide';

export interface LyricStaffPolicyOptions {
    policy?: LyricStaffPolicy;
    minDwellSeconds?: number;
    /** 自定义识别正则；留空使用内置词表。 */
    pattern?: string | null;
}

export interface LyricStaffDecision {
    verdict: LyricStaffVerdict;
    /** 命中的 staff 行数。 */
    blockLineCount: number;
    /** 从块首到第一句歌词之间的可用秒数。 */
    windowSeconds: number;
    /** 完整展示这些 staff 行所需的秒数。 */
    requiredSeconds: number;
    /** 判定为署名的行下标。 */
    staffIndexes: number[];
    /** 块占据的全部行下标，含分隔符行；隐藏时整组一起去掉。 */
    memberIndexes: number[];
}

export interface RawEmbeddedLyric {
    type: 'embedded';
    // Raw USLT tags parsed from music-metadata.
    usltTags?: Array<{ language?: string, descriptor?: string, text: string }>;
    // Fallback simple strings (e.g. from IndexedDB cache).
    textContent?: string;
    translationContent?: string;
}

export interface RawLocalFileLyric {
    type: 'local';
    lrcContent: string;
    tLrcContent?: string;
    formatHint?: LyricParseFormat;
}

export interface RawQrcLyric {
    type: 'qrc';
    qrcContent: string;
    translationContent?: string;
}

export interface RawNeteaseLyric {
    type: 'netease';
    lrc?: {
        lyric?: string;
        pureMusic?: boolean;
        yrc?: { lyric?: string; pureMusic?: boolean };
        ytlrc?: { lyric?: string; pureMusic?: boolean };
        yromalrc?: { lyric?: string; pureMusic?: boolean };
        romalrc?: { lyric?: string; pureMusic?: boolean };
    };
    yrc?: { lyric?: string; pureMusic?: boolean };
    ytlrc?: { lyric?: string; pureMusic?: boolean };
    yromalrc?: { lyric?: string; pureMusic?: boolean };
    tlyric?: { lyric?: string; pureMusic?: boolean };
    romalrc?: { lyric?: string; pureMusic?: boolean };
    pureMusic?: boolean;
}

export interface RawNavidromeLyric {
    type: 'navidrome';
    // OpenSubsonic structured lyrics
    structuredLyrics?: StructuredLyric | StructuredLyric[] | StructuredLyricLine[];
    // Standard Subsonic plain lyrics string
    plainLyrics?: string;
}

export type RawLyricSource = 
    | RawEmbeddedLyric 
    | RawLocalFileLyric 
    | RawQrcLyric
    | RawNeteaseLyric 
    | RawNavidromeLyric;
