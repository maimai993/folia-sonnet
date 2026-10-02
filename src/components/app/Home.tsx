import React from 'react';
import GridViewOverlayHost from '../../library/app/GridViewOverlayHost';
import { resolveLibrarySurface } from '../../library/registry';
import { useLibrarySuiteStore } from '../../library/core/state/useLibrarySuiteStore';
import { useLibraryDirectoryBatchController } from '../../library/app/useLibraryDirectoryBatchController';
import { useLibraryHomeResources } from '../../library/app/useLibraryHomeResources';
import type { HomeViewModel } from './home/buildHomeModel';
import { countRender } from '../../dev/renderCount';

// App-level entry for the home surface backed by a view model.
// 首页 surface 经 Library registry 解析：选中的 suite 实现了首页就用它，否则回退默认 suite（网格的 Grid3D）。
// 外壳只交出首页模型与打开集合的入口，不直接 import 任何 suite。
type AppHomeProps = {
    model: HomeViewModel;
    isHomeFullyHidden?: boolean;
    isInteractive?: boolean;
};

const Home: React.FC<AppHomeProps> = ({ model, isHomeFullyHidden, isInteractive = true }) => {
    countRender('Home');
    // 只在切换 suite 时变（开发版浮层）；同一个回退结果是同一个组件，首页不会因此重新挂载。
    const suiteId = useLibrarySuiteStore(state => state.suite);
    // 目录批量动作（本地文件夹 / 专辑 / 歌手的播放、入队、建歌单、删除、重扫）：首页一个控制器，不随渲染重建。
    const directoryActions = useLibraryDirectoryBatchController(model.surfaceProps);
    // 首页资源（在线收藏专辑、电台 feed）：首页一份，任何 suite 的首页都订阅同一份。
    const homeResources = useLibraryHomeResources();
    if (isHomeFullyHidden) {
        return null;
    }

    const homeSurface = resolveLibrarySurface('home', suiteId);
    const HomeSurface = homeSurface.component;

    return (
        <GridViewOverlayHost
            surfaceProps={model.surfaceProps}
            onOpenCollection={model.onOpenCollection}
            onPushCollection={model.onPushCollection}
            onBackCollection={model.onBackCollection}
            isInteractive={isInteractive}
        >
            {(openGridView, isHomeGridInteractive) => (
                <React.Suspense fallback={null}>
                    <HomeSurface
                        {...model.surfaceProps}
                        onlineProviderPlatform={model.onlineProviderPlatform}
                        onOpenGridView={openGridView}
                        isInteractive={isHomeGridInteractive}
                        declaredActions={homeSurface.declaredActions}
                        directoryActions={directoryActions}
                        homeResources={homeResources}
                    />
                </React.Suspense>
            )}
        </GridViewOverlayHost>
    );
};

// Memoised because App re-renders on every store write anywhere in the app, while `homeModel`
// only changes for the 35 values it is actually built from. Without this the whole home tree
// re-runs for a volume drag.
export default React.memo(Home);
