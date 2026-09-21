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
        'help-page',
        'settings-page',
    ] as const)('%s 有自己的页面轮廓', kind => {
        const markup = renderSurface(kind);
        expect(markup).toContain(`data-ponder-surface-kind="${kind}"`);
        expect(markup).not.toContain('data-ponder-palette-header');
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

    it('GridView surface 使用蜂窝卡片，并包含信息与筛选结果', () => {
        const markup = renderSurface('grid-view-page');
        expect(markup).toContain('data-ponder-grid-view-page-structure');
        expect(markup).toContain('data-ponder-grid-view-cards');
        ['card-focused', 'info-open', 'filter-open'].forEach(state => {
            expect(markup).toContain(`data-ponder-surface-state="${state}"`);
        });
    });
});
