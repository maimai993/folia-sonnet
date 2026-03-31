import { LyricData } from '../../types';
import { RawLyricSource } from './types';
import { EmbeddedLyricAdapter } from './adapters/EmbeddedLyricAdapter';
import { NeteaseLyricAdapter } from './adapters/NeteaseLyricAdapter';
import { NavidromeLyricAdapter } from './adapters/NavidromeLyricAdapter';
import { LocalFileLyricAdapter } from './adapters/LocalFileLyricAdapter';

export class LyricParserFactory {
    static async parse(source: RawLyricSource): Promise<LyricData | null> {
        switch (source.type) {
            case 'embedded':
                return await new EmbeddedLyricAdapter().parse(source);
            case 'netease':
                return await new NeteaseLyricAdapter().parse(source);
            case 'navidrome':
                return await new NavidromeLyricAdapter().parse(source);
            case 'local':
                return await new LocalFileLyricAdapter().parse(source);
            default:
                console.warn('[LyricParserFactory] Unknown lyric source type:', (source as any)?.type);
                return null;
        }
    }
}
