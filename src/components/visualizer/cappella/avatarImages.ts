import type { CappellaAvatarSource } from '../../../types';

// src/components/visualizer/cappella/avatarImages.ts
// Loads built-in Cappella avatar images and resolves the active avatar source.
export type CappellaAvatarSide = 'left' | 'right';

export interface CappellaAvatarImage {
    id: string;
    name: string;
    url: string;
}

interface ResolveCappellaAvatarUrlInput {
    avatarSource: CappellaAvatarSource;
    coverUrl?: string | null;
    avatarIndex: number;
    side: CappellaAvatarSide;
    avatars?: CappellaAvatarImage[];
}

const avatarModules = import.meta.glob<{ default: string }>(
    './avatar/*.{png,jpg,jpeg,gif,webp,svg}',
    { eager: true },
);

const toStableAvatarImages = (): CappellaAvatarImage[] =>
    Object.entries(avatarModules)
        .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
        .map(([path, mod]) => {
            const filename = path.split('/').pop() ?? '';
            const name = filename.replace(/\.[^.]+$/, '');
            return {
                id: `builtin-avatar-${name}`,
                name,
                url: mod.default,
            };
        });

export const builtinAvatarImages = toStableAvatarImages();

export const pickStableBuiltinAvatarImage = (
    avatars: CappellaAvatarImage[],
    avatarIndex: number,
    side: CappellaAvatarSide,
): CappellaAvatarImage | null => {
    if (avatars.length === 0) {
        return null;
    }

    const sideOffset = side === 'right' ? 37 : 0;
    const resolvedIndex = Math.abs(Math.trunc(avatarIndex + sideOffset)) % avatars.length;
    return avatars[resolvedIndex] ?? null;
};

export const resolveCappellaAvatarUrl = ({
    avatarSource,
    coverUrl,
    avatarIndex,
    side,
    avatars = builtinAvatarImages,
}: ResolveCappellaAvatarUrlInput): string | null => {
    if (avatarSource === 'color') {
        return null;
    }

    if (avatarSource === 'cover' && coverUrl) {
        return coverUrl;
    }

    return pickStableBuiltinAvatarImage(avatars, avatarIndex, side)?.url ?? null;
};
