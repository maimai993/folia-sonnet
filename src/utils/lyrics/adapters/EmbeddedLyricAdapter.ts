import { LyricData } from '../../../types';
import { LyricAdapter } from '../LyricAdapter';
import { RawEmbeddedLyric } from '../types';
import { parseLyricsAsync } from '../workerClient';
import { splitCombinedTimeline } from '../timelineSplitter';

export class EmbeddedLyricAdapter implements LyricAdapter<RawEmbeddedLyric> {
    async parse(source: RawEmbeddedLyric): Promise<LyricData | null> {
        let mainLrc = '';
        let transLrc = '';

        if (source.usltTags && source.usltTags.length > 0) {
            if (source.usltTags.length >= 2) {
                // Multi-USLT logic
                const chiLyric = source.usltTags.find(l => 
                    l.language?.toLowerCase() === 'chi' || 
                    l.language?.toLowerCase() === 'zho' || 
                    l.descriptor?.toLowerCase().includes('translation')
                );
                
                if (chiLyric) {
                    transLrc = chiLyric.text;
                    mainLrc = source.usltTags.find(l => l !== chiLyric)?.text || '';
                } else {
                    mainLrc = source.usltTags[0].text;
                    transLrc = source.usltTags[1].text;
                }
            } else {
                // Single USLT
                const lyrics = source.usltTags[0].text;
                const { main, trans } = splitCombinedTimeline(lyrics);
                mainLrc = main;
                transLrc = trans;
            }
        } else if (source.textContent) {
            // Fallback to text properties (previously cached)
            if (source.translationContent) {
                mainLrc = source.textContent;
                transLrc = source.translationContent;
            } else {
                // Try splitting combined timeline
                const { main, trans } = splitCombinedTimeline(source.textContent);
                mainLrc = main;
                transLrc = trans;
            }
        }

        if (!mainLrc) return null;

        return await parseLyricsAsync('lrc', mainLrc, transLrc);
    }
}
