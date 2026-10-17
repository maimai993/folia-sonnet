import { SONNET_CAMERA_INTENSITY_MAX } from '../../types';
import { buildParamSpec } from './catalog';
import type { DirectorModeInfo } from './catalog';

// src/services/lyricDirector/prompt.ts
// Everything the model is sent, and how its answer is dug back out.
//
// The contract is deliberately loose: `mode` and `params` are validated against
// the catalog afterwards, and a strict JSON schema makes the long tail of
// OpenAI-compatible endpoints reject the whole request outright.

export const MAX_LINES_IN_PROMPT = 48;
export const MAX_CHARS_PER_LINE = 90;
export const MAX_TOKENS = 2048;
export const REASON_MAX_CHARS = 200;

export interface DirectorLyricLine {
    fullText: string;
    translation: string;
    songPart: string;
    isChorus: boolean;
}

export interface DirectorSongInfo {
    title: string;
    artist: string;
    album: string | null;
    /** 这首歌来自哪个音乐平台（netease / qq / kugou …）；本地歌曲没有，留空。 */
    platform?: string;
    artists?: string[];
    provider?: string;
    mediaId?: string | number;
}

export interface DirectorPreviousChoice {
    mode: string;
    params: Record<string, unknown>;
    reason: string;
    /** The user asked for a re-decide, so the previous pick may be changed. */
    forced: boolean;
}

export interface DirectorPromptInput {
    song: DirectorSongInfo | null;
    lines: DirectorLyricLine[];
    modes: DirectorModeInfo[];
    currentMode: string;
    userHint?: string;
    recentModes?: string[];
    previousChoice?: DirectorPreviousChoice | null;
    /** Modes the AI must not pick: left out of the list *and* of the parameter space. */
    blockedModes?: readonly string[];
    /*
     * Off in the combined stage request (services/aiStage.ts): the lyrics are
     * already at the end of that prompt, so the director half must not send a
     * second copy — same words twice doubles the input for no gain.
     */
    includeLyrics?: boolean;
}

const SYSTEM_PROMPT = [
    '你是一位歌词动画导演，为一个音乐播放器挑选“歌词动画模式”并微调其参数。',
    '',
    '你会收到：歌曲信息、用户可选模式的清单（id、中文名、一句话特点）、每个模式允许调整的参数（键、取值范围、默认值），以及歌词片段。',
    '请判断这首歌的气质（情绪、节奏、段落结构、是否副歌强烈、是否纯音乐），选出一个最合适的模式，并给出该模式参数的取值。',
    '',
    '输出要求：只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块。字段：',
    '{',
    '  "mode": "<模式 id，必须来自清单>",',
    '  "reason": "<一句中文说明为什么选它，30 字以内>",',
    '  "params": { "<该模式的参数键>": <数值或布尔或枚举字符串>, ... }',
    '}',
    '',
    '规则：',
    '1. `mode` 必须精确等于清单里的某个 id。',
    '2. `params` 只放“你选的这个模式”的参数；键名必须来自清单，数值必须落在给定范围内。',
    '3. 少即是好：不确定的参数不要给。宁可只给 2~4 个你确信能提升观感的参数。',
    '4. 强烈、副歌密集的歌可以调高运动与转场强度；安静、民谣、纯音乐宜收敛（降低运动、色差、故障、转场）。',
    '5. 参数清单里形如 `xxx[需 aaa=true]` 的标记表示：该参数只有在 aaa 打开时才看得见。要改这类参数，就把 aaa 一起写进 `params`；否则它会写进去却毫无效果。',
    '6. 反过来，别给出自相矛盾的组合（例如同时 `showOnlyText=true` 与 `mgDensity`）。',
    '7. 重要：模式之间没有“更好”或“最强”，只有“更合适”。不要因为某个模式功能多、特效强就总是选它。请先认真比较各模式的气质，选那个与这首歌最贴合的；如果两三个模式都说得通，就选比较少见、更有个性的那一个，让不同歌曲尽量呈现不同模式。',
    '8. “这首歌上次的选择”指同一首歌：除非这次明显不合适，否则沿用它，让同一首歌保持稳定的观感。',
    '9. “最近用过的模式”指别的歌用过什么：列出它是为了提醒你别让所有歌都长一个样。除非这首歌确实更适合其中某个，否则优先挑一个不在这个列表里的模式。',
    `10. 商奈（sonnet）的 \`cameraIntensity\`（镜头运动强度）不能大于 ${SONNET_CAMERA_INTENSITY_MAX}：这一档的相机运动是叠在分镜与转场上的，再高就容易把镜头甩出屏幕外（画幅边缘露黑、歌词被推出画面）。参数清单里这个键的上限也写着 ${SONNET_CAMERA_INTENSITY_MAX}，别越过它；安静的歌还要更低。`,
].join('\n');

const clipLine = (text: unknown): string => {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > MAX_CHARS_PER_LINE ? `${flat.slice(0, MAX_CHARS_PER_LINE)}…` : flat;
};

/** Compact lyric digest: the model only needs enough to judge the mood. */
export const buildLyricSnippet = (lines: DirectorLyricLine[]): string => {
    if (!Array.isArray(lines) || lines.length === 0) return '(这首歌没有歌词)';
    const step = Math.max(1, Math.ceil(lines.length / MAX_LINES_IN_PROMPT));
    const picked: string[] = [];
    for (let index = 0; index < lines.length && picked.length < MAX_LINES_IN_PROMPT; index += step) {
        const line = lines[index] ?? {} as DirectorLyricLine;
        const parts: string[] = [];
        if (line.songPart) parts.push(`[${line.songPart}]`);
        if (line.isChorus) parts.push('[副歌]');
        parts.push(clipLine(line.fullText));
        if (line.translation) parts.push(`(${clipLine(line.translation)})`);
        picked.push(parts.filter(Boolean).join(' '));
    }
    return picked.join('\n');
};

export const buildSourcePrompt = (input: DirectorPromptInput): string => {
    const {
        song, lines, modes, currentMode, userHint, recentModes, previousChoice,
    } = input;
    const out = [
        `歌曲：${song?.title || '(未知曲目)'}`,
        `艺人：${song?.artist || '(未知)'}`,
        `专辑：${song?.album || '(未知)'}`,
        `当前模式：${currentMode || '(未知)'}`,
    ];
    if (userHint) out.push(`用户偏好：${clipLine(userHint)}`);

    /* Consistency per song, variety across songs: the model sees this song's own
     * last pick and what it handed to other songs recently. */
    const modeLabelOf = (id: string): string => {
        const found = modes.find((mode) => mode.id === id);
        return found?.label ? `${id}（${found.label}）` : String(id);
    };
    if (previousChoice && typeof previousChoice.mode === 'string') {
        const paramKeys = previousChoice.params ? Object.keys(previousChoice.params) : [];
        out.push(
            '',
            `这首歌上次的选择：${modeLabelOf(previousChoice.mode)}`
                + `${paramKeys.length > 0 ? `，参数 ${JSON.stringify(previousChoice.params)}` : ''}`
                + `${previousChoice.reason ? `（理由：${clipLine(previousChoice.reason)}）` : ''}`,
            previousChoice.forced
                ? '注意：用户主动要求“重新决策这首歌”，可以改变上面的选择。'
                : '这首歌的用户体验应该保持稳定，除非明显不合适，请沿用上次的选择。',
        );
    }
    const recent = (recentModes ?? []).filter((mode) => typeof mode === 'string');
    if (recent.length > 0) {
        const unique = [...new Set(recent)];
        out.push(
            '',
            `最近用过的模式（新→旧）：${unique.map((id) => modeLabelOf(id)).join('、')}`,
            '除非这首歌确实更适合其中某个，否则请优先选一个最近没用过的模式，让不同歌曲各有面貌。',
        );
    }

    out.push('', '可选模式：');
    modes.forEach((mode) => {
        out.push(`- ${mode.id}（${mode.label}）${mode.hint ? `：${mode.hint}` : ''}`);
    });
    // Every mode's parameter space, so the model can tune whichever mode it picks
    // (it chooses and tunes in one round trip). A blocked mode is left out of it
    // as well — its parameter keys would only invite an answer naming them.
    const blocked = input.blockedModes ?? [];
    const specEntries = Object.entries(buildParamSpec())
        .filter(([modeId, value]) => Boolean(value) && !blocked.includes(modeId));
    if (specEntries.length > 0) {
        out.push('', '各模式可调参数（键(范围或取值)；未列出的键不要使用）：');
        specEntries.forEach(([modeId, value]) => out.push(`- ${modeId}: ${value}`));
    }
    if (input.includeLyrics !== false) {
        out.push('', '歌词片段：', buildLyricSnippet(lines));
    }
    return out.join('\n');
};

export const buildSystemPrompt = (userHint?: string): string => (
    userHint ? `${SYSTEM_PROMPT}\n\n用户额外要求（优先满足）：${clipLine(userHint)}` : SYSTEM_PROMPT
);

/** Models answer with prose around the object often enough to be worth handling. */
export const extractJsonText = (raw: unknown): string => {
    let text = String(raw ?? '').trim();
    if (text.startsWith('```')) {
        text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    }
    if (text.startsWith('{')) return text;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) return text.slice(start, end + 1);
    return text;
};
