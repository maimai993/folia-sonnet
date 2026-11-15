import type { LyricData } from '../types';

// src/types/bilibili.ts
//
// bilibili MV 背景要用到的形状：一次搜索命中、为一首歌解析出来的画面流，
// 以及这首歌的调校（钉住哪条 BV、画面相对歌曲时钟偏了多少秒）。

/** 一次搜索命中的投稿。 */
export interface BilibiliSearchHit {
    bvid: string;
    title: string;
    author: string;
    /** 秒。 */
    durationSec: number;
    coverUrl: string;
    playCount: number;
}

/**
 * 一首歌的 MV：是哪条 BV、画面和声音分别从哪儿拉。
 *
 * bilibili 的 DASH 把画面与声音拆成两条流，这里两条都留着：
 * 声音交给播放器当音源，画面铺在播放页上。两端来自同一次解析、同一条投稿，
 * 所以不需要任何音画偏移 —— 播放器的进度就是 MV 的进度。
 */
export interface BilibiliMvStream {
    bvid: string;
    cid: number;
    title: string;
    author: string;
    durationSec: number;
    /** 带签名的画面直链，只够这一小段时间用，所以只活在这一次播放里。 */
    videoUrl: string;
    /**
     * 带签名的声音直链，播放器拿它当这首歌的音源。
     *
     * 空字符串表示这次解析没拿到独立音轨（老投稿只有 durl）：那种情况退回用歌曲
     * 自己的音频发声，画面照旧。
     */
    audioUrl: string;
    /** 实际拿到的画面高度（360 / 480 / 720 / 1080）。未登录时上限 480。 */
    quality: number;
    /**
     * 这条投稿自己的字幕，已经过一遍「哪些算歌词」的筛。
     *
     * null 表示没有可用字幕 —— 没有字幕文件、或者字幕只是「纯音乐欣赏」这类占位。
     * 只有设置里把 MV 歌词来源选成这一站时才会被播放页用上。
     */
    subtitles: LyricData | null;
}

export type BilibiliMvState = 'idle' | 'resolving' | 'ready' | 'missing' | 'error';

/**
 * 一首歌的 MV 调校，跟着歌一起存进匹配缓存。
 *
 * 偏移记着它是为哪条 BV 调出来的：换了视频就不再套用上一支的偏移，换回来又自动恢复。
 * 钉住哪条 BV 与偏移记着哪条 BV 是两件事 —— 清掉手写 BV 回到自动匹配时，画面没变，
 * 偏移也该留着。
 */
export interface BilibiliMvTuning {
    /** 用户钉住的 BV；空字符串表示「跟着自动匹配走」。 */
    pinnedBvid: string;
    /** 这条偏移是对哪条 BV 调出来的；空字符串表示还没解析出画面。 */
    offsetBvid: string;
    /** 秒，可带小数。正数 = 画面比声音晚，负数 = 画面比声音早。 */
    offsetSec: number;
}

export interface BilibiliMvResolution {
    state: BilibiliMvState;
    /** 这首歌的 key（`title|||artist` 的归一化形式）。 */
    songKey: string;
    stream: BilibiliMvStream | null;
    /** 匹配用的搜索词，出错时给用户看是拿什么去搜的。 */
    keyword: string;
    /** 面板里改过 BV：这一条不参与自动重搜，直到用户清掉它。 */
    manual: boolean;
    message?: string;
}

/** 原生桥回来的原始信封：只有通不通，业务码交给上层解析。 */
export interface BilibiliBridgeResponse {
    ok: boolean;
    status: number;
    bodyText: string;
}
