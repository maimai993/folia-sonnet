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
 * 一首歌的 MV：是哪条 BV、画面从哪儿拉。
 *
 * 只有画面 —— 声音永远是歌曲本身的，这样歌词、节奏、可视化都还跟着歌走，
 * 而且不会因为 MV 的音轨长短不一而错位。
 */
export interface BilibiliMvStream {
    bvid: string;
    cid: number;
    title: string;
    author: string;
    durationSec: number;
    /** 带签名的画面直链，只够这一小段时间用，所以只活在这一次播放里。 */
    videoUrl: string;
    /** 实际拿到的画面高度（360 / 480 / 720 / 1080）。未登录时上限 480。 */
    quality: number;
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
