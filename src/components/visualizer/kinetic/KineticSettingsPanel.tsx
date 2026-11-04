import React from 'react';
import { Button } from '../../ui/Button';
import { type VisualizerSettingsPanelProps } from '../definition';
import { type KineticTuning } from './tuning';
import KineticEditorOverlay from './KineticEditorOverlay';
import { usePlaybackStore } from '../../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';
import { PlayerState } from '../../../types';
import type { Line } from '../../../types';

// src/components/visualizer/kinetic/KineticSettingsPanel.tsx
// 文字PV 的设置面板：一个「打开原版编辑台」按钮，点击直接全屏进入原版编辑台，不再包折叠组。
// 所有参数都在原版编辑台里调；歌词与歌曲键直接从播放仓库读（设置窗口不在播放 props 作用域里）。

const KineticSettingsPanel: React.FC<VisualizerSettingsPanelProps<KineticTuning>> = ({
    t,
    theme,
}) => {
    const [editorOpen, setEditorOpen] = React.useState(false);
    /*
     * 直接用 state.lyrics，不走 selectDisplayLyrics。
     *
     * selectDisplayLyrics 在切歌过渡期间返回 transitionDisplay.lyrics —— 那是**上一首**的词
     * （过渡动画要用它做新旧交叉淡入）。编辑台拿着它注入，就是
     * 「点进去歌词还是旧的那首」；点「随机生成」会覆盖掉，所以看起来像只有它能救。
     * 编辑台要的是当前这首歌的词，不受过渡动画影响。
     */
    const lyricData = usePlaybackStore(state => state.lyrics);
    const lyricLines = lyricData?.lines ?? [];
    const currentSong = usePlaybackStore(state => state.currentSong);
    // 这首歌的键：编辑台的改动按它存，换歌/重启还原。
    const songKey = React.useMemo(() => (currentSong ? getPlaybackSongKey(currentSong) : null), [currentSong]);
    /*
     * 说明：这里不做「歌词 title 与歌名」的归属校验。
     *
     * 之前试过：歌词数据里的 title 是歌词文件自带的标题标签，与播放器显示名
     * （可能是翻译名/别名）经常不相等，校验几乎恒为 false，inject 被全部拦掉，
     * 编辑台就一直显示原版自带的示例歌词（J.SAMPLE_LYRICS 的中文版）。
     *
     * 旧词问题的真正根源（过渡歌词 selector）已在上一行修掉：
     * 这里直接用 state.lyrics，不走 selectDisplayLyrics。
     */

    // 编辑台 ↔ 播放器联动。
    // 设置面板这一层拿不到播放器的 seek 与真实播放头（都在 App.tsx 的 ref 链里），
    // 所以这里只负责「收听」与「喊话」：进度由播放器主动广播，操作转成全局事件。
    const isPlaying = usePlaybackStore(state => state.playerState === PlayerState.PLAYING);
    const setVolume = useAudioSettingsStore(state => state.handleSetVolume);
    const [liveTime, setLiveTime] = React.useState(0);

    /** 播放器每 250ms 广播一次播放头，编辑台据此跟住进度（拖动条、当前句都对得上）。 */
    React.useEffect(() => {
        const onTick = (event: Event) => {
            const time = (event as CustomEvent<{ time?: number }>).detail?.time;
            if (typeof time === 'number' && Number.isFinite(time)) setLiveTime(time);
        };
        window.addEventListener('kinetic:time', onTick);
        return () => window.removeEventListener('kinetic:time', onTick);
    }, []);

    const handleSeek = React.useCallback((time: number) => {
        console.log('[Kinetic] 编辑台请求跳转', { time });
        window.dispatchEvent(new CustomEvent('kinetic:seek', { detail: { time } }));
    }, []);

    const handleTogglePlay = React.useCallback((shouldPlay: boolean) => {
        console.log('[Kinetic] 编辑台请求播放/暂停', { shouldPlay });
        window.dispatchEvent(new CustomEvent('kinetic:toggle-play', { detail: { playing: shouldPlay } }));
    }, []);

    const handleVolumeChange = React.useCallback((volume: number) => {
        console.log('[Kinetic] 编辑台调了音量', { volume });
        setVolume(volume);
    }, [setVolume]);

    const openEditor = () => {
        console.log('[Kinetic] 打开原版编辑台', { songKey });
        setEditorOpen(true);
    };
    const closeEditor = () => {
        console.log('[Kinetic] 退出原版编辑台');
        setEditorOpen(false);
    };

    React.useEffect(() => {
        const open = () => setEditorOpen(true);
        window.addEventListener('kinetic:open-editor', open);
        return () => window.removeEventListener('kinetic:open-editor', open);
    }, []);

    return (
        <>
            <div className="px-3 py-2">
                <Button variant="fill" size="sm" onClick={openEditor}>{t('options.kineticOpenEditorAction')}</Button>
            </div>
            {editorOpen && (
                <KineticEditorOverlay
                    /*
                     * 按歌曲键重挂载：切歌时整个编辑台连 iframe 一起重建。
                     *
                     * 比在内部补"重新注入"的 effect 可靠得多 —— 原版编辑台把歌词、plan、
                     * 时间轴都缓存在自己的状态里，靠外部改字段再 replan 容易残留上一首的数据
                     * （歌词不更新、时间轴串味都是这么来的）。重建一次，等于重新开局。
                     */
                    key={songKey ?? 'no-song'}
                    lines={lyricLines as Line[]}
                    lyricsReady={lyricData !== null}
                    theme={theme}
                    songKey={songKey}
                    currentTime={liveTime}
                    playing={isPlaying}
                    onSeek={handleSeek}
                    onTogglePlay={handleTogglePlay}
                    onVolumeChange={handleVolumeChange}
                    onClose={closeEditor}
                />
            )}
        </>
    );
};

export default KineticSettingsPanel;
