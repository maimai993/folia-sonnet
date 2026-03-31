import { LyricData } from '../../../types';
import { LyricAdapter } from '../LyricAdapter';
import { RawLocalFileLyric } from '../types';
import { parseLyricsAsync } from '../workerClient';
import { splitCombinedTimeline } from '../timelineSplitter';

export class LocalFileLyricAdapter implements LyricAdapter<RawLocalFileLyric> {
    async parse(source: RawLocalFileLyric): Promise<LyricData | null> {
        if (!source.lrcContent) return null;
        
        let mainLrc = source.lrcContent;
        let transLrc = source.tLrcContent || '';

        if (!transLrc) {
            const { main, trans } = splitCombinedTimeline(mainLrc);
            mainLrc = main;
            transLrc = trans;
        }

        return await parseLyricsAsync('lrc', mainLrc, transLrc);
    }
}
