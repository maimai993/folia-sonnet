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

const SYSTEM = [
    '你在帮一个音乐播放器挑「某首歌对应的 Bilibili 投稿画面」。',
    '只会把画面铺在播放页上，声音始终是歌曲本身，所以画面应该是这首歌本身相关的视频。',
    '判断标准：官方 MV > 官方音频配静止画面 > 现场版 > 歌词版。',
    '以下都不算：翻唱、伴奏、教程、reaction、解说、合集/歌单连播、与这首歌无关的视频。',
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
        '从上面挑出最像这首歌 MV 的一条。',
        '没有任何一条是这首歌的画面时，index 给 -1。',
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
