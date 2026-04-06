export function splitCombinedTimeline(rawText: string): { main: string, trans: string } {
    if (!rawText) return { main: '', trans: '' };

    const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;
    const enhancedAngleRegex = /<\d{2}:\d{2}[.:]\d{2,3}>/;
    const enhancedBracketRegex = /^\s*\[\d{2}:\d{2}[.:]\d{2,3}\][^\[\]\n]+(?:\[\d{2}:\d{2}[.:]\d{2,3}\][^\[\]\n]*)+$/;
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

    const extracted: Array<{
        raw: string,
        timestamp: string,
        startTimestamp: string,
        isEnhancedLike: boolean,
    }> = [];

    for (const line of lines) {
        const matches = [...line.matchAll(timeRegex)];
        if (matches.length > 0) {
            const tagsRaw = matches.map(m => m[0]).join('');
            const startTimestamp = matches[0][0];

            extracted.push({
                raw: line,
                timestamp: tagsRaw,
                startTimestamp,
                isEnhancedLike: enhancedAngleRegex.test(line) || enhancedBracketRegex.test(line)
            });
        } else {
            extracted.push({
                raw: line,
                timestamp: '',
                startTimestamp: '',
                isEnhancedLike: false
            });
        }
    }

    const mainLines: string[] = [];
    const transLines: string[] = [];
    let isCombined = false;
    
    for (let i = 0; i < extracted.length; i++) {
        const current = extracted[i];

        if (i === extracted.length - 1) {
            mainLines.push(current.raw);
            break;
        }

        const next = extracted[i + 1];
        const isExactPair = current.timestamp !== '' && current.timestamp === next.timestamp;
        const isEnhancedPair =
            current.startTimestamp !== '' &&
            current.startTimestamp === next.startTimestamp &&
            (current.isEnhancedLike || next.isEnhancedLike);

        if (isExactPair || isEnhancedPair) {
            mainLines.push(current.raw);
            transLines.push(next.raw);
            isCombined = true;
            i++;
        } else {
            mainLines.push(current.raw);
        }
    }

    if (isCombined) {
        return { main: mainLines.join('\n'), trans: transLines.join('\n') };
    } else {
        return { main: rawText, trans: '' };
    }
}
