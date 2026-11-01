import { useEffect } from 'react';
import { buildStagePolicy, buildStageSystemPrompt, buildStageSourcePrompt } from '../services/aiStage';
import { configureBackgroundTheme } from '../services/backgroundThemeBridge';
import { readDirectorSettings, subscribeDirectorState } from '../services/lyricDirector/state';
import { readFoliaCloudSettings, subscribeFoliaCloudSettings } from '../services/foliaCloud';
import { listDirectorModes, isBlockedDirectorMode } from '../services/lyricDirector/catalog';
import i18n from '../i18n/config';
import { useThemeSettingsStore } from '../stores/useThemeSettingsStore';

// 前台只同步原生后台任务所需的提示模板与策略；后台切歌由服务直接启动，不等待React事件。
export const useBackgroundThemeConfig = (enabled: boolean): void => {
    useEffect(() => {
        const push = () => {
            const settings = readDirectorSettings();
            const cloud = readFoliaCloudSettings();
            const hint = settings.userHint;
            const blocked = settings.blockedModes;
            void configureBackgroundTheme({
                enabled,
                cloudEnabled: cloud.enabled,
                cloudBaseUrl: cloud.baseUrl,
                system: buildStageSystemPrompt(hint),
                promptTemplate: buildStageSourcePrompt({
                    snippet: '{{FOLIA_LYRICS}}', isPureMusic: false,
                    songTitle: '{{FOLIA_TITLE}}',
                    song: { title: '{{FOLIA_TITLE}}', artist: '{{FOLIA_ARTIST}}', album: null },
                    lines: [{ fullText: '{{FOLIA_LYRICS}}', translation: '', songPart: '', isChorus: false }],
                    modes: listDirectorModes(key => i18n.t(key)).filter(mode => !isBlockedDirectorMode(mode.id, blocked)),
                    currentMode: '', hint, recentModes: [], blockedModes: blocked,
                }),
                policy: buildStagePolicy({ hint, blocked }),
                daylight: useThemeSettingsStore.getState().isDaylight,
            });
        };
        const removeDirector = subscribeDirectorState(push);
        const removeCloud = subscribeFoliaCloudSettings(push);
        const removeTheme = useThemeSettingsStore.subscribe((state, previous) => {
            if (state.isDaylight !== previous.isDaylight) push();
        });
        push();
        return () => { removeDirector(); removeCloud(); removeTheme(); };
    }, [enabled]);
};
