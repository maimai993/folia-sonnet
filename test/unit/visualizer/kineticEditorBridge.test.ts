import { afterEach, describe, expect, it, vi } from 'vitest';
import { kineticPlanMatchesLyrics } from '@/components/visualizer/kinetic/kineticEditorIdentity';
import { pushTimeToEditor, syncEditorTransport } from '@/components/visualizer/kinetic/kineticEditorBridge';

// 宿主播放状态只能改按钮，不能重启 JIZURA 的独立时钟。
afterEach(() => vi.restoreAllMocks());
describe('kinetic editor identity and clock', () => {
    it('matches the existing parseLyrics notation without admitting stale plan text', () => {
        const plan = { lines: [{ text: 'Alpha first' }, { text: '你好' }] };
        expect(kineticPlanMatchesLyrics(plan, '[00:01]*Alpha*/first! | note\n[00:12]你/好')).toBe(true);
        expect(kineticPlanMatchesLyrics(plan, '[00:01]Bravo')).toBe(false);
        expect(kineticPlanMatchesLyrics(null, '')).toBe(false);
    });
    it('does not schedule stale clock writes while plan is unready', () => {
        const seek = vi.fn();
        const target = { J: { ui: {}, uiApi: { seek } } } as unknown as Window;
        const timer = vi.spyOn(globalThis, 'setTimeout');
        pushTimeToEditor(target, 1);
        expect(seek).not.toHaveBeenCalled();
        expect(timer).not.toHaveBeenCalled();
        (target as any).J.ui.plan = {};
        pushTimeToEditor(target, 8);
        expect(seek).toHaveBeenCalledExactlyOnceWith(8);
    });
    it('keeps engine playback paused while displaying the host playing state', () => {
        const button = { textContent: '', setAttribute: vi.fn() };
        const ui = { playing: true };
        const pause = vi.fn(() => { ui.playing = false; });
        const target = { J: { ui, uiApi: { pause } }, document: { getElementById: () => button } } as unknown as Window;
        syncEditorTransport(target, true);
        expect(ui.playing).toBe(false);
        expect(button.textContent).toBe('❚❚');
        syncEditorTransport(target, false);
        expect(ui.playing).toBe(false);
        expect(button.textContent).toBe('▶');
    });
});
