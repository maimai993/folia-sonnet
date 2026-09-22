import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PonderSurfaceContents from '@/components/ponder/PonderSurfaceContents';
import type { PonderSurfaceKind } from '@/types/ponder';

// test/unit/ponder/ponderSurfaceContents.test.ts
// Each tutorial surface keeps the recognizable structure of the real UI it stands in for.

const renderSurface = (kind: PonderSurfaceKind) => renderToStaticMarkup(
    React.createElement(PonderSurfaceContents, {
        kind,
        accent: '#ff3366',
        line: 'rgba(255,255,255,0.1)',
        outline: 'rgba(255,255,255,0.2)',
    }),
);

describe('PonderSurfaceContents', () => {
    it('palette 有搜索栏', () => {
        const markup = renderSurface('palette');
        expect(markup).toContain('data-ponder-surface-kind="palette"');
        expect(markup).toContain('data-ponder-palette-header');
    });

    it('picker 有两个接近真实设置项的下拉框', () => {
        const markup = renderSurface('picker');
        expect(markup.match(/data-ponder-picker-field/g)).toHaveLength(2);
        expect(markup).not.toContain('data-ponder-palette-header');
    });

    it('queue 有命令面板栏和曲目行', () => {
        const markup = renderSurface('queue');
        expect(markup).toContain('data-ponder-palette-header');
        expect(markup.match(/data-ponder-queue-row/g)).toHaveLength(4);
    });

    it('volume 有命令面板栏和音量滑杆', () => {
        const markup = renderSurface('volume');
        expect(markup).toContain('data-ponder-palette-header');
        expect(markup).toContain('data-ponder-volume-track');
    });

    it.each([
        'grid-page',
        'grid-view-page',
        'player-page',
        'lattice-page',
        'settings-page',
    ] as const)('%s 有自己的页面轮廓', kind => {
        const markup = renderSurface(kind);
        expect(markup).toContain(`data-ponder-surface-kind="${kind}"`);
        expect(markup).not.toContain('data-ponder-palette-header');
    });

    it('入门教程画的是思索本身：一页界面、提示胶囊、触屏那颗灯泡', () => {
        const markup = renderSurface('ponder-onboarding');
        expect(markup).toContain('data-ponder-onboarding-structure');
        // 被指的那个组件、浮出来的胶囊、右下角的灯泡，三样缺一样这张图就讲不成。
        expect(markup).toContain('data-ponder-onboarding-card-c');
        expect(markup).toContain('data-ponder-onboarding-capsule');
        expect(markup).toContain('data-ponder-onboarding-touch-bulb');
        ['hint-shown', 'hint-holding', 'ponder-open'].forEach(state => {
            expect(markup).toContain(`data-ponder-surface-state="${state}"`);
        });
    });

    it('Grid3D surface 按真实页头、3D 轨道和操作结果分层', () => {
        const markup = renderSurface('grid-page');
        expect(markup).toContain('data-ponder-grid-page-structure');
        expect(markup).toContain('data-ponder-grid-tabs');
        expect(markup).toContain('data-ponder-grid-search');
        expect(markup).toContain('data-ponder-grid-shelf');
        expect(markup.match(/data-ponder-grid-card/g)).toHaveLength(5);
        ['tab-switched', 'collection-open', 'map-open', 'search-open', 'command-open'].forEach(state => {
            expect(markup).toContain(`data-ponder-surface-state="${state}"`);
        });
    });

    it('Lattice surface 是不规则海报墙，并包含展开、工具和灯光结果', () => {
        const markup = renderSurface('lattice-page');
        expect(markup).toContain('data-ponder-lattice-page-structure');
        expect(markup).toContain('data-ponder-lattice-wall');
        expect(markup.match(/data-ponder-lattice-poster/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
        ['wall-panned', 'poster-focused', 'poster-expanded', 'tools-open', 'lights-off', 'command-open'].forEach(state => {
            expect(markup).toContain(`data-ponder-surface-state="${state}"`);
        });
    });

    it('底部界面设置画的是滑杆加「在播放页拖动调整」，不是泛化的下拉框', () => {
        const markup = renderSurface('bottom-ui-settings');
        expect(markup).toContain('data-ponder-bottom-ui-settings');
        expect(markup).toContain('data-ponder-bottom-ui-offset-track');
        expect(markup).toContain('data-ponder-bottom-ui-reposition');
        expect(markup).not.toContain('data-ponder-picker-field');
    });

    it('底部控制条是完整尺寸的合成胶囊，播放键、标题、进度条和两个槽位都在', () => {
        const markup = renderSurface('player-bar');
        expect(markup).toContain('data-ponder-player-bar-structure');
        ['play', 'title', 'progress'].forEach(part => {
            expect(markup).toContain(`data-ponder-bar-${part}`);
        });
        // 槽位层、随机层、音量层各画一对，所以是 6 个；同一时刻只有一层是可见的。
        expect(markup.match(/data-ponder-bar-slot=/g)).toHaveLength(6);
        // 随机和音量不按槽位里此刻放着什么筛，两层都必须预渲染在场。
        ['title-hovered', 'slots-shuffle', 'slots-volume', 'collapsed'].forEach(state => {
            expect(markup).toContain(`data-ponder-surface-state="${state}"`);
        });
    });

    it('GridView surface 使用蜂窝卡片，并包含信息与筛选结果', () => {
        const markup = renderSurface('grid-view-page');
        expect(markup).toContain('data-ponder-grid-view-page-structure');
        expect(markup).toContain('data-ponder-grid-view-cards');
        ['card-focused', 'info-open', 'filter-open'].forEach(state => {
            expect(markup).toContain(`data-ponder-surface-state="${state}"`);
        });
    });
});
