import { LyricData } from '../../../types';
import { LyricAdapter } from '../LyricAdapter';
import { processNeteaseLyrics } from '../neteaseProcessing';
import { RawNeteaseLyric } from '../types';

export class NeteaseLyricAdapter implements LyricAdapter<RawNeteaseLyric> {
    async parse(source: RawNeteaseLyric): Promise<LyricData | null> {
        return (await processNeteaseLyrics(source)).lyrics;
    }
}
