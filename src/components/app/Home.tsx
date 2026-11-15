import React, { useMemo } from 'react';
import GridViewOverlayHost from '../../library/app/GridViewOverlayHost';
import LibraryAccountHost from '../../library/app/LibraryAccountHost';
import { resolveLibrarySurface } from '../../library/registry';
import { useLibrarySuiteStore } from '../../library/core/suite/useLibrarySuiteStore';
import { useLibraryDirectoryBatchController } from '../../library/app/useLibraryDirectoryBatchController';
import { useLibraryHomeResources } from '../../library/app/useLibraryHomeResources';
import { createLibraryPlaybackPort } from '../../library/app/createLibraryPlaybackPort';
import type { HomeViewModel } from './home/buildHomeModel';
import { useFoliumHomeNavigation } from './home/useFoliumHomeNavigation';
import { closeFoliumHomeTab } from '../../mods/folium/registries/homeTabs';
import { FoliumHomePage } from './home/FoliumHomePage';
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
    // 模组的首页页面：外壳只订阅生成扩展页签必需的条目与选中态；页面自己要的订阅随 FoliumHomePage 挂载。
    const { extraTabs, activeEntry } = useFoliumHomeNavigation();
    // 只在切换 suite 时变（开发版浮层）；同一个回退结果是同一个组件，首页不会因此重新挂载。
    const suiteId = useLibrarySuiteStore(state => state.suite);
    // 目录批量动作（本地文件夹 / 专辑 / 歌手的播放、入队、建歌单、删除、重扫）：首页一个控制器，不随渲染重建。
    const directoryActions = useLibraryDirectoryBatchController(model.surfaceProps);
    // 首页资源（在线收藏专辑、电台 feed、Navidrome 概览、文件夹树、导入与打开等首页动作）：首页一份，任何 suite 的
    // 首页都订阅同一份，换 suite 不重新请求；首页整个藏起或卸载时才作废（回来重新读）。
    const homeResources = useLibraryHomeResources(model.surfaceProps, { active: !isHomeFullyHidden });
    /*
     * 首页藏起来时不卸载，只让它隐形。
     *
     * 原来是直接 `return null`，等于把整个首页 surface 连根拔掉。三维曲库
     * （rhine）是内嵌的 iframe，卸载就意味着整个 WebView 上下文被销毁 ——
     * 从歌词页退回来要重新加载、重新建 3D 场景、相机也回到初始位置，于是
     * 就有了「退回来 3D 是空的、过一会儿才出来一点、位置还不对」。
     * 现在隐藏只做视觉上的 `hidden` + 不可交互：iframe 原地留着，返回时
     * 画面、镜头、播放指针全都在原来的地方。
     */
    const hidden = Boolean(isHomeFullyHidden);
    // 首页的播放端口（探索页歌曲卡片上的速记簿与歌单选择器用它）。
    const playback = useMemo(() => createLibraryPlaybackPort(model.surfaceProps), [model.surfaceProps]);
    /*
     * 注意这里**不能** `if (isHomeFullyHidden) return null`。
     *
     * 上面那段注释（「首页藏起来时不卸载，只让它隐形」）描述的就是这件事，但代码
     * 在这个判据上又直接返回 null —— 等于把那次修复整个绕过去了。表现：
     *
     *   - 进全屏可视化 / 歌词页 → 首页卸载 → rhine 的 iframe 跟着销毁；
     *   - 退回来 → 整个三维场景重新加载、重新建，开屏动画从头再放一遍，相机复位；
     *   - 内嵌页面里的状态（`ready`、叠层收到的卡片矩形）全丢，叠层也就不显示了。
     *
     * 所以隐藏一律走下面的 `hidden`（visibility + inert），让 surface 留在原地。
     */

    const homeSurface = resolveLibrarySurface('home', suiteId);
    const HomeSurface = homeSurface.component;

    return (
        <>
            {/* 模组页面开着时原生首页整层 inert，并且自成层叠上下文（isolate）：集合层（GridView / GridMap / TUI 的
                z-[110]）、宿主对话框（z-[120]/[140]）、开发版 suite 切换浮层只在这一层里比高低，整层压在页面（z-[60]）
                下面——集合开着时 openHomeTab 打开的页面不会被它盖住。就地渲染的登录弹窗不在这一层里，仍在页面之上。 */}
            <div
                className={activeEntry ? 'absolute inset-0 isolate' : 'absolute inset-0'}
                inert={Boolean(activeEntry) || hidden}
                aria-hidden={hidden || undefined}
                style={hidden ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
            >
                <GridViewOverlayHost
                    surfaceProps={model.surfaceProps}
                    onOpenCollection={model.onOpenCollection}
                    onPushCollection={model.onPushCollection}
                    onPopCollectionTo={model.onPopCollectionTo}
                    onBackCollection={model.onBackCollection}
                    isInteractive={isInteractive && !activeEntry}
                >
                    {(openGridView, isHomeGridInteractive) => (
                        <React.Suspense fallback={null}>
                            <HomeSurface
                                {...model.surfaceProps}
                                account={model.account}
                                extraTabs={extraTabs}
                                onNativeTabSelected={closeFoliumHomeTab}
                                onOpenGridView={openGridView}
                                isInteractive={isHomeGridInteractive}
                                declaredActions={homeSurface.declaredActions}
                                directoryActions={directoryActions}
                                homeResources={homeResources}
                                playback={playback}
                            />
                        </React.Suspense>
                    )}
                </GridViewOverlayHost>
            </div>
            {activeEntry && (
                <FoliumHomePage entry={activeEntry} extraTabs={extraTabs}
                    account={model.account} surfaceProps={model.surfaceProps} />
            )}
            {/* 登录弹窗与切换确认框：寿命与首页 surface 相同（首页整个藏起时卸载），换 suite 不卸载。 */}
            <LibraryAccountHost
                account={model.account}
                theme={model.surfaceProps.theme}
                isInteractive={isInteractive}
            />
        </>
    );
};

// Memoised because App re-renders on every store write anywhere in the app, while `homeModel`
// only changes for the 35 values it is actually built from. Without this the whole home tree
// re-runs for a volume drag.
export default React.memo(Home);
