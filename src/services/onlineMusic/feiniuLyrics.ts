import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { parseLyricsByFormat } from '../../utils/lyrics/parserCore';
import { isPureMusicLyricText } from '../../utils/lyrics/pureMusic';

// src/services/onlineMusic/feiniuLyrics.ts

/*
 * 飞牛 `/music/api/v1/lyric/list` 的一条。
 *
 * `content` 是整段 LRC 文本；`isLRC` 标明它是不是 LRC（纯文本歌词时就为 false）。
 * 同一首歌可能返回多条 —— 原文、译文、音译各一条，`preferred` 指出该用哪条。
 */
export type FeiniuLyricEntry = { guid?: string; content?: string; isLRC?: boolean; offset?: number };
/**
 * `preferred` 在不同固件里有两种写法：**选中那条的 guid**（字符串），或**它的下标**
 * （数字，也可能是数字字符串）。这里两种都收，不假定其中一种。
 */
export type FeiniuLyricPayload = { list?: FeiniuLyricEntry[]; preferred?: string | number };

/** 一条歌词要能用，至少得有点内容 —— 空串的条目跳过，别让它占掉「第一条」。 */
const entryText = (entry: FeiniuLyricEntry | undefined): string => String(entry?.content ?? '').trim();

/**
 * 按 `preferred` 选出该用的那条歌词。
 *
 * `preferred` 可能是 guid，也可能是下标，两种都要认：
 *   - 先按 guid 精确匹配（字符串形态的正式语义）；
 *   - 不中再看它是不是一个落在范围内的下标（数字或数字字符串形态）；
 *   - 都不中才退回第一条**非空**的。
 *
 * 只认一种语义是危险的：把下标当 guid 比永远不中，于是每首歌都静默退回 `list[0]` ——
 * 前一首碰巧对，之后就全靠运气。这正是 #252 里「第一首没问题、切歌后不对」的样子。
 */
export const pickFeiniuLyricText = (payload: FeiniuLyricPayload | null | undefined): string => {
    const list = Array.isArray(payload?.list) ? payload.list : [];
    if (list.length === 0) return '';

    const preferred = payload?.preferred;

    // 1) guid 语义。
    const byGuid = typeof preferred === 'string' && preferred !== ''
        ? list.find(entry => entry?.guid && entry.guid === preferred)
        : undefined;
    if (byGuid && entryText(byGuid)) return entryText(byGuid);

    // 2) 下标语义。接受数字与数字字符串两种形态。
    const asIndex = typeof preferred === 'string'
        ? (/^\d+$/.test(preferred.trim()) ? Number(preferred) : Number.NaN)
        : Number(preferred);
    if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < list.length) {
        const byIndex = entryText(list[asIndex]);
        /*
         * 下标命中的那一条也可能是空的（服务端偶尔给空壳条目）。这种情况下退回扫描，
         * 不要因为「指针指到了空条目」就交出一份空歌词。
         */
        if (byIndex) return byIndex;
    }

    // 3) 兜底：第一条有内容的。
    for (const entry of list) {
        const text = entryText(entry);
        if (text) return text;
    }
    return '';
};

/**
 * 去掉整段被重复拼接的情况。
 *
 * 服务端（或某条中继缓存）有时候会把同一份 LRC 连着拼好几遍返回，解析出来就是
 * 「同一句连着出现很多遍、时间戳还倒退」—— 用户看到的就是 #252 描述的样子。
 * 这里按「块」识别：如果后半段与前半段逐行相同，就当重复丢掉。
 *
 * 只看**整块重复**，不做逐行去重 —— 副歌里同一句出现两次是正常歌词，不能删。
 */
const collapseRepeatedBlocks = (lines: string[]): string[] => {
    if (lines.length < 2) return lines;
    for (let size = Math.floor(lines.length / 2); size >= 1; size -= 1) {
        // 只切等长且能整除的重复。
        if (lines.length % size !== 0) continue;
        const copies = lines.length / size;
        if (copies < 2) continue;
        const head = lines.slice(0, size);
        let same = true;
        for (let copy = 1; copy < copies && same; copy += 1) {
            for (let i = 0; i < size; i += 1) {
                if (lines[copy * size + i] !== head[i]) {
                    same = false;
                    break;
                }
            }
        }
        if (same) return head;
    }
    return lines;
};

/** 把整段重复的 LRC 文本收敛成一份。非 LRC 或本来正常时原样返回。 */
export const dedupeRepeatedLrc = (text: string): string => {
    const content = String(text ?? '');
    if (!content.includes('[')) return content;
    const lines = content.split('\n');
    const collapsed = collapseRepeatedBlocks(lines);
    return collapsed.length === lines.length ? content : collapsed.join('\n');
};

export const parseFeiniuLyrics = (text: string): ProviderLyricsResult => {
    const content = dedupeRepeatedLrc(String(text ?? ''));
    const lyrics = content ? parseLyricsByFormat('lrc', content) : null;
    return {
        lyrics: lyrics && lyrics.lines.length > 0 ? lyrics : null,
        mainText: content || null,
        isPureMusic: isPureMusicLyricText(content),
    };
};
