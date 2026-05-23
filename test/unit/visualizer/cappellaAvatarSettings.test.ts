import { describe, expect, it } from 'vitest';
import { resolveCappellaAvatarUrl, type CappellaAvatarImage } from '@/components/visualizer/cappella/avatarImages';
import { resolveStoredCappellaTuning } from '@/hooks/useAppPreferences';
import type { CappellaTuning } from '@/types';

// test/unit/visualizer/cappellaAvatarSettings.test.ts
// Locks Cappella avatar source persistence defaults and source priority.
const avatars: CappellaAvatarImage[] = [
    { id: 'avatar-a', name: 'A', url: '/avatar-a.png' },
    { id: 'avatar-b', name: 'B', url: '/avatar-b.png' },
];

describe('Cappella avatar tuning', () => {
    it('defaults legacy stored tuning to cover avatar source', () => {
        expect(resolveStoredCappellaTuning({
            showEmoMessages: false,
            emojiPackSource: 'custom',
        })).toEqual({
            showEmoMessages: false,
            emojiPackSource: 'custom',
            avatarSource: 'cover',
        });
    });

    it('falls back to cover for an invalid stored avatar source', () => {
        expect(resolveStoredCappellaTuning({
            avatarSource: 'missing-source',
        } as Partial<CappellaTuning>).avatarSource).toBe('cover');
    });
});

describe('Cappella avatar URL resolution', () => {
    it('uses the cover when cover source has a cover URL', () => {
        expect(resolveCappellaAvatarUrl({
            avatarSource: 'cover',
            coverUrl: '/cover.jpg',
            avatarIndex: 0,
            side: 'left',
            avatars,
        })).toBe('/cover.jpg');
    });

    it('falls back to a stable built-in avatar when cover source has no cover URL', () => {
        expect(resolveCappellaAvatarUrl({
            avatarSource: 'cover',
            avatarIndex: 0,
            side: 'left',
            avatars,
        })).toBe('/avatar-a.png');
    });

    it('uses a stable built-in avatar for builtin source even when cover exists', () => {
        expect(resolveCappellaAvatarUrl({
            avatarSource: 'builtin',
            coverUrl: '/cover.jpg',
            avatarIndex: 1,
            side: 'left',
            avatars,
        })).toBe('/avatar-b.png');
    });

    it('uses color blocks when color source is selected', () => {
        expect(resolveCappellaAvatarUrl({
            avatarSource: 'color',
            coverUrl: '/cover.jpg',
            avatarIndex: 1,
            side: 'right',
            avatars,
        })).toBeNull();
    });

    it('falls back to color blocks when built-in avatars are empty', () => {
        expect(resolveCappellaAvatarUrl({
            avatarSource: 'builtin',
            avatarIndex: 1,
            side: 'right',
            avatars: [],
        })).toBeNull();
    });
});
