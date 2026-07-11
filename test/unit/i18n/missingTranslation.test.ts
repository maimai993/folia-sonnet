import { describe, expect, it } from 'vitest';
import { resolveMissingTranslation } from '../../../src/i18n/missingTranslation';

// test/unit/i18n/missingTranslation.test.ts
// Verifies the missing-key fallback order used by the global i18n configuration.

describe('missing translation fallback', () => {
    const fallbacks = { 'known.key': '中文兜底' };

    it('prefers the bundled Chinese fallback', () => {
        expect(resolveMissingTranslation(fallbacks, 'known.key', 'Runtime default')).toBe('中文兜底');
    });

    it('uses the runtime default before exposing the translation key', () => {
        expect(resolveMissingTranslation(fallbacks, 'dynamic.key', 'Runtime default')).toBe('Runtime default');
        expect(resolveMissingTranslation(fallbacks, 'dynamic.key')).toBe('dynamic.key');
    });
});
