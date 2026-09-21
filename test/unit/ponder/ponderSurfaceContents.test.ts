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
});
