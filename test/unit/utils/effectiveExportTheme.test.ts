import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/utils/effectiveExportTheme.test.ts
// Locks readEffectiveExportTheme (the theme the OBS copy link bakes). The AI branch is hard to
// exercise by hand, so it is pinned here: AI active -> the cached AI theme; otherwise the saved
// custom theme (unchanged from the prior behavior for non-AI cases).

vi.mock('@/services/themePreferences', () => ({ readStoredLastAppliedThemePointer: vi.fn() }));
vi.mock('@/services/themeCache', () => ({ getLastDualTheme: vi.fn() }));
vi.mock('@/components/modal/settings/AppearanceSettingsSubview', () => ({
    readSavedCustomTheme: vi.fn(),
    compressConfig: vi.fn(() => 'folia-theme://x'),
}));

import { readEffectiveExportTheme } from '@/utils/currentObsUrl';
import { readStoredLastAppliedThemePointer } from '@/services/themePreferences';
import { getLastDualTheme } from '@/services/themeCache';
import { readSavedCustomTheme } from '@/components/modal/settings/AppearanceSettingsSubview';

const pointerMock = vi.mocked(readStoredLastAppliedThemePointer);
const aiMock = vi.mocked(getLastDualTheme);
const customMock = vi.mocked(readSavedCustomTheme);

const AI = { light: { name: 'ai-l' }, dark: { name: 'ai-d' } } as never;
const CUSTOM = { light: { name: 'custom-l' }, dark: { name: 'custom-d' } } as never;

describe('readEffectiveExportTheme', () => {
    beforeEach(() => {
        pointerMock.mockReset();
        aiMock.mockReset().mockResolvedValue(AI);
        customMock.mockReset().mockReturnValue(CUSTOM);
    });

    it('bakes the cached AI theme when AI is active', async () => {
        pointerMock.mockReturnValue('ai');
        expect(await readEffectiveExportTheme()).toBe(AI);
        expect(customMock).not.toHaveBeenCalled();
    });

    it('bakes the saved custom theme when custom is active', async () => {
        pointerMock.mockReturnValue('custom');
        expect(await readEffectiveExportTheme()).toBe(CUSTOM);
        expect(aiMock).not.toHaveBeenCalled();
    });

    it('bakes the saved custom theme on default (unchanged non-AI behavior)', async () => {
        pointerMock.mockReturnValue('default');
        expect(await readEffectiveExportTheme()).toBe(CUSTOM);
    });

    it('returns null when AI is active but no AI theme is cached (avoids a stale bake)', async () => {
        pointerMock.mockReturnValue('ai');
        aiMock.mockResolvedValue(null);
        expect(await readEffectiveExportTheme()).toBeNull();
    });

    it('returns null when no saved custom theme exists', async () => {
        pointerMock.mockReturnValue('default');
        customMock.mockReturnValue(undefined);
        expect(await readEffectiveExportTheme()).toBeNull();
    });
});
