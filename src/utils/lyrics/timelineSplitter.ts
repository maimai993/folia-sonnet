export function splitCombinedTimeline(rawText: string): { main: string, trans: string } {
    if (!rawText) return { main: '', trans: '' };
    
    // [00:00.00] or [00:00:00] or [00:00.000] regex
    const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

    const extracted: Array<{ timestamp: string, text: string }> = [];

    for (const line of lines) {
        const matches = [...line.matchAll(timeRegex)];
        if (matches.length > 0) {
            const tagsRaw = matches.map(m => m[0]).join('');
            const text = line.replace(timeRegex, '').trim();
            extracted.push({ timestamp: tagsRaw, text });
        } else {
            extracted.push({ timestamp: '', text: line });
        }
    }

    const mainLines: string[] = [];
    const transLines: string[] = [];
    let isCombined = false;
    
    for (let i = 0; i < extracted.length; i++) {
        const current = extracted[i];
        
        // If we are at the end, just push and break
        if (i === extracted.length - 1) {
            mainLines.push(current.timestamp + current.text);
            break;
        }

        // Compare with the next line
        const next = extracted[i + 1];
        
        // Note: We only split if timestamps exist and match exactly
        if (current.timestamp !== '' && current.timestamp === next.timestamp) {
            mainLines.push(current.timestamp + current.text);
            transLines.push(next.timestamp + next.text);
            isCombined = true;
            i++; // Skip next line because we already handled it as trans
        } else {
            mainLines.push(current.timestamp + current.text);
        }
    }

    if (isCombined) {
        return { main: mainLines.join('\n'), trans: transLines.join('\n') };
    } else {
        return { main: rawText, trans: '' };
    }
}
