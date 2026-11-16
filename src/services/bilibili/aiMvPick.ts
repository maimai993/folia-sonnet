import type { BilibiliSearchHit } from '../../types/bilibili';
import { isAiTargetConfigured, requestAiCompletion } from '../aiCompletion';

// src/services/bilibili/aiMvPick.ts
// 让 AI 从搜索结果里挑「这首歌的 MV」。
//
// 打分的规则（mvMatch.ts）是死的：标题里有没有歌名、有没有惩罚词、时长像不像。
// 它处理不了「标题是外文译名」「投稿是同一首歌的现场版」「作者号根本不含歌手名」
// 这些要靠语义判断的情况。有 AI 就把这一步交给它，没有就退回打分（调用方负责降级）。
//
// 只发标题、作者、时长、播放量：不发封面、不发直链，也不发任何用户信息。
// 挑不出来就回 null —— 宁可没有画面，也不要错一条。

/** 喂给模型的候选上限。给太多反而挑不准，而且请求会变长。 */
const MAX_CANDIDATES = 20;

export interface AiMvPickResult {
    /** 挑中的那条；null 表示模型认为都不是。 */
    hit: BilibiliSearchHit | null;
    /** 模型给的理由，只用于日志与排查。 */
    reason: string;
}

/*
 * ★ 默认答案是「-1」（不匹配），不是「找一条凑数」。
 *
 * 以前的提示词是一路往下退：有 MV 就选 MV，没有就「官方音频配静止画面 > 现场版 >
 * 歌词版」，再往后还有时长、播放量可以帮它做决定。结果就是 —— 候选里没有一条真跟
 * 这首歌有关时，模型也会**按顺序挑一条最不坏的**，把一首完全无关的视频铺满播放页。
 * 用户报的就是这个：「不要让 AI 没有效果的结果还匹配不同的视频」。
 *
 * 现在的规则反过来：先证明「这条就是这首歌」，证不出来就交白卷。宁可没有画面，
 * 也不要一条错的 —— 没有画面只是背景少一层，错的画面是这首歌看起来配错了。
 */
const SYSTEM = [
    '你在帮一个音乐播放器挑「某首歌对应的 Bilibili 投稿画面」。',
    '只会把画面铺在播放页上，声音始终是歌曲本身，所以画面必须是**这首歌本身**的视频。',
    '',
    '判定规则 —— 必须先满足「这条是这首歌」，再谈别的：',
    '1. 标题或 UP 主信息里必须能看出是**同一首歌**（歌名、或官方 MV / 官方音源）。',
    '   只是同一位歌手的其它作品、同一张专辑的其它曲目，都不算。',
    '2. 在这条基础上，才按优先级挑：官方 MV > 其他 MV / 字幕版 MV > 现场版 > 歌词版。',
    '',
    '以下一律**不算**（哪怕是这首歌的）：翻唱、伴奏、纯音乐、教程、reaction、解说、',
    '合集 / 歌单连播、二创剪辑、与这首歌无关的视频。',
    '',
    '**关键：不确定就给 -1。** 候选里没有一条能确认是这首歌时，不要挑一条「最接近的」、',
    '不要用时长或播放量去猜。少一层画面是可接受的，配错一条不可接受。',
    '只输出 JSON，不要任何解释文字。',
].join('\n');

const describeHit = (hit: BilibiliSearchHit, index: number): string => (
    `${index}. 标题：${hit.title} / UP 主：${hit.author} / 时长：${Math.round(hit.durationSec)} 秒 / 播放：${hit.playCount}`
);

/**
 * 让 AI 从候选里挑一条。需要调用方先确认 isAiTargetConfigured()。
 *
 * 返回值里的 hit 一定来自传入的 hits 数组（按 bvid 对上再用原对象），
 * 模型编出来的 bvid 一律丢弃。
 */
export const pickMvHitWithAi = async (
    hits: readonly BilibiliSearchHit[],
    input: { title: string; artist: string; durationSec?: number },
    signal?: AbortSignal,
): Promise<AiMvPickResult> => {
    if (hits.length === 0) return { hit: null, reason: '没有候选' };
    if (!isAiTargetConfigured()) return { hit: null, reason: '没有可用的 AI 连接' };

    const candidates = hits.slice(0, MAX_CANDIDATES);
    const prompt = [
        `歌曲：${input.title}`,
        `歌手：${input.artist || '（未知）'}`,
        input.durationSec ? `时长：${Math.round(input.durationSec)} 秒` : '时长：（未知）',
        '',
        '候选视频：',
        ...candidates.map(describeHit),
        '',
        '从上面挑出**确实是这首歌**的那一条（MV 优先）。',
        '**没有一条能确认是这首歌时，index 必须给 -1** —— 不要挑最接近的凑数，',
        '也不要用时长或播放量去猜。',
        '回答格式：{"index": <数字>, "reason": "<一句话理由>"}',
    ].join('\n');

    const result = await requestAiCompletion({
        system: SYSTEM,
        prompt,
        json: true,
        temperature: 0,
        maxTokens: 200,
        signal,
    });

    const parsed = parseAnswer(result.text);
    if (!parsed) return { hit: null, reason: '模型回答看不懂' };
    if (parsed.index < 0 || parsed.index >= candidates.length) {
        return { hit: null, reason: parsed.reason || '模型认为都不是' };
    }
    return { hit: candidates[parsed.index], reason: parsed.reason };
};

/** 从模型输出里抽 `{ index, reason }`。容忍外面包了 ```json 围栏或几个字的前言。 */
const parseAnswer = (text: string): { index: number; reason: string } | null => {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const raw: unknown = JSON.parse(text.slice(start, end + 1));
        if (!raw || typeof raw !== 'object') return null;
        const obj = raw as { index?: unknown; reason?: unknown };
        const index = typeof obj.index === 'number' ? obj.index : Number(obj.index);
        if (!Number.isFinite(index)) return null;
        return {
            index: Math.trunc(index),
            reason: typeof obj.reason === 'string' ? obj.reason : '',
        };
    } catch {
        return null;
    }
};
