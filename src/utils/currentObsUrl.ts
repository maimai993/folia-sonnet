import type { DualTheme } from '../types';
import { compressConfig, readSavedCustomTheme } from '../components/modal/settings/AppearanceSettingsSubview';
import { buildVisualSettingsConfig } from './visualSettingsConfig';
import { buildObsSourceUrl } from './obsUrl';
import { useSettingsUiStore } from '../stores/useSettingsUiStore';
import { readStoredLastAppliedThemePointer } from '../services/themePreferences';
import { getLastDualTheme } from '../services/themeCache';

// src/utils/currentObsUrl.ts
// Build the OBS static URL for a given web source from the current visual settings, producing the
// same cfg as the import/export "copy config". host is left off so the OBS page uses its own
// default endpoint.

// The effective exported theme, matching the import/export "copy config" default: the active AI
// theme when an AI theme is applied, otherwise the saved custom theme (same as the prior behavior
// for the non-AI cases). The AI theme object lives only in IndexedDB (async); the last-applied
// pointer (sync) is the authoritative "AI is active" signal — getLastDualTheme() alone can return a
// theme left stale after a reset to default, so the AI read must be gated on the pointer.
export async function readEffectiveExportTheme(): Promise<DualTheme | null> {
  if (readStoredLastAppliedThemePointer() === 'ai') return (await getLastDualTheme()) ?? null;
  return readSavedCustomTheme() ?? null;
}

// Bakes the effective theme, the current light/dark preference, and the transparent-background
// toggle (cfg carries only the theme sides, so daylight/transparent ride as separate params). The
// transparent param mirrors the toggle 1:1 — on → transparent=1, off → transparent=0 (background
// shown); the overlay reads an absent param the same as transparent=0, so the default matches the
// toggle 100%.
export async function buildCurrentObsUrl(obsSource: string): Promise<string> {
  const config = { theme: await readEffectiveExportTheme(), ...buildVisualSettingsConfig() };
  const { isDaylight, transparentPlayerBackground } = useSettingsUiStore.getState();
  const extra: Record<string, string> = {};
  if (isDaylight) extra.daylight = '1';
  extra.transparent = transparentPlayerBackground ? '1' : '0';
  return buildObsSourceUrl(obsSource, compressConfig(config), '', extra);
}
