import { useEffect } from 'react';
import { buildStagePolicy, buildStageSystemPrompt, buildStageSourcePrompt } from '../services/aiStage';
import {
    configureBackgroundTheme,
    isSameBackgroundThemeConfig,
    mergeBackgroundThemeConfig,
    readActiveBackgroundThemeConfig,
} from '../services/backgroundThemeBridge';
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
            const next = {
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
            };
            /*
             * 只推「变化了的配置」，算不出内容的字段不覆盖原生已知值。
             *
             * 为什么：原生那份主题结果的 identity 里有「设置指纹」（cloudEnabled /
             * cloudBaseUrl / system / promptTemplate）。回前台时这里会把配置按当前设置
             * 重算一遍，而 system / promptTemplate 是导演设置 + 模式目录 + i18n 现拼的 ——
             * 刚回来的那一拍读不到就拼出空串。空串落盘等于改配置：原生把已经算好、
             * 甚至已经画到叠层上的主题判成「旧配置下的答案」丢掉，这就是 issue #209 的
             * 「回到前台后叠层不换色」。
             *
             * 两条限制一起用：
             *  1. 合并时空白字段保留已下发的值（mergeBackgroundThemeConfig）；
             *  2. 合并结果与已下发的完全一致就不写盘（configureBackgroundTheme 里按签名跳过），
             *     重算一遍同样的东西不该产生任何副作用。
             */
            const previous = readActiveBackgroundThemeConfig();
            const merged = mergeBackgroundThemeConfig(previous, next);
            if (isSameBackgroundThemeConfig(previous, merged)) {
                console.log('[BackgroundTheme] 回前台重算的配置与已下发的一致，不重写原生配置（保住已算好的结果）');
                return;
            }
            void configureBackgroundTheme(merged);
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
