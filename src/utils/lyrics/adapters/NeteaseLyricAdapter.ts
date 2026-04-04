import { LyricData } from '../../../types';
import { LyricAdapter } from '../LyricAdapter';
import { RawNeteaseLyric } from '../types';
import { parseLyricsAsync } from '../workerClient';
import { hasNeteasePureMusicFlag } from '../pureMusic';

export class NeteaseLyricAdapter implements LyricAdapter<RawNeteaseLyric> {
    async parse(source: RawNeteaseLyric): Promise<LyricData | null> {
        if (hasNeteasePureMusicFlag(source)) return null;

        const mainLrc = source.lrc?.lyric;
        // API responses sometimes nest yrc inside lrc or vice versa
        const anySource = source as any;
        const yrcLrc = source.yrc?.lyric || anySource.lrc?.yrc?.lyric;
        const ytlrc = source.ytlrc?.lyric || anySource.lrc?.ytlrc?.lyric;
        const tlyric = source.tlyric?.lyric || "";
        const transLrc = (yrcLrc && ytlrc) ? ytlrc : tlyric;

        if (yrcLrc) {
            return await parseLyricsAsync('yrc', yrcLrc, transLrc);
        } else if (mainLrc) {
            return await parseLyricsAsync('lrc', mainLrc, transLrc);
        }

        return null;
    }
}
