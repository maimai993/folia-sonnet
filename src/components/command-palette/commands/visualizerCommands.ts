import { defineCommand } from '../commandFactories';
import { backgroundPickerSurface, visualizerPickerSurface } from '../surfaces/pickerSurface';
import { LayoutGrid, Wallpaper } from 'lucide-react';
import type { CommandPaletteCommand } from '../types';
import { createToggleCommand, createVisualizerCommand } from '../commandFactories';

// src/components/command-palette/commands/visualizerCommands.ts
// Commands in the `visualizer` group: switching lyric animation modes and background layouts.

export const visualizerCommands: CommandPaletteCommand[] = [
    defineCommand({
        id: 'visualizer-picker',
        executeShortcut: 'm',
        group: 'visualizer',
        title: 'Pick a visualizer',
        description: 'Browse lyric animation modes and click one to switch',
        keywords: ['visualizer picker', 'pick visualizer', 'browse visualizers', '可视化选择器', '选择可视化', '歌词动画选择', 'keshihuaxuanzeqi', 'xuanzekeshihua', 'kshxzq', 'xzksh'],
        icon: LayoutGrid,
        requiresInput: true,
        surface: visualizerPickerSurface,
        placeholder: context => context.shared.t('commandPalette.pickerFilterPlaceholder', 'Type to filter, then click or press Enter'),
        execute: () => false,
    }),
    defineCommand({
        id: 'background-picker',
        executeShortcut: 'g',
        group: 'visualizer',
        title: 'Pick a background',
        description: 'Browse background layouts and click one to switch',
        keywords: ['background picker', 'pick background', 'browse backgrounds', '背景选择器', '选择背景', 'beijingxuanzeqi', 'xuanzebeijing', 'bjxzq', 'xzbj'],
        icon: Wallpaper,
        requiresInput: true,
        surface: backgroundPickerSurface,
        placeholder: context => context.shared.t('commandPalette.pickerFilterPlaceholder', 'Type to filter, then click or press Enter'),
        execute: () => false,
    }),
    createVisualizerCommand('sonnet', 'Visualizer: Sonnet', 'Switch to Sonnet visualizer', ['visualizer sonnet', 'sonnet', '商籁', 'shanglai', 'sl', '文字 pv', 'mg pv', 'vocaloid']),
    createVisualizerCommand('tempera', 'Visualizer: Tempera', 'Switch to Tempera visualizer', ['visualizer tempera', 'tempera', '凝彩', 'dancai', 'dc', '色块 pv', 'block pv']),
    createVisualizerCommand('classic', 'Visualizer: Luminous', 'Switch to classic visualizer', ['visualizer classic', 'classic', '流光', 'liuguang', 'lg']),
    createVisualizerCommand('cadenza', 'Visualizer: Mindscape', 'Switch to cadenza visualizer', ['visualizer cadenza', 'cadenza', 'mindscape', '心象', 'xinxiang', 'xx']),
    createVisualizerCommand('partita', 'Visualizer: Partita', 'Switch to partita visualizer', ['visualizer partita', 'partita', '云阶', 'yunjie', 'yj']),
    createVisualizerCommand('fume', 'Visualizer: Fume', 'Switch to fume visualizer', ['visualizer fume', 'fume', '浮名', 'fuming', 'fm']),
    createVisualizerCommand('tilt', 'Visualizer: Tilt', 'Switch to tilt visualizer', ['visualizer tilt', 'tilt', '倾诉', 'qingsu', 'qs']),
    createVisualizerCommand('claddagh', 'Visualizer: Claddagh', 'Switch to Claddagh visualizer', ['visualizer claddagh', 'claddagh', '回环', 'huihuan', 'hh']),
    createVisualizerCommand('monet', 'Visualizer: Monet', 'Switch to Monet visualizer', ['visualizer monet', 'monet', '莫奈', 'monai', 'mn', '切换到可视化：莫奈', '切换到可视化莫奈']),
    createVisualizerCommand('pendolo', 'Visualizer: Pendolo', 'Switch to Pendolo visualizer', ['visualizer pendolo', 'pendolo', '擒纵', '摆轮', 'qinzong', 'bailun', 'pd', '切换到可视化：擒纵', '切换到可视化擒纵']),
    createVisualizerCommand('cappella', 'Visualizer: Cappella', 'Switch to cappella visualizer', ['visualizer cappella', 'cappella', '群唱', 'qunchang', 'qc']),
    createVisualizerCommand('diorama', 'Visualizer: Diorama', 'Switch to Diorama visualizer', ['visualizer diorama', 'diorama', '镜台', 'jingtai', 'jt', '切换到可视化：镜台', '切换到可视化镜台']),
    createVisualizerCommand('still', 'Visualizer: Still', 'Switch to the static low-resource visualizer', ['visualizer still', 'still', 'static', 'low resource', '静止', '静态', '低占用', 'jingzhi', 'jingtai', 'jz']),
    createToggleCommand('visualizer-toggle-random-per-song', 'visualizer', 'Random visualizer for every song', 'Toggle a random lyric animation mode whenever the song changes', ['random visualizer', 'random animation', 'per song', '随机歌词动画', '每首歌随机动画', 'suiji geci donghua', 'meishouge suiji donghua', 'sjgcdh', 'msgsjdh'], context => context.visualizer.toggleRandomVisualizerModePerSong()),
    {
        id: 'background-monet-full-overlay',
        group: 'visualizer',
        title: 'Background: Monet Full Screen Overlay',
        description: 'Switch background to Monet full screen overlay layout',
        keywords: ['monet full screen', 'monet full', 'overlay', '莫奈全屏叠色', '全屏叠色', '莫奈', 'mnqpds', 'qpds', '背景切换到 莫奈: 全屏叠色', '背景切换到莫奈全屏叠色'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('monet');
            context.visualizer.setMonetBackgroundTuning({ backgroundLayout: 'full-overlay' });
            return true;
        },
    },
    {
        id: 'background-monet-half-gradient',
        group: 'visualizer',
        title: 'Background: Monet Half Screen Gradient',
        description: 'Switch background to Monet half screen gradient layout',
        keywords: ['monet half screen', 'monet half', 'gradient', '莫奈半屏渐变', '半屏渐变', '莫奈', 'mnbpjb', 'bpjb', '背景切换到 莫奈: 半屏渐变', '背景切换到莫奈半屏渐变'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('monet');
            context.visualizer.setMonetBackgroundTuning({ backgroundLayout: 'half-pane-gradient' });
            return true;
        },
    },
    {
        id: 'background-common',
        group: 'visualizer',
        title: 'Background: Common',
        description: 'Switch background to general layout',
        keywords: ['background common', 'background general', 'common', 'general', '通用背景', 'tybj', 'ty', '背景切换到 通用', '背景切换到通用'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('common');
            return true;
        },
    },
    {
        id: 'background-nomand',
        group: 'visualizer',
        title: 'Background: Nomand',
        description: 'Switch background to theme-colored image dithering',
        keywords: ['nomand', 'dithering', 'dither', 'shader background', '漫游', '像素画', '像素画背景', '抖动背景', '网点背景', '主题色背景', 'man you', 'xiang su hua', 'dou dong bei jing', 'wang dian bei jing', 'my', 'xsh', 'ddbj', 'wdbj'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('nomand');
            return true;
        },
    },
    {
        id: 'background-latent',
        group: 'visualizer',
        title: 'Background: Latent',
        description: 'Switch background to cover-colored audio-reactive shaders',
        keywords: ['latent', 'latent background', 'shader background', '隐现', '隐现背景', '音频响应背景', 'yin xian', 'yinxian', 'yxbj'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('latent');
            return true;
        },
    },
    {
        id: 'background-latent-dithering',
        group: 'visualizer',
        title: 'Latent: Pixel',
        description: 'Show only the Dithering layer in Latent background',
        keywords: ['latent pixel', 'latent dithering', '隐现像素', '像素层', 'yinxian xiangsu', 'yxxs'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('latent');
            context.visualizer.setLatentBackgroundTuning({ displayMode: 'dithering' });
            return true;
        },
    },
    {
        id: 'background-latent-mesh',
        group: 'visualizer',
        title: 'Latent: Fluid',
        description: 'Show only the MeshGradient layer in Latent background',
        keywords: ['latent fluid', 'latent mesh', 'mesh gradient', '隐现流体', '流体层', 'yinxian liuti', 'yxlt'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('latent');
            context.visualizer.setLatentBackgroundTuning({ displayMode: 'mesh' });
            return true;
        },
    },
    {
        id: 'background-latent-both',
        group: 'visualizer',
        title: 'Latent: Mixed',
        description: 'Show both shader layers in Latent background',
        keywords: ['latent mixed', 'latent both', '隐现混合', '双层背景', 'yinxian hunhe', 'yxhh'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('latent');
            context.visualizer.setLatentBackgroundTuning({ displayMode: 'both' });
            return true;
        },
    },
    {
        id: 'background-url',
        group: 'visualizer',
        title: 'Background: Embedded Background',
        description: 'Switch background to embedded webpage mode',
        keywords: ['embedded background', 'embed background', 'background embed', 'background url', 'url background', 'url', 'webpage', '嵌入背景', '网页背景', 'qianrubeijing', 'qrbj', 'wybj', '背景切换到 嵌入背景', '背景切换到嵌入背景'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('url');
            return true;
        },
    },
    {
        id: 'background-sora',
        group: 'visualizer',
        title: 'Background: Sora',
        description: 'Switch background to Sora (starry sky) layout',
        keywords: ['sora', 'background sora', 'starry sky', 'star', '星空', '空', 'kong', 'xingkong', 'xk', '背景切换到 空', '背景切换到空', '背景切换到Sora', '背景切换到星空'],
        execute: (_input, context) => {
            context.visualizer.setVisualizerBackgroundMode('sora');
            return true;
        },
    }
];
