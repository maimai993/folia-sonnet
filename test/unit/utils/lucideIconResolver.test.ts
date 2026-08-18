import { describe, expect, it } from 'vitest';
import { isLucideIconName, resolveLucideIcon } from '@/utils/lucideIconResolver';

// test/unit/utils/lucideIconResolver.test.ts

describe('lucideIconResolver', () => {
    it('resolves PascalCase lucide icon names', () => {
        expect(resolveLucideIcon('Star')).toBeTruthy();
        expect(resolveLucideIcon('CloudLightning')).toBeTruthy();
        expect(resolveLucideIcon('  Star  ')).toBeTruthy();
    });

    it('rejects unknown names and empty input', () => {
        expect(resolveLucideIcon('NotAnIconAtAll')).toBeNull();
        expect(resolveLucideIcon('')).toBeNull();
        expect(resolveLucideIcon(null)).toBeNull();
        expect(resolveLucideIcon(undefined)).toBeNull();
    });

    it('rejects non-icon module exports', () => {
        expect(resolveLucideIcon('createLucideIcon')).toBeNull();
        expect(resolveLucideIcon('icons')).toBeNull();
    });

    it('exposes a boolean guard for editor validation', () => {
        expect(isLucideIconName('Star')).toBe(true);
        expect(isLucideIconName('star')).toBe(false);
    });
});
