import { bindOmniService } from './omni/serviceAccess';
import { accountMethods } from './omni/accountMethods';
import { catalogMethods } from './omni/catalogMethods';
import { libraryMethods } from './omni/libraryMethods';
import { lyricsMethods } from './omni/lyricsMethods';
import { mutationMethods } from './omni/mutationMethods';
import { playbackMethods } from './omni/playbackMethods';
import { providerMethods } from './omni/providerMethods';
import { rawMethods } from './omni/rawMethods';

// src/services/onlineMusic/omni.ts
// Online Music Network Interface (Omni) - a unified interface for interacting with multiple online music providers.
// The implementation lives in ./omni/, one module per capability group; this file only assembles the
// object every caller imports.

const omni = {
    ...providerMethods,
    ...libraryMethods,
    ...playbackMethods,
    ...lyricsMethods,
    ...catalogMethods,
    ...accountMethods,
    ...mutationMethods,
    ...rawMethods,
};

bindOmniService(omni);

export { omni };
export type OmniService = typeof omni;
export type { LikedListRead } from './omni/accountLikes';
// 原生补写的红心认领（useCapacitorPlaybackBridge）：值从拆出来的 accountLikes 带出来。
export { applyNativeLikeOverrides } from './omni/accountLikes';
export type { NativeLikeOverrideInput } from './omni/accountLikes';
