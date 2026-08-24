import type { PersonalFmRequestOptions } from '../../types/onlineMusic';

// src/services/onlineMusic/fmModes.ts
// Personal FM mode catalogue, shared by the command palette surface and the request layer so a
// mode looks and behaves the same wherever it is offered. Ids mirror NetEase's `/personal/fm/mode`
// parameters verbatim; only NetEase implements them, other providers ignore the selection.

export type PersonalFmModeId = 'DEFAULT' | 'FAMILIAR' | 'EXPLORE' | 'SCENE_RCMD' | 'PUZZLE_MODE_RCMD';
export type PersonalFmSceneCategory = 'mood' | 'activity' | 'genre' | 'language';

export type PersonalFmModeEntry = {
    id: PersonalFmModeId;
    labelKey: string;
    labelFallback: string;
};

export type PersonalFmSceneEntry = {
    id: string;
    category: PersonalFmSceneCategory;
    labelKey: string;
    labelFallback: string;
};

export type PersonalFmSelection = {
    mode: PersonalFmModeId;
    /** Only meaningful for SCENE_RCMD; every other mode rejects a submode. */
    scene: string | null;
};

export const DEFAULT_PERSONAL_FM_SELECTION: PersonalFmSelection = { mode: 'DEFAULT', scene: null };

const mode = (id: PersonalFmModeId, labelFallback: string): PersonalFmModeEntry => ({
    id,
    labelKey: `personalFmMode.mode.${id}`,
    labelFallback,
});

// SCENE_RCMD sits last: it is the only mode the scene row can select on the user's behalf, so the
// row below it reads as its continuation.
export const PERSONAL_FM_MODES: PersonalFmModeEntry[] = [
    mode('DEFAULT', 'Default'),
    mode('FAMILIAR', 'Familiar'),
    mode('EXPLORE', 'Explore'),
    mode('PUZZLE_MODE_RCMD', 'Puzzle'),
    mode('SCENE_RCMD', 'Scene'),
];

const scene = (id: string, category: PersonalFmSceneCategory, labelFallback: string): PersonalFmSceneEntry => ({
    id,
    category,
    labelKey: `personalFmMode.scene.${id}`,
    labelFallback,
});

export const PERSONAL_FM_SCENE_CATEGORIES: { id: PersonalFmSceneCategory; labelKey: string; labelFallback: string }[] = [
    { id: 'mood', labelKey: 'personalFmMode.category.mood', labelFallback: 'Mood' },
    { id: 'activity', labelKey: 'personalFmMode.category.activity', labelFallback: 'Moment' },
    { id: 'genre', labelKey: 'personalFmMode.category.genre', labelFallback: 'Genre' },
    { id: 'language', labelKey: 'personalFmMode.category.language', labelFallback: 'Language' },
];

export const PERSONAL_FM_SCENES: PersonalFmSceneEntry[] = [
    scene('NIGHT_EMO', 'mood', 'Melancholy'),
    scene('CURE', 'mood', 'Healing'),
    scene('CHEERFUL', 'mood', 'Cheerful'),
    scene('LYRICAL', 'mood', 'Lyrical'),
    scene('INSPIRATIONAL', 'mood', 'Inspirational'),
    scene('RELAX', 'mood', 'Relax'),
    scene('SWEET', 'mood', 'Love Songs'),

    scene('EXERCISE', 'activity', 'Workout'),
    scene('FOCUS', 'activity', 'Focus'),
    scene('SLEEP_HELP', 'activity', 'Sleep'),
    scene('TAKE_SHOWER', 'activity', 'Shower'),
    scene('COMMUTE', 'activity', 'Commute'),
    scene('COFFEE_SHOP', 'activity', 'Coffee Shop'),
    scene('GAMES', 'activity', 'Gaming'),
    scene('DANCE', 'activity', 'Dance'),
    scene('RAINY', 'activity', 'Rainy Day'),

    scene('RHYTHM_BLUES', 'genre', 'R&B'),
    scene('RAP', 'genre', 'Rap'),
    scene('K_POP', 'genre', 'K-Pop'),
    scene('ELECTRONIC', 'genre', 'Electronic'),
    scene('ROCK', 'genre', 'Rock'),
    scene('FOLK', 'genre', 'Folk'),
    scene('GUDIAN', 'genre', 'Classical'),
    scene('JAZZ', 'genre', 'Jazz'),
    scene('BLUE', 'genre', 'Blues'),
    scene('PUNK', 'genre', 'Funk'),
    scene('COUNTRY', 'genre', 'Country'),
    scene('LIGHT', 'genre', 'Light Music'),
    scene('GUOFENG', 'genre', 'Guofeng'),
    scene('MANYAO', 'genre', 'Slow DJ'),
    scene('MUSICAL', 'genre', 'Musical'),
    scene('ACG', 'genre', 'ACG'),
    scene('JINGDIAN', 'genre', 'Classics'),
    scene('ORIGINAL_MUSICIAL', 'genre', 'Indie Original'),
    scene('YINGSHI', 'genre', 'Soundtrack'),

    scene('CHINESE', 'language', 'Mandarin'),
    scene('ENGLISH', 'language', 'Western'),
    scene('YUEYU', 'language', 'Cantonese'),
    scene('JAPANESE', 'language', 'Japanese'),
    scene('FRANCH', 'language', 'French'),
    scene('LATIN', 'language', 'Latin'),
    scene('GLOBAL', 'language', 'Global'),
];

const MODE_IDS = new Set<string>(PERSONAL_FM_MODES.map(entry => entry.id));
const SCENE_IDS = new Set<string>(PERSONAL_FM_SCENES.map(entry => entry.id));

export const getPersonalFmSceneEntry = (id: string | null | undefined): PersonalFmSceneEntry | null => (
    PERSONAL_FM_SCENES.find(entry => entry.id === id) ?? null
);

/** Drops a scene that no longer exists, and a scene attached to a mode that cannot carry one. */
export const normalizePersonalFmSelection = (raw: unknown): PersonalFmSelection => {
    const candidate = raw as Partial<PersonalFmSelection> | null | undefined;
    const modeId = typeof candidate?.mode === 'string' && MODE_IDS.has(candidate.mode)
        ? candidate.mode as PersonalFmModeId
        : DEFAULT_PERSONAL_FM_SELECTION.mode;
    if (modeId !== 'SCENE_RCMD') {
        return { mode: modeId, scene: null };
    }
    const sceneId = typeof candidate?.scene === 'string' && SCENE_IDS.has(candidate.scene) ? candidate.scene : null;
    // SCENE_RCMD without a submode is rejected by the API, so it degrades to the default mode.
    return sceneId ? { mode: 'SCENE_RCMD', scene: sceneId } : DEFAULT_PERSONAL_FM_SELECTION;
};

export const isSamePersonalFmSelection = (left: PersonalFmSelection, right: PersonalFmSelection) => (
    left.mode === right.mode && left.scene === right.scene
);

export const isDefaultPersonalFmSelection = (selection: PersonalFmSelection) => (
    isSamePersonalFmSelection(selection, DEFAULT_PERSONAL_FM_SELECTION)
);

export const toPersonalFmRequestOptions = (selection: PersonalFmSelection): PersonalFmRequestOptions => ({
    mode: selection.mode,
    submode: selection.scene,
});

/** "Scene · Sleep" for SCENE_RCMD, the plain mode name otherwise. */
export const getPersonalFmSelectionLabel = (
    selection: PersonalFmSelection,
    t: (key: string, fallback?: string) => string,
): string => {
    const modeEntry = PERSONAL_FM_MODES.find(entry => entry.id === selection.mode) ?? PERSONAL_FM_MODES[0];
    const modeLabel = t(modeEntry.labelKey, modeEntry.labelFallback);
    const sceneEntry = getPersonalFmSceneEntry(selection.scene);
    return sceneEntry ? `${modeLabel} · ${t(sceneEntry.labelKey, sceneEntry.labelFallback)}` : modeLabel;
};
