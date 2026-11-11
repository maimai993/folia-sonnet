import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WallpaperPayload } from '../../../src/entries/wallpaperSurfaceTypes';

// 钉住原生时间包的内容引用与时钟行为，避免相同主题触发可视化重建。

vi.mock('../../../src/services/phoneInsets', () => ({
    applyPushedPhoneInsets: vi.fn(),
}));

const makePayload = (): WallpaperPayload => ({
    positionMs: 1000,
    playing: true,
    title: '花火',
    artist: 'Folia',
    theme: {
        name: '花火',
        accentColor: '#ff8800',
        fontWeight: 500,
        fontFamilyStack: ['Folia', 'sans-serif'],
        wordColors: [{ word: '花火', color: '#ff0000' }],
        lyricsIcons: ['sparkles', 'star'],
    },
    lines: [
        {
            text: '看花火',
            start: 1000,
            end: 3000,
            translation: 'Watch fireworks',
            words: [
                { text: '看', start: 1000, end: 1500 },
                { text: '花火', start: 1500, end: 3000 },
            ],
        },
        { text: '亮起来', start: 3000, end: 5000 },
        { text: '落下来', start: 5000, end: 7000 },
    ],
});

let bridge: typeof import('../../../src/entries/wallpaperSurfaceBridge');
let now = 0;

beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    bridge = await import('../../../src/entries/wallpaperSurfaceBridge');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const push = (payload: WallpaperPayload) => {
    window.__foliaWallpaperPush!(payload);
    return bridge.getWallpaperSnapshot();
};

describe('wallpaperSurfaceBridge content references', () => {
    it('JSON 重建的相同内容沿用 theme/lines，整包及时间和订阅照常更新', () => {
        const previous = push(makePayload());
        const incoming: WallpaperPayload = JSON.parse(JSON.stringify(previous));
        incoming.positionMs = 4000;
        const notify = vi.fn();
        const unsubscribe = bridge.subscribeWallpaperPayload(notify);
        now = 3100;
        const next = push(incoming);

        expect(next).not.toBe(previous);
        expect(next.theme).toBe(previous.theme);
        expect(next.lines).toBe(previous.lines);
        expect(next.positionMs).toBe(4000);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(window.__foliaWallpaperLatest).toBe(next);
        expect(window.__foliaWallpaperPushCount).toBe(2);
        expect(window.__foliaWallpaperReceivedAt).toBe(3100);
        expect(incoming.theme).not.toBe(previous.theme);
        expect(incoming.lines).not.toBe(previous.lines);
        now = 3350;
        expect(bridge.positionMsNow()).toBe(4250);
        unsubscribe();
    });

    it('对象字段顺序不同不算主题或歌词变化', () => {
        const previous = push(makePayload());
        const incoming = makePayload();
        incoming.theme = Object.fromEntries(Object.entries(incoming.theme!).reverse());
        incoming.lines = incoming.lines!.map(line => ({
            words: line.words,
            translation: line.translation,
            end: line.end,
            start: line.start,
            text: line.text,
        }));
        // 省略的可选字段保持省略，不把 undefined 当成已传入的 JSON 字段。
        incoming.lines = JSON.parse(JSON.stringify(incoming.lines));
        const next = push(incoming);

        expect(next.theme).toBe(previous.theme);
        expect(next.lines).toBe(previous.lines);
    });

    it.each<[string, (payload: WallpaperPayload) => void]>([
        ['主题颜色', payload => { payload.theme!.accentColor = '#00ff00'; }],
        ['主题字体', payload => { payload.theme!.fontWeight = 700; }],
        ['字体栈顺序', payload => { payload.theme!.fontFamilyStack!.reverse(); }],
        ['关键词颜色', payload => { payload.theme!.wordColors![0]!.color = '#00ff00'; }],
        ['关键词内容', payload => { payload.theme!.wordColors![0]!.word = '星星'; }],
        ['图标内容', payload => { payload.theme!.lyricsIcons![1] = 'moon'; }],
        ['删除可选字段', payload => { delete payload.theme!.fontWeight; }],
        ['新增可选字段', payload => { payload.theme!.description = 'new'; }],
    ])('%s 真正改变时更新 theme，仍复用未变歌词', (_name, change) => {
        const previous = push(makePayload());
        const incoming = makePayload();
        change(incoming);
        const next = push(incoming);

        expect(next.theme).toBe(incoming.theme);
        expect(next.theme).not.toBe(previous.theme);
        expect(next.lines).toBe(previous.lines);
    });

    it.each<[string, (payload: WallpaperPayload) => void]>([
        ['中间行同字数文本', payload => { payload.lines![1]!.text = '飞起来'; }],
        ['行开始时间', payload => { payload.lines![1]!.start += 1; }],
        ['行结束时间', payload => { payload.lines![1]!.end += 1; }],
        ['翻译', payload => { payload.lines![0]!.translation = 'Fireworks'; }],
        ['逐字文本', payload => { payload.lines![0]!.words![0]!.text = '望'; }],
        ['逐字开始时间', payload => { payload.lines![0]!.words![1]!.start += 1; }],
        ['逐字结束时间', payload => { payload.lines![0]!.words![0]!.end += 1; }],
        ['逐字轴晚到', payload => { payload.lines![1]!.words = [{ text: '亮起来', start: 3100, end: 4900 }]; }],
        ['删除逐字轴', payload => { delete payload.lines![0]!.words; }],
        ['行数量', payload => { payload.lines!.push({ text: '尾声', start: 7000, end: 8000 }); }],
    ])('%s 真正改变时更新 lines，仍复用未变主题', (_name, change) => {
        const previous = push(makePayload());
        const incoming = makePayload();
        change(incoming);
        const next = push(incoming);

        expect(next.lines).toBe(incoming.lines);
        expect(next.lines).not.toBe(previous.lines);
        expect(next.theme).toBe(previous.theme);
    });

    it('缺字段的主题沿用与三秒空歌词兜底仍按原有窗口生效', () => {
        const previous = push(makePayload());
        now = 1000;
        push(makePayload());
        now = 3900;
        const held = push({ positionMs: 5000, playing: true });
        expect(held.lines).toBe(previous.lines);
        expect(held.theme).toBe(previous.theme);
        now = 4001;
        const expired = push({ positionMs: 5100, playing: true, lines: [] });
        expect(expired.lines).toEqual([]);
        expect(expired.lines).not.toBe(previous.lines);
        expect(expired.theme).toBe(previous.theme);
    });

    it('位置倒退、暂停与恢复仍接受原生锚点，不因内容相同而丢掉推送', () => {
        const previous = push(makePayload());
        now = 200;
        const paused = push({ ...makePayload(), positionMs: 200, playing: false, durationMs: 9000, firstIndex: 10 });
        expect(paused.lines).toBe(previous.lines);
        expect(paused.theme).toBe(previous.theme);
        expect(paused.firstIndex).toBe(10);
        expect(paused.durationMs).toBe(9000);
        now = 600;
        expect(bridge.positionMsNow()).toBe(200);
        push({ ...makePayload(), positionMs: 50, playing: true });
        now = 750;
        expect(bridge.positionMsNow()).toBe(200);
    });
});
