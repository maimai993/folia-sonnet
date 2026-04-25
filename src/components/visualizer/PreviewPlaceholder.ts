import { type Line, type VisualizerMode } from '../../types';
import { getLineRenderEndTime } from '../../utils/lyrics/renderHints';

const createCharacterWords = (text: string, startTime: number, endTime: number) => {
    const chars = Array.from(text);
    const duration = endTime - startTime;

    return chars.map((char, index) => {
        const charStart = startTime + duration * (index / chars.length);
        const charEnd = startTime + duration * ((index + 1) / chars.length);

        return {
            text: char,
            startTime: charStart,
            endTime: charEnd,
        };
    });
};

const createTokenWords = (tokens: string[], startTime: number, endTime: number) => {
    const duration = endTime - startTime;

    return tokens.map((token, index) => ({
        text: token,
        startTime: startTime + duration * (index / tokens.length),
        endTime: startTime + duration * ((index + 1) / tokens.length),
    }));
};

export const VIS_PLAYGROUND_PREVIEW_LINES: Line[] = [
    {
        startTime: 0.7,
        endTime: 3.6,
        fullText: '詩情を持たずとも、あなたを現実へと導くその神文の詩を紡ぐ。',
        translation: '编织那没有诗意，却能将你带到现实的神文之诗。',
        words: createCharacterWords('詩情を持たずとも、あなたを現実へと導くその神文の詩を紡ぐ。', 0.7, 3.6),
    },
    {
        startTime: 4.2,
        endTime: 7.2,
        fullText: 'Weave that prosaic divine poem that leads you to reality.',
        translation: '编织那没有诗意，却能将你带到现实的神文之诗。',
        words: createTokenWords(
            ['Weave', 'that', 'prosaic', 'divine', 'poem', 'that', 'leads', 'you', 'to', 'reality.'],
            4.2,
            7.2,
        ),
    },
    {
        startTime: 7.8,
        endTime: 10.9,
        fullText: 'Tisse ce poème divin sans poésie qui te mène au réel.',
        translation: '编织那没有诗意，却能将你带到现实的神文之诗。',
        words: createTokenWords(
            ['Tisse', 'ce', 'poème', 'divin', 'sans', 'poésie', 'qui', 'te', 'mène', 'au', 'réel.'],
            7.8,
            10.9,
        ),
    },
    {
        startTime: 11.5,
        endTime: 14.4,
        fullText: '编织那没有诗意，却能将你带到现实的神文之诗。',
        translation: '编织那没有诗意，却能将你带到现实的神文之诗。',
        words: createCharacterWords('编织那没有诗意，却能将你带到现实的神文之诗。', 11.5, 14.4),
    },
];

export const VIS_PLAYGROUND_PREVIEW_LOOP_DURATION = 14.4;

const FUME_PREVIEW_START_OFFSET = 18.4;

export const getPreviewPlaceholderStartOffset = (mode: VisualizerMode, loopDuration: number) =>
    mode === 'fume' ? FUME_PREVIEW_START_OFFSET % loopDuration : 0;

export const findPreviewPlaceholderLineIndex = (lines: Line[], time: number) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || time < line.startTime) {
            continue;
        }

        if (time <= getLineRenderEndTime(line)) {
            return index;
        }
    }

    return -1;
};
