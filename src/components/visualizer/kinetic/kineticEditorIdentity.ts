// 编辑台、保存工程与渲染页共用的歌词签名；规则与 JIZURA parseLyrics 一致。
export const kineticLyricsSignature = (lrc: string): string => lrc.split('\n').map(row => {
    let text = row.replace(/\[[^\]]*\]/g, '').trim();
    const bar = text.indexOf('|');
    if (bar >= 0) text = text.slice(0, bar).trim();
    text = text.replace(/[!！]+$/, '').trim().replace(/\*([^*]+)\*/g, '$1');
    if (text.includes('/')) {
        const parts = text.split('/').map(part => part.trim()).filter(Boolean);
        text = parts.join(parts.some(part => /[A-Za-z]/.test(part)) ? ' ' : '');
    }
    return text;
}).join('').replace(/\s+/g, '');

export const kineticPlanMatchesLyrics = (plan: Record<string, unknown> | null, lrc: string): boolean => {
    if (!plan || !Array.isArray(plan.lines)) return false;
    const signature = plan.lines.map(line => String(line?.text ?? '')).join('').replace(/\s+/g, '');
    return signature === kineticLyricsSignature(lrc);
};
