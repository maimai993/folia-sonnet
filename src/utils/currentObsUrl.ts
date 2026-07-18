import { compressConfig, readSavedCustomTheme } from '../components/modal/settings/AppearanceSettingsSubview';
import { buildVisualSettingsConfig } from './visualSettingsConfig';
import { buildObsSourceUrl } from './obsUrl';

// src/utils/currentObsUrl.ts
// Build the OBS static URL for a given web source from the current visual settings,
// producing the same cfg as the import/export "copy config". Bakes the saved custom theme
// by default (with-theme); host is left off so the OBS page uses its own default endpoint.

export function buildCurrentObsUrl(obsSource: string): string {
  const config = { theme: readSavedCustomTheme() ?? null, ...buildVisualSettingsConfig() };
  return buildObsSourceUrl(obsSource, compressConfig(config), '');
}
