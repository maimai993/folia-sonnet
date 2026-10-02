import type { LibraryRendererId } from '../core/contracts/session';
import { flushLibrarySession } from '../core/state/useLibraryBrowseSessionStore';
import { useLibraryRendererStore } from '../core/state/useLibraryRendererStore';
import { useCollectionMorphStore } from '../suites/grid/transitions/collectionMorphStore';

// src/library/app/switchLibraryRenderer.ts
// 切换集合详情的 renderer：先让当前 renderer 把焦点写回浏览会话，再清掉还没用掉的转场计划
// （它是给网格入场准备的），最后切换。浮层和行为探针都走这一条，测到的就是用户点到的。

export const switchLibraryRenderer = (sessionKey: string, renderer: LibraryRendererId): void => {
    if (useLibraryRendererStore.getState().renderer === renderer) return;
    flushLibrarySession(sessionKey);
    useCollectionMorphStore.getState().clear();
    useLibraryRendererStore.getState().setRenderer(renderer);
};
