import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/utils/visualSettingsConfig.test.ts
// A copied OBS URL doubles as a restore payload (the import box accepts one), so the song-theme
// automation flags have to survive the copy -> paste-back round trip. Auto-generate is also pinned
// to never outlive auto-switch, matching how useThemeController composes the pair at mount.

vi.mock('@/services/themePreferences', () => ({
    readStoredThemeAutoSwitchEnabled: vi.fn(),
    readStoredThemeAutoGenerateEnabled: vi.fn(),
}));

import { buildVisualSettingsConfig } from '@/utils/visualSettingsConfig';
import { readStoredThemeAutoGenerateEnabled, readStoredThemeAutoSwitchEnabled } from '@/services/themePreferences';
import { compressConfig, decompressConfig } from '@/utils/appearanceCodec';
import { extractCfgFromInput } from '@/utils/obsUrl';

const switchMock = vi.mocked(readStoredThemeAutoSwitchEnabled);
const generateMock = vi.mocked(readStoredThemeAutoGenerateEnabled);

// A copied OBS URL, shaped as buildObsSourceUrl emits it (cfg is the terminal segment).
const asObsUrl = (cfg: string) =>
    `https://folia.example/?obs=1&obsSource=now-playing&${new URLSearchParams({ cfg }).toString()}`;

describe('buildVisualSettingsConfig', () => {
    beforeEach(() => {
        switchMock.mockReset().mockReturnValue(true);
        generateMock.mockReset().mockReturnValue(false);
    });

    it('carries the song-theme automation flags', () => {
        generateMock.mockReturnValue(true);
        expect(buildVisualSettingsConfig()).toMatchObject({
            songThemeAutoSwitchEnabled: true,
            songThemeAutoGenerateEnabled: true,
        });
    });

    it('never reports auto-generate on while auto-switch is off', () => {
        switchMock.mockReturnValue(false);
        generateMock.mockReturnValue(true);
        expect(buildVisualSettingsConfig()).toMatchObject({
            songThemeAutoSwitchEnabled: false,
            songThemeAutoGenerateEnabled: false,
        });
    });

    it('round-trips both flags through a copied OBS URL', () => {
        generateMock.mockReturnValue(true);
        const restored = decompressConfig(extractCfgFromInput(asObsUrl(compressConfig(buildVisualSettingsConfig()))));
        expect(restored.songThemeAutoSwitchEnabled).toBe(true);
        expect(restored.songThemeAutoGenerateEnabled).toBe(true);
    });

    it('round-trips the flags when both are off', () => {
        switchMock.mockReturnValue(false);
        const restored = decompressConfig(extractCfgFromInput(asObsUrl(compressConfig(buildVisualSettingsConfig()))));
        expect(restored.songThemeAutoSwitchEnabled).toBe(false);
        expect(restored.songThemeAutoGenerateEnabled).toBe(false);
    });
});
