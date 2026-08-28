import React, { useEffect, useRef } from 'react';
import { appendVisualizerEntry, removeVisualizerEntry } from '@/components/visualizer/registry';
import type { VisualizerRegistryEntry, VisualizerSharedProps } from '@/components/visualizer/definition';
import type { VisualizerMode } from '@/types';
import type { Line, Theme } from '@/types';
import type { ModRuntimeInfo, ModVisualizerContribution } from './types';
import { listMods } from './ipc';
import { isModsBridgeAvailable } from './ipc';

// src/mods/modVisualizers.tsx
// Bridges mod-declared visualizer contributions into the live visualizer
// registry. A contribution is a browser ESM module served over the
// whitelisted folia-mod:// protocol with an imperative `mount(el, props)`
// contract; this module adapts it into the React VisualizerRegistryEntry
// shape so mod modes work everywhere a builtin mode works: player, preview,
// ThemePark, and the transparent video export page.

export interface ModVisualizerMountProps {
    lines: Line[];
    currentLineIndex: number;
    currentTime: { get(): number; on(event: 'change', cb: (v: number) => void): () => void };
    theme: Theme | null;
    songTitle: string | null;
    songArtist: string | null;
    staticMode: boolean;
    paused: boolean;
}

export interface ModVisualizerModule {
    default: {
        mount: (element: HTMLElement, props: ModVisualizerMountProps) => void | (() => void);
    };
}

interface ModVisualizerDescriptor {
    mode: string;
    url: string;
    label: Record<string, string | undefined>;
    order: number;
    modName: string;
}

const resolveModVisualizerLabel = (label: Record<string, string | undefined>, modName: string): string =>
    label['zh-CN'] ?? label.en ?? label[document?.documentElement?.lang] ?? modName;

/*
 * React host for one mod visualizer. mount() owns the DOM inside the host div;
 * the returned disposer (if any) runs on unmount or song change. Continuous
 * time flows through the MotionValue subscription, never React state.
 */
const ModVisualizerHost: React.FC<{
    mount: ModVisualizerModule['default']['mount'];
    sharedProps: VisualizerSharedProps;
}> = ({ mount, sharedProps }) => {
    const hostRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const element = hostRef.current;
        if (!element) {
            return;
        }
        const dispose = mount(element, {
            lines: sharedProps.lines,
            currentLineIndex: sharedProps.currentLineIndex,
            currentTime: sharedProps.currentTime,
            theme: sharedProps.theme,
            songTitle: sharedProps.songTitle ?? null,
            songArtist: sharedProps.songArtist ?? null,
            staticMode: Boolean(sharedProps.staticMode),
            paused: Boolean(sharedProps.paused),
        });
        return () => {
            if (typeof dispose === 'function') {
                dispose();
            }
        };
        // Re-mount when the song's lyric data changes; MotionValue identity is
        // stable across renders, so it is intentionally not a dependency.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mount, sharedProps.lines, sharedProps.currentLineIndex]);

    return <div ref={hostRef} className="w-full h-full" />;
};

const buildRegistryEntry = (descriptor: ModVisualizerDescriptor, mount: ModVisualizerModule['default']['mount']): VisualizerRegistryEntry => ({
    mode: descriptor.mode as VisualizerRegistryEntry['mode'],
    order: descriptor.order,
    // Intentionally-unmapped key: getVisualizerModeLabel falls back to
    // labelFallback when the i18n dictionary has no entry, so mod labels work
    // in every locale without touching the locale files.
    labelKey: `ui.modVisualizer.${descriptor.mode}`,
    labelFallback: resolveModVisualizerLabel(descriptor.label, descriptor.modName),
    previewSeed: descriptor.mode,
    previewStartOffset: 0,
    tuningKind: 'none',
    render: (props) => <ModVisualizerHost mount={mount} sharedProps={props} />,
});

const collectDescriptors = (mods: ModRuntimeInfo[]): ModVisualizerDescriptor[] =>
    mods.flatMap((mod) =>
        (mod.visualizers ?? []).map((visualizer: ModVisualizerContribution) => ({
            mode: visualizer.mode,
            url: visualizer.url,
            label: visualizer.label ?? {},
            order: visualizer.order ?? 500,
            modName: mod.name,
        }))
    );

let initPromise: Promise<void> | null = null;

// Modes currently registered from mod contributions. Kept in sync with the live
// registry so a reload can both add newly-declared modes and remove modes whose
// mod was disabled or uninstalled (a plain cached promise would never recover).
const registeredModModes = new Set<string>();

/*
 * Reconciles mod visualizer contributions against the latest mod state. On each
 * call it re-fetches the mod list, removes registry entries whose mod stopped
 * contributing, and appends any newly-declared modes. Idempotent via the
 * registeredModModes set, so repeated calls (bootstrap, reload, enable/disable)
 * converge rather than duplicate. Per-mod import failures only skip that mod.
 */
export const initModVisualizers = async (): Promise<void> => {
    if (initPromise) {
        return initPromise;
    }
    initPromise = (async () => {
        if (!isModsBridgeAvailable()) {
            return;
        }
        const { mods } = await listMods();
        const descriptors = collectDescriptors(mods);
        const desired = new Set(descriptors.map((descriptor) => descriptor.mode));

        // Drop entries for mods that no longer contribute the mode.
        for (const mode of Array.from(registeredModModes)) {
            if (!desired.has(mode)) {
                removeVisualizerEntry(mode as VisualizerMode);
                registeredModModes.delete(mode);
            }
        }

        // Append any new contribution.
        await Promise.all(descriptors.map(async (descriptor) => {
            if (registeredModModes.has(descriptor.mode)) {
                return;
            }
            try {
                const module = await import(/* @vite-ignore */ descriptor.url) as ModVisualizerModule;
                if (typeof module?.default?.mount !== 'function') {
                    throw new Error('missing default.mount');
                }
                if (appendVisualizerEntry(buildRegistryEntry(descriptor, module.default.mount))) {
                    registeredModModes.add(descriptor.mode);
                }
            } catch (error) {
                console.warn(`[Mods] Failed to load visualizer "${descriptor.mode}":`, error);
            }
        }));
    })();
    return initPromise;
};

/*
 * Clears the cached init promise so the next call re-runs the reconciliation.
 * Called after the main-process mod state changes (install/enable/disable/
 * reload) so contributed visualizer modes track the current mod set.
 */
export const reloadModVisualizers = (): void => {
    initPromise = null;
};