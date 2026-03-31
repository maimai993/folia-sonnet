import { LyricData } from '../../types';
import { RawLyricSource } from './types';

export interface LyricAdapter<T extends RawLyricSource> {
    parse(source: T): Promise<LyricData | null>;
}
