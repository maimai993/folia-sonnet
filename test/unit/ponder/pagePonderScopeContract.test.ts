import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPonderTarget } from '@/components/ponder/ponderRegistry';

// test/unit/ponder/pagePonderScopeContract.test.ts

const SRC = path.resolve(__dirname, '../../../src');

const PAGE_SCOPE_OWNERS = {
    'grid-page': [
        'components/Grid3D.tsx',
        'components/folia-grid/DesktopGrid3DSurface.tsx',
    ],
    'grid-view-page': [
        'components/GridView.tsx',
        'components/ArtistGridView.tsx',
    ],
    'local-grid-map-page': ['components/GridMap.tsx'],
    'help-page': ['components/modal/SettingsModal.tsx'],
    'settings-page': ['components/modal/SettingsModal.tsx'],
} as const;

describe('page Ponder scope contract', () => {
    it.each(Object.entries(PAGE_SCOPE_OWNERS))('%s has a registered target and a real page marker', (targetId, owners) => {
        expect(findPonderTarget(targetId as Parameters<typeof findPonderTarget>[0])).not.toBeNull();
        const source = owners.map(owner => readFileSync(path.join(SRC, owner), 'utf8')).join('\n');
        expect(source).toContain('data-ponder-page-scope');
        expect(source.includes(`"${targetId}"`) || source.includes(`'${targetId}'`)).toBe(true);
    });
});
