import { LyricData } from '../../../types';
import { LyricAdapter } from '../LyricAdapter';
import { RawNavidromeLyric } from '../types';
import { parseLyricsAsync } from '../workerClient';

export class NavidromeLyricAdapter implements LyricAdapter<RawNavidromeLyric> {
    async parse(source: RawNavidromeLyric): Promise<LyricData | null> {
        if (source.structuredLyrics && source.structuredLyrics.length > 0) {
            let lrcContent = '';
            source.structuredLyrics.forEach(l => {
                const totalMs = l.start || 0;
                const minutes = Math.floor(totalMs / 60000);
                const seconds = Math.floor((totalMs % 60000) / 1000);
                const ms = totalMs % 1000;
                const mm = minutes.toString().padStart(2, '0');
                const ss = seconds.toString().padStart(2, '0');
                const xx = Math.floor(ms / 10).toString().padStart(2, '0');
                lrcContent += `[${mm}:${ss}.${xx}]${l.value || ''}\n`;
            });
            return await parseLyricsAsync('lrc', lrcContent, '');
        }

        if (source.plainLyrics) {
            return await parseLyricsAsync('lrc', source.plainLyrics, '');
        }

        return null;
    }
}
