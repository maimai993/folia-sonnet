import { ONBOARDING_ILLUSTRATION } from './ponderOnboardingShared';
import type { PonderSceneScript, PonderTargetDefinition } from '../../../types/ponder';

// src/components/ponder/targets/helpPage.target.ts
// Folia 的总览。第一次打开应用时那道门指向它，思索导航页上按 Ctrl+G 也是它。
//
// **只有一章，而且刻意短。**
//
// 它原本是六章，把思索怎么用、媒体键、四个快捷键、文档、关提示全塞在一条线上。
// 问题不在长度本身，在于位置：一个刚打开应用的人要的是「这东西大致怎么转」，
// 而不是连着看六章才知道自己想问的那一条在第几章。
//
// 所以细节全部搬走，各自成了导航页上的一条（ponder-basics / folia-transport /
// folia-shortcuts / folia-desktop）。这里只回答一个问题：接下来该往哪看。

/**
 * 唯一的一章：Folia 大致怎么转，以及往哪看下一步。
 *
 * 用那张讲思索本身的示意图，因为这一章的落点就是「用思索去问」——
 * 说完这一段，读者要做的动作正是对着组件长按 G，或者回到导航页挑一条。
 */
const overview: PonderSceneScript = {
    id: 'help-page-overview',
    titleKey: 'ponder.scenes.helpPageOverview',
    action: {
        kind: 'openUrl',
        url: 'https://folia-site.cielaniska.top/guide/',
        labelKey: 'ponder.actions.openDocs',
    },
    anchors: ONBOARDING_ILLUSTRATION,
    steps: [
        { kind: 'highlight', id: 'showPage', anchor: 'page', intensity: [0, 0.35], durationMs: 520, keyframe: true },
        {
            kind: 'caption', id: 'shape', at: 'bottom',
            textKey: 'ponder.captions.onboarding.overviewShape',
            pointTo: { anchor: 'page', y: 0.15 }, durationMs: 6400, withPrevious: true,
        },
        { kind: 'pause', id: 'readShape' },

        { kind: 'highlight', id: 'dimPage', anchor: 'page', intensity: [0.35, 0], durationMs: 400, keyframe: true },
        { kind: 'cursor', id: 'hoverComponent', to: { anchor: 'component' }, durationMs: 760, withPrevious: true },
        { kind: 'surfaceState', id: 'showHint', anchor: 'page', state: 'hint-shown', durationMs: 420 },
        {
            kind: 'caption', id: 'ask', at: 'bottom',
            textKey: 'ponder.captions.onboarding.overviewAsk',
            pointTo: { anchor: 'capsule' }, durationMs: 6600, withPrevious: true,
        },
        { kind: 'pause', id: 'readAsk' },

        {
            kind: 'caption', id: 'next', at: 'bottom',
            textKey: 'ponder.captions.onboarding.overviewNext',
            pointTo: { anchor: 'page', y: 0.85 }, durationMs: 6400, keyframe: true,
        },
        { kind: 'pause', id: 'readNext' },
    ],
};

export default {
    id: 'help-page',
    titleKey: 'ponder.targets.helpPage',
    category: 'basics',
    summaryKey: 'ponder.summaries.help_page',
    hoverSelector: null,
    scenes: [overview],
} satisfies PonderTargetDefinition;
