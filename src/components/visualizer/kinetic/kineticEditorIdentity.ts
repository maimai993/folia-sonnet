// 仅提取 JIZURA parseLyrics 的文本身份；对实际分发解析器的对照测试钉住其语法与排序。
export const kineticLyricsSignature = (lrc: string): string => {
    const lines: Array<{ text: string; time: number | null; order?: number }> = [];
    for (const row of lrc.replace(/\r/g, '').split('\n')) {
        let text = row.trim();
        if (!text || text.startsWith('#') || /^\[(ti|ar|al|by|offset):(.*)\]$/i.test(text)) continue;
        const times: number[] = [];
        let stamp: RegExpMatchArray | null;
        while ((stamp = text.match(/^\[(\d+):(\d+(?:[.:]\d+)?)\]/))) {
            times.push(Number(stamp[1]) * 60 + parseFloat(stamp[2].replace(':', '.')));
            text = text.slice(stamp[0].length);
        }
        text = text.trim();
        if (/^\[\s*(間奏|间奏|interlude|instrumental|inst|간주)(?:\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|秒|초)?)?\s*\]$/i.test(text)) {
            text = '';
        } else {
            const bar = text.indexOf('|');
            if (bar >= 0) text = text.slice(0, bar).trim();
            // 原版只去掉一个 ASCII impact 标记；全角感叹号与单独的 ! 是正文。
            if (text.length > 1 && text.endsWith('!')) text = text.slice(0, -1).trim();
            text = text.replace(/\*([^*]+)\*/g, '$1');
            if (text.includes('/')) {
                const parts = text.split('/').map(part => part.trim()).filter(Boolean);
                text = parts.join(parts.some(part => /[A-Za-z]/.test(part)) ? ' ' : '');
            }
            if (!text) continue;
        }
        for (const time of times.length ? times : [null]) lines.push({ text, time });
    }
    if (lines.some(line => line.time !== null)) {
        let previous = -1;
        let untagged = 0;
        for (const line of lines) {
            if (line.time !== null) { previous = line.time; untagged = 0; line.order = previous; }
            else line.order = previous + 1e-6 * ++untagged;
        }
        lines.sort((first, second) => first.order! - second.order!);
    }
    return lines.map(line => line.text).join('').replace(/\s+/g, '');
};

/** 只有记录了相同宿主源歌词的工程才能还原编辑台改词，旧工程不能冒充当前歌词。 */
export const resolveKineticProjectLyrics = (saved: { sourceLyrics?: unknown; lyrics?: unknown } | null, source: string): string => (
    saved?.sourceLyrics === source && typeof saved.lyrics === 'string' ? saved.lyrics : source
);

export const kineticPlanMatchesLyrics = (plan: Record<string, unknown> | null, lrc: string): boolean => {
    if (!plan || !Array.isArray(plan.lines)) return false;
    const signature = plan.lines.map(line => String(line?.text ?? '')).join('').replace(/\s+/g, '');
    return signature === kineticLyricsSignature(lrc);
};
