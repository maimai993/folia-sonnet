import { countRender } from './dev/renderCount';
import AppSurface from './components/app/AppSurface';
import { useAppFoundation } from './components/app/appWiring/useAppFoundation';
import { useAppAudioOutput } from './components/app/appWiring/useAppAudioOutput';
import { useAppThemeAndNavigation } from './components/app/appWiring/useAppThemeAndNavigation';
import { useAppAccountsAndStage } from './components/app/appWiring/useAppAccountsAndStage';
import { useAppLibraryControllers } from './components/app/appWiring/useAppLibraryControllers';
import { useAppPlaybackQueue } from './components/app/appWiring/useAppPlaybackQueue';
import { useAppPlaybackBridges } from './components/app/appWiring/useAppPlaybackBridges';
import { useAppChromeAndGestures } from './components/app/appWiring/useAppChromeAndGestures';
import { useAppPublishers } from './components/app/appWiring/useAppPublishers';
import { useAppCommandPalette } from './components/app/appWiring/useAppCommandPalette';
import { useAppPlaybackActions } from './components/app/appWiring/useAppPlaybackActions';
import { useAppWallAndHome } from './components/app/appWiring/useAppWallAndHome';
import { useAppPlayerPanel } from './components/app/appWiring/useAppPlayerPanel';
import { useAppOverlayModels } from './components/app/appWiring/useAppOverlayModels';

// src/App.tsx
// 应用入口：把接线 hook 依次接上，每一步把上一步的模型交出去，最后交给 AppSurface 画。
export default function App() {
    countRender('App');
    const appFoundation = useAppFoundation();
    const appAudioOutput = useAppAudioOutput(appFoundation);
    const appThemeAndNavigation = useAppThemeAndNavigation(appAudioOutput);
    const appAccountsAndStage = useAppAccountsAndStage(appThemeAndNavigation);
    const appLibraryControllers = useAppLibraryControllers(appAccountsAndStage);
    const appPlaybackQueue = useAppPlaybackQueue(appLibraryControllers);
    const appPlaybackBridges = useAppPlaybackBridges(appPlaybackQueue);
    const appChromeAndGestures = useAppChromeAndGestures(appPlaybackBridges);
    const appPublishers = useAppPublishers(appChromeAndGestures);
    const appCommandPalette = useAppCommandPalette(appPublishers);
    const appPlaybackActions = useAppPlaybackActions(appCommandPalette);
    const appWallAndHome = useAppWallAndHome(appPlaybackActions);
    const appPlayerPanel = useAppPlayerPanel(appWallAndHome);
    const appOverlayModels = useAppOverlayModels(appPlayerPanel);

    return <AppSurface model={appOverlayModels} />;
}
