export {
    destroyPixiContainerChildren as destroySonnetContainerChildren,
    destroyPixiDisplayTree as destroySonnetDisplayTree,
    unloadPixiDisplayTree as unloadSonnetDisplayTree,
} from '../pixi/pixiDisplayResources';
// 商籁自建的滤镜（片尾模糊）销毁时一并把池里的离屏 RT 交还，见 pixiFilterResourceRelease.ts。
export { destroyFilterResources as destroySonnetFilter } from '../pixi/pixiFilterResourceRelease';
