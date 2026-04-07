import { LyricData } from '../../types';
import { detectChorusLines } from '../chorusDetector';

const CHORUS_EFFECTS: Array<'bars' | 'circles' | 'beams'> = ['bars', 'circles', 'beams'];

export const applyDetectedChorusEffects = (
    lyrics: LyricData,
    mainLrc: string,
    random: () => number = Math.random
): LyricData => {
    const chorusLines = detectChorusLines(mainLrc);
    if (chorusLines.size === 0) {
        return lyrics;
    }

    const effectMap = new Map<string, 'bars' | 'circles' | 'beams'>();
    chorusLines.forEach(text => {
        const index = Math.floor(random() * CHORUS_EFFECTS.length) % CHORUS_EFFECTS.length;
        effectMap.set(text, CHORUS_EFFECTS[index]);
    });

    return {
        ...lyrics,
        lines: lyrics.lines.map(line => {
            const text = line.fullText.trim();
            if (!chorusLines.has(text)) {
                return line;
            }

            return {
                ...line,
                isChorus: true,
                chorusEffect: effectMap.get(text)
            };
        })
    };
};
