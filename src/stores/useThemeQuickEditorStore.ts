import { create } from 'zustand';
import type { DualTheme, ThemeMode } from '../types';
import type { ThemeCacheSongKey } from '../services/themeCache';

// src/stores/useThemeQuickEditorStore.ts
// Holds the quick editor's open state and the latest editable theme snapshots.

export type ThemeQuickEditorKind = 'ai' | 'custom';

type ThemeQuickEditorContext = {
    aiTheme: DualTheme | null;
    customTheme: DualTheme | null;
    bgMode: ThemeMode;
    coverUrl: string | null;
    songKey: ThemeCacheSongKey | null;
    isDaylight: boolean;
};

type ThemeQuickEditorState = ThemeQuickEditorContext & {
    isOpen: boolean;
    editorKind: ThemeQuickEditorKind | null;
    canOpenEditor: boolean;
    setContext: (context: ThemeQuickEditorContext) => void;
    openEditor: (kind?: ThemeQuickEditorKind) => void;
    closeEditor: () => void;
};

const canOpenKind = (state: ThemeQuickEditorContext, kind: ThemeQuickEditorKind) => (
    kind === 'ai' ? Boolean(state.aiTheme) : Boolean(state.customTheme)
);

const resolveDefaultEditorKind = (state: ThemeQuickEditorContext): ThemeQuickEditorKind | null => {
    if (state.bgMode === 'custom' && state.customTheme) {
        return 'custom';
    }

    if (state.bgMode === 'ai' && state.aiTheme) {
        return 'ai';
    }

    if (state.aiTheme) {
        return 'ai';
    }

    if (state.customTheme) {
        return 'custom';
    }

    return null;
};

export const useThemeQuickEditorStore = create<ThemeQuickEditorState>((set, get) => ({
    aiTheme: null,
    customTheme: null,
    bgMode: 'default',
    coverUrl: null,
    songKey: null,
    isDaylight: false,
    isOpen: false,
    editorKind: null,
    canOpenEditor: false,
    setContext: (context) => set(state => {
        const nextKind = state.editorKind && canOpenKind(context, state.editorKind)
            ? state.editorKind
            : null;

        return {
            ...context,
            isOpen: state.isOpen && Boolean(nextKind),
            editorKind: nextKind,
            canOpenEditor: Boolean(context.aiTheme || context.customTheme),
        };
    }),
    openEditor: (kind) => {
        const state = get();
        const nextKind = kind ?? resolveDefaultEditorKind(state);
        if (!nextKind || !canOpenKind(state, nextKind)) {
            return;
        }
        set({ isOpen: true, editorKind: nextKind });
    },
    closeEditor: () => set({ isOpen: false, editorKind: null }),
}));
