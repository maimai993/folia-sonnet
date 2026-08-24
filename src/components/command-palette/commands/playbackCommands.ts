import { PlayerState } from '../../../types';
import { ListX, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { executeModeCommand } from './executeModeCommand';
import { queueCommand } from './queueCommand';
import { volumeCommand } from './volumeCommand';
import { fmModeCommand } from './fmModeCommand';
import type { CommandPaletteCommand } from '../types';
import { createToggleCommand, createReplayGainCommand, createSoundPresetCommand } from '../commandFactories';

// src/components/command-palette/commands/playbackCommands.ts
// Commands in the `playback` group: transport, queue, volume, Personal FM mode, ReplayGain, and
// sound presets.

export const playbackCommands: CommandPaletteCommand[] = [
    executeModeCommand,
    queueCommand,
    volumeCommand,
    fmModeCommand,
    createReplayGainCommand('off', 'Disable ReplayGain', 'Play audio without ReplayGain adjustment', ['replaygain off', 'disable replaygain', 'audio gain off', '关闭音频增益', '关闭 replaygain', 'guanbiyinpinzengyi', 'gbyyzy']),
    createReplayGainCommand('track', 'ReplayGain: Track mode', 'Apply per-track ReplayGain adjustment', ['replaygain track', 'track gain', 'single track gain', '单曲增益', '单曲 replaygain', 'danquzengyi', 'dqzy']),
    createReplayGainCommand('album', 'ReplayGain: Album mode', 'Apply album ReplayGain adjustment', ['replaygain album', 'album gain', '专辑增益', '专辑 replaygain', 'zhuanjizengyi', 'zjzy']),
    {
        id: 'playback-equalizer',
        executeShortcut: 'e',
        group: 'playback',
        title: 'Audio effects',
        description: 'Open the equalizer and effect chain',
        keywords: ['equalizer', 'audio equalizer', 'eq', '10 band eq', 'audio effects', 'effect chain', '均衡器', '音频均衡器', '十段均衡器', '音效', '效果器', 'junhengqi', 'yinpinjunhengqi', 'yinxiao', 'xiaoguoqi', 'jhh', 'ypjhh', 'yx', 'xgq'],
        execute: (_input, context) => {
            context.panel.setPanelTab('controls');
            context.panel.setIsPanelOpen(true);
            context.playback.openAudioEqualizer();
            return true;
        },
    },
    createSoundPresetCommand('flat', 'Sound: Level', 'Clear the equalizer and every effect', ['flat', 'reset audio effects', '水平', '关闭音效', 'shuiping', 'guanbiyinxiao', 'sp', 'gbyx']),
    createSoundPresetCommand('lofi', 'Sound: Lo-Fi', 'Filtered, crushed and wobbly with vinyl noise', ['lofi', 'lo-fi', 'low fidelity', '低保真', 'dibaozhen', 'dbz']),
    createSoundPresetCommand('radio', 'Sound: Radio', 'Narrow band, nearly mono broadcast tone', ['radio', 'am radio', 'telephone', '收音机', '广播', 'shouyinji', 'guangbo', 'syj', 'gb']),
    createSoundPresetCommand('hall', 'Sound: Hall', 'Wide stereo image with reverb space', ['hall', 'reverb', 'space', '大厅', '混响', '空间', 'daating', 'hunxiang', 'dt', 'hx']),
    createSoundPresetCommand('vocal', 'Sound: Vocal', 'Lift the voice range and tighten dynamics', ['vocal', 'voice', '人声', 'rensheng', 'rs']),
    createSoundPresetCommand('bass', 'Sound: Bass boost', 'Heavier low end with extra punch', ['bass boost', 'bass', '低音增强', '重低音', 'diyinzengqiang', 'zhongdiyin', 'dyzq', 'zdy']),
    createSoundPresetCommand('custom1', 'Sound: Custom 1', 'Apply the first saved custom sound', ['custom 1', 'custom sound 1', '自定义 1', '自定义音效1', 'zidingyi1', 'zdy1']),
    createSoundPresetCommand('custom2', 'Sound: Custom 2', 'Apply the second saved custom sound', ['custom 2', 'custom sound 2', '自定义 2', '自定义音效2', 'zidingyi2', 'zdy2']),
    {
        id: 'playback-play',
        group: 'playback',
        title: 'Play',
        description: 'Start playback when paused',
        keywords: ['play', '播放', 'bofang', 'bf'],
        icon: Play,
        execute: (_input, context) => {
            if (context.shared.playerState !== PlayerState.PLAYING) {
                context.playback.togglePlay();
            }
            return true;
        },
    },
    {
        id: 'playback-pause',
        group: 'playback',
        title: 'Pause',
        description: 'Pause current playback',
        keywords: ['pause', '暂停', 'zanting', 'zt'],
        icon: Pause,
        execute: (_input, context) => {
            if (context.shared.playerState === PlayerState.PLAYING) {
                context.playback.togglePlay();
            }
            return true;
        },
    },
    createToggleCommand('playback-next', 'playback', 'Next track', 'Play the next track', ['next', '下一首', 'xiayishou', 'xys'], context => context.playback.next(), { icon: SkipForward, executeShortcut: 'n' }),
    createToggleCommand('playback-prev', 'playback', 'Previous track', 'Play the previous track', ['prev', 'previous', '上一首', 'shangyishou', 'sys'], context => context.playback.prev(), { icon: SkipBack, executeShortcut: 'b' }),
    createToggleCommand('playback-loop', 'playback', 'Toggle loop', 'Change loop mode', ['loop', '循环', 'xunhuan', 'xh'], context => context.playback.toggleLoop(), { icon: Repeat, executeShortcut: 'l' }),
    createToggleCommand('playback-shuffle', 'playback', 'Shuffle queue', 'Shuffle current play queue', ['shuffle queue', 'shuffle', '打乱', '打乱队列', 'daluan', 'daluanduilie', 'dl'], context => context.playback.shuffleQueue(), { icon: Shuffle, executeShortcut: 'r', isAvailable: context => !context?.playback.isFmMode }),
    {
        id: 'playback-clear-queue',
        isAvailable: context => (context ? !context.playback.isFmMode && context.playback.queue.length > 0 : true),
        group: 'playback',
        title: 'Clear queue',
        description: 'Remove all songs from the current play queue',
        keywords: ['clear queue', 'empty queue', 'clear playlist', 'remove all songs', '清空队列', '清空播放队列', '清除队列', 'qingkongduilie', 'qingkongbofangduilie', 'qingchuduilie', 'qkdl', 'qcdl'],
        icon: ListX,
        execute: (_input, context) => {
            if (context.playback.queue.length === 0) {
                return false;
            }
            context.playback.clearQueue();
            return true;
        },
    },
    {
        id: 'playback-auto-match-best-lyric',
        executeShortcut: 'a',
        group: 'playback',
        title: 'Match best lyrics',
        description: 'Run automatic best lyric matching for the current song',
        keywords: ['best lyrics', 'match best lyrics', 'auto match lyrics', '最佳歌词', '匹配最佳歌词', '自动匹配歌词', 'zuijiageci', 'pipeizuijiageci', 'zidongpipeigeci', 'zjgc', 'ppzjgc', 'zdppgc'],
        execute: (_input, context) => context.playback.runAutoMatchBestLyric(),
    }
];
