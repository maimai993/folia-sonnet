/**
 * Lyrics Parser Web Worker
 * 
 * Offloads LRC and YRC parsing from the main thread.
 * 
 * Message API:
 * Request: { type: 'parse', format: 'lrc' | 'enhanced-lrc' | 'yrc' | 'vtt', content: string, translation?: string, requestId?: string }
 * Response: { type: 'result', data: LyricData, requestId?: string } | { type: 'error', message: string, requestId?: string }
 */

// Inline type definitions (workers can't import from main)
interface Word {
    text: string;
    startTime: number;
    endTime: number;
}

interface Line {
    words: Word[];
    startTime: number;
    endTime: number;
    fullText: string;
    translation?: string;
    isChorus?: boolean;
    chorusEffect?: 'bars' | 'circles' | 'beams';
}

interface LyricData {
    lines: Line[];
    title?: string;
    artist?: string;
}

interface TimedTextEntry {
    startTime: number;
    endTime?: number;
    text: string;
}

interface DraftWord {
    text: string;
    startTime: number;
    endTime?: number;
}

interface DraftLine {
    words: DraftWord[];
    startTime: number;
    endTime?: number;
    fullText: string;
}

interface TimestampMarker {
    time: number;
    index: number;
    endIndex: number;
}

interface LrcMetadata {
    title?: string;
    artist?: string;
}

const GLOBAL_LRC_TIME_REGEX = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;
const GLOBAL_ANGLE_TIME_REGEX = /<(\d{2}):(\d{2})[.:](\d{2,3})>/g;
const LRC_LINE_TIME_REGEX = /^\[(\d{2}):(\d{2})[.:](\d{2,3})\]/;
const LEADING_LRC_TAGS_REGEX = /^((?:\[(?:\d{2}):(?:\d{2})[.:](?:\d{2,3})\])+)(.*)$/;
const LRC_METADATA_REGEX = /^\[(ti|ar):([^\]]*)\]$/i;

const buildTimedWords = (text: string, startTime: number, endTime: number): Word[] => {
    const duration = Math.max(endTime - startTime, 0.1);
    const rawTokens = text.split(/\s+/).filter(t => t);
    const words: Word[] = [];
    let tokens: { text: string; weight: number }[] = [];
    let totalWeight = 0;

    for (const token of rawTokens) {
        if (/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(token)) {
            const chars = token.split('');
            chars.forEach(c => {
                const isPunctuation = /[，。！？、：；"'）]/.test(c);
                const weight = isPunctuation ? 0 : 1;
                tokens.push({ text: c, weight });
                totalWeight += weight;
            });
        } else {
            const weight = 1 + (token.length * 0.15);
            tokens.push({ text: token, weight });
            totalWeight += weight;
        }
    }

    if (totalWeight === 0) totalWeight = 1;

    const activeDuration = duration * 0.9;
    const timePerWeight = activeDuration / totalWeight;
    let currentWordStart = startTime;

    if (tokens.length > 0) {
        tokens.forEach((token) => {
            const wordDuration = token.weight * timePerWeight;
            const finalDuration = Math.max(wordDuration, 0.05);

            words.push({
                text: token.text,
                startTime: currentWordStart,
                endTime: currentWordStart + finalDuration
            });

            if (token.weight > 0) {
                currentWordStart += wordDuration;
            } else {
                currentWordStart += 0.05;
            }
        });
    }

    if (words.length > 0) {
        const lastWord = words[words.length - 1];
        if (lastWord.endTime > endTime) {
            const scale = (endTime - startTime) / (lastWord.endTime - startTime);
            words.forEach(w => {
                w.startTime = startTime + (w.startTime - startTime) * scale;
                w.endTime = startTime + (w.endTime - startTime) * scale;
            });
        }
    }

    return words;
};

const attachInterludes = (lines: Line[]): Line[] => {
    const finalLines: Line[] = [];

    const createInterlude = (start: number, end: number): Line => {
        const duration = end - start;
        const dots = "......";
        const wordDuration = duration / 6;
        const words: Word[] = [];

        for (let j = 0; j < 6; j++) {
            words.push({
                text: ".",
                startTime: start + (j * wordDuration),
                endTime: start + ((j + 1) * wordDuration)
            });
        }

        return { startTime: start, endTime: end, fullText: dots, words };
    };

    if (lines.length > 0 && lines[0].startTime > 3) {
        finalLines.push(createInterlude(0.5, lines[0].startTime - 0.5));
    }

    for (let i = 0; i < lines.length; i++) {
        const current = lines[i];
        finalLines.push(current);

        const next = lines[i + 1];
        if (next) {
            const gap = next.startTime - current.endTime;
            if (gap > 3) {
                finalLines.push(createInterlude(current.endTime + 0.05, next.startTime - 0.05));
            }
        }
    }

    return finalLines;
};

const findClosestTranslation = (entries: TimedTextEntry[], startTime: number): string | undefined => {
    const candidates = entries.filter(t => Math.abs(t.startTime - startTime) < 1.0);
    candidates.sort((a, b) => Math.abs(a.startTime - startTime) - Math.abs(b.startTime - startTime));
    return candidates[0]?.text;
};

const parseTimestamp = (minute: string, second: string, fraction: string): number => {
    const min = parseInt(minute, 10);
    const sec = parseInt(second, 10);
    const ms = parseFloat(`0.${fraction}`);
    return min * 60 + sec + ms;
};

const collectTimestampMarkers = (content: string, pattern: RegExp): TimestampMarker[] => {
    const regex = new RegExp(pattern.source, 'g');

    return Array.from(content.matchAll(regex)).map(match => {
        const index = match.index ?? 0;
        return {
            time: parseTimestamp(match[1], match[2], match[3]),
            index,
            endIndex: index + match[0].length
        };
    });
};

const parseMetadataLine = (line: string, metadata: LrcMetadata): boolean => {
    const match = line.match(LRC_METADATA_REGEX);
    if (!match) {
        return false;
    }

    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === 'ti' && value) {
        metadata.title = value;
    } else if (key === 'ar' && value) {
        metadata.artist = value;
    }

    return true;
};

const buildPreciseLineDraft = (content: string, markers: TimestampMarker[]): DraftLine | null => {
    if (markers.length < 2) {
        return null;
    }

    const words: DraftWord[] = [];
    let fullText = '';

    for (let i = 0; i < markers.length - 1; i += 1) {
        const current = markers[i];
        const next = markers[i + 1];
        const segment = content.slice(current.endIndex, next.index).replace(/\r/g, '');

        fullText += segment;

        if (!segment.trim()) {
            continue;
        }

        words.push({
            text: segment,
            startTime: current.time,
            endTime: next.time
        });
    }

    const trailingText = content.slice(markers[markers.length - 1].endIndex).replace(/\r/g, '');
    fullText += trailingText;

    if (trailingText.trim()) {
        words.push({
            text: trailingText,
            startTime: markers[markers.length - 1].time
        });
    }

    if (!fullText.trim()) {
        return null;
    }

    return {
        words,
        startTime: words[0]?.startTime ?? markers[0].time,
        endTime: words[words.length - 1]?.endTime,
        fullText
    };
};

const parseSimpleTimedTextEntry = (line: string): TimedTextEntry | null => {
    const match = line.match(LEADING_LRC_TAGS_REGEX);
    if (!match) {
        return null;
    }

    const firstTag = match[1].match(LRC_LINE_TIME_REGEX);
    if (!firstTag) {
        return null;
    }

    const text = match[2].trim();
    if (!text) {
        return null;
    }

    return {
        startTime: parseTimestamp(firstTag[1], firstTag[2], firstTag[3]),
        text
    };
};

const parseTimedTextEntries = (content: string): TimedTextEntry[] => {
    const metadata: LrcMetadata = {};

    return content
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map(rawLine => {
            const line = rawLine.trim();
            if (!line) {
                return null;
            }

            if (parseMetadataLine(line, metadata)) {
                return null;
            }

            const lineTagMatch = line.match(LRC_LINE_TIME_REGEX);
            const body = lineTagMatch ? line.slice(lineTagMatch[0].length) : line;

            const angleDraft = buildPreciseLineDraft(body, collectTimestampMarkers(body, GLOBAL_ANGLE_TIME_REGEX));
            if (angleDraft) {
                return {
                    startTime: angleDraft.startTime,
                    endTime: angleDraft.endTime,
                    text: angleDraft.fullText
                };
            }

            const bracketDraft = buildPreciseLineDraft(line, collectTimestampMarkers(line, GLOBAL_LRC_TIME_REGEX));
            if (bracketDraft) {
                return {
                    startTime: bracketDraft.startTime,
                    endTime: bracketDraft.endTime,
                    text: bracketDraft.fullText
                };
            }

            return parseSimpleTimedTextEntry(line);
        })
        .filter((entry): entry is TimedTextEntry => entry !== null && entry.text.length > 0)
        .sort((a, b) => a.startTime - b.startTime);
};

// --- LRC Parser ---
export const parseLRC = (lrcString: string, translationString: string = ''): LyricData => {
    const lines: Line[] = [];

    const parseRaw = (str: string) => {
        return str
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map(line => parseSimpleTimedTextEntry(line))
            .filter((entry): entry is { startTime: number, text: string } => entry !== null && entry.text.length > 0);
    };

    const rawEntries = parseRaw(lrcString);
    const transEntries = parseTimedTextEntries(translationString);

    rawEntries.sort((a, b) => a.startTime - b.startTime);

    for (let i = 0; i < rawEntries.length; i++) {
        const current = rawEntries[i];
        const next = rawEntries[i + 1];

        const translation = findClosestTranslation(transEntries, current.startTime);

        let duration = next ? next.startTime - current.startTime : 5;

        const MAX_DURATION_PER_CHAR = 0.5;
        const estimatedReadingTime = current.text.length * MAX_DURATION_PER_CHAR;
        if (duration > estimatedReadingTime + 2 && duration > 5) {
            duration = Math.min(duration, estimatedReadingTime + 2);
        }

        const endTime = current.startTime + duration;

        const words = buildTimedWords(current.text, current.startTime, endTime);

        lines.push({
            words,
            startTime: current.startTime,
            endTime,
            fullText: current.text,
            translation
        });
    }

    return { lines: attachInterludes(lines) };
};

// --- YRC Parser ---
export const parseYRC = (yrcString: string, translationString: string = ''): LyricData => {
    console.log('[yrcParser] Verbatim lyrics found, Prioritized');
    const lines: Line[] = [];
    const translationEntries = parseTimedTextEntries(translationString);
    const rawLines = yrcString.replace(/^\uFEFF/, '').split(/\r?\n/);

    for (const rawLine of rawLines) {
        const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)/);
        if (!lineMatch) continue;

        const lineStartTimeMs = parseInt(lineMatch[1], 10);
        const lineDurationMs = parseInt(lineMatch[2], 10);
        const rest = lineMatch[3];

        const lineStartTime = lineStartTimeMs / 1000;
        const lineEndTime = (lineStartTimeMs + lineDurationMs) / 1000;

        const words: Word[] = [];
        let fullText = "";

        const wordRegex = /\((\d+),(\d+),(\d+)\)([^\(]*)/g;
        let wordMatch;

        while ((wordMatch = wordRegex.exec(rest)) !== null) {
            const wStartMs = parseInt(wordMatch[1], 10);
            const wDurMs = parseInt(wordMatch[2], 10);
            const text = wordMatch[4];

            const wStartTime = wStartMs / 1000;
            const wEndTime = (wStartMs + wDurMs) / 1000;

            words.push({ text, startTime: wStartTime, endTime: wEndTime });
            fullText += text;
        }

        const translation = findClosestTranslation(translationEntries, lineStartTime);

        if (words.length > 0) {
            lines.push({ words, startTime: lineStartTime, endTime: lineEndTime, fullText, translation });
        }
    }

    lines.sort((a, b) => a.startTime - b.startTime);

    return { lines: attachInterludes(lines) };
};

// --- VTT Parser ---
const parseVttTimestamp = (value: string): number => {
    const normalized = value.trim();
    const parts = normalized.split(':');

    let hours = 0;
    let minutes = 0;
    let seconds = 0;

    if (parts.length === 3) {
        hours = parseInt(parts[0], 10);
        minutes = parseInt(parts[1], 10);
        seconds = parseFloat(parts[2]);
    } else if (parts.length === 2) {
        minutes = parseInt(parts[0], 10);
        seconds = parseFloat(parts[1]);
    } else {
        seconds = parseFloat(parts[0]);
    }

    return (hours * 3600) + (minutes * 60) + seconds;
};

const stripVttCueText = (text: string): string => {
    return text
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
};

const parseVTTEntries = (vttString: string): TimedTextEntry[] => {
    const normalized = vttString.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    if (!normalized) {
        return [];
    }

    const blocks = normalized.split(/\n{2,}/);
    const entries: TimedTextEntry[] = [];
    const timingLineRegex = /^((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}\.\d{3})(?:\s+.*)?$/;

    for (const block of blocks) {
        const lines = block
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);

        if (lines.length === 0) continue;
        if (lines[0] === 'WEBVTT') continue;
        if (lines[0].startsWith('NOTE')) continue;
        if (lines[0] === 'STYLE' || lines[0] === 'REGION') continue;

        const timingLineIndex = lines.findIndex(line => timingLineRegex.test(line));
        if (timingLineIndex === -1) continue;

        const timingLine = lines[timingLineIndex];
        const timingMatch = timingLine.match(timingLineRegex);
        if (!timingMatch) continue;

        const text = stripVttCueText(lines.slice(timingLineIndex + 1).join(' '));
        if (!text) continue;

        const startTime = parseVttTimestamp(timingMatch[1]);
        const endTime = parseVttTimestamp(timingMatch[2]);

        entries.push({ startTime, endTime, text });
    }

    return entries.sort((a, b) => a.startTime - b.startTime);
};

export const parseVTT = (vttString: string, translationString: string = ''): LyricData => {
    const entries = parseVTTEntries(vttString);
    const translationEntries = parseVTTEntries(translationString);
    const lines: Line[] = [];

    for (let index = 0; index < entries.length; index += 1) {
        const current = entries[index];
        const next = entries[index + 1];
        const fallbackEndTime = next ? next.startTime : current.startTime + 5;
        const endTime = Math.max(current.endTime || fallbackEndTime, current.startTime + 0.1);
        const translation = findClosestTranslation(translationEntries, current.startTime);

        lines.push({
            words: buildTimedWords(current.text, current.startTime, endTime),
            startTime: current.startTime,
            endTime,
            fullText: current.text,
            translation
        });
    }

    return { lines: attachInterludes(lines) };
};

// --- Enhanced LRC Parser ---
export const parseEnhancedLRC = (lrcString: string, translationString: string = ''): LyricData => {
    const metadata: LrcMetadata = {};
    const drafts: DraftLine[] = [];
    const translationEntries = parseTimedTextEntries(translationString);
    const rawLines = lrcString.replace(/^\uFEFF/, '').split(/\r?\n/);

    for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        if (parseMetadataLine(line, metadata)) {
            continue;
        }

        const lineTagMatch = line.match(LRC_LINE_TIME_REGEX);
        const body = lineTagMatch ? line.slice(lineTagMatch[0].length) : line;

        const angleDraft = buildPreciseLineDraft(body, collectTimestampMarkers(body, GLOBAL_ANGLE_TIME_REGEX));
        if (angleDraft) {
            drafts.push(angleDraft);
            continue;
        }

        const bracketDraft = buildPreciseLineDraft(line, collectTimestampMarkers(line, GLOBAL_LRC_TIME_REGEX));
        if (bracketDraft) {
            drafts.push(bracketDraft);
            continue;
        }

        const simpleEntry = parseSimpleTimedTextEntry(line);
        if (simpleEntry) {
            drafts.push({
                words: [],
                startTime: simpleEntry.startTime,
                fullText: simpleEntry.text
            });
        }
    }

    drafts.sort((a, b) => a.startTime - b.startTime);

    const lines: Line[] = drafts.map((draft, index) => {
        const nextStart = drafts[index + 1]?.startTime;
        let lineEndTime = Math.max(draft.endTime ?? nextStart ?? (draft.startTime + 5), draft.startTime + 0.001);

        const words: Word[] = draft.words.length > 0
            ? draft.words.map((word, wordIndex) => {
                const nextWordStart = draft.words[wordIndex + 1]?.startTime;
                const fallbackEnd = nextWordStart ?? lineEndTime;
                const endTime = Math.max(word.endTime ?? fallbackEnd, word.startTime + 0.001);
                return {
                    text: word.text,
                    startTime: word.startTime,
                    endTime
                };
            })
            : buildTimedWords(draft.fullText, draft.startTime, lineEndTime);

        if (words.length > 0) {
            lineEndTime = Math.max(lineEndTime, words[words.length - 1].endTime);
        }

        return {
            words,
            startTime: draft.startTime,
            endTime: lineEndTime,
            fullText: draft.fullText,
            translation: findClosestTranslation(translationEntries, draft.startTime)
        };
    });

    return {
        lines: attachInterludes(lines),
        title: metadata.title,
        artist: metadata.artist
    };
};

// --- Worker Message Handler ---
if (typeof self !== 'undefined') {
    self.onmessage = (e: MessageEvent) => {
        const { type, format, content, translation, requestId } = e.data;

        if (type !== 'parse') {
            self.postMessage({ type: 'error', message: 'Unknown message type', requestId });
            return;
        }

        try {
            let result: LyricData;
            if (format === 'yrc') {
                result = parseYRC(content, translation || '');
            } else if (format === 'enhanced-lrc') {
                result = parseEnhancedLRC(content, translation || '');
            } else if (format === 'vtt') {
                result = parseVTT(content, translation || '');
            } else {
                result = parseLRC(content, translation || '');
            }
            self.postMessage({ type: 'result', data: result, requestId });
        } catch (err) {
            self.postMessage({ type: 'error', message: String(err), requestId });
        }
    };
}
