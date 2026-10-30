import type { Theme } from '../../../types';
import { parseColorChannels } from '../../../utils/visualizer/colorMix';

// src/components/visualizer/nebbia/nebbiaPalette.ts
// 涓婚 鈫?绐楀鐨勫鏅厤鑹诧細澶╄壊涓ゆ。锛堜富棰樿儗鏅帇鎴愬閲岀殑娣辫壊锛夛紝涓変釜鐏厜鑹诧紙寮鸿皟鑹叉墦澶达紝鏄仛鍏夌伅鍜岄湏铏圭殑棰滆壊锛?// 鍙﹀涓や釜鍙栦富棰橀噷澶熼矞鑹崇殑棰滆壊锛屼笉澶熷氨鎶婂己璋冭壊杞壊鐩歌ˉ涓婏級銆傞兘鏄?0..1 鐨?RGB銆?
type Rgb = [number, number, number];
export interface NebbiaPalette { sky0: Rgb; sky1: Rgb; la: Rgb; lb: Rgb; lc: Rgb }

const rgbOf = (color: string | undefined, fallback: Rgb): Rgb => {
    const c = color ? parseColorChannels(color) : null;
    return c ? [c.r / 255, c.g / 255, c.b / 255] : fallback;
};

const toHsl = ([r, g, b]: Rgb): Rgb => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d === 0) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
};
const fromHsl = ([h, s, l]: Rgb): Rgb => {
    const k = (n: number) => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)];
};

// 鐏浜€佽鏈夐鑹诧細楗卞拰搴﹀拰浜害閮芥姮鍒板鏅噷鐪嬪緱瑙佺殑鑼冨洿
const asLight = (rgb: Rgb): Rgb => {
    const [h, s, l] = toHsl(rgb);
    return fromHsl([h, Math.max(0.55, s), Math.min(0.78, Math.max(0.6, l))]);
};
const asSky = (rgb: Rgb, lightness: number): Rgb => {
    const [h, s] = toHsl(rgb);
    return fromHsl([h, Math.min(0.55, s), lightness]);
};

export const resolveNebbiaPalette = (theme: Theme): NebbiaPalette => {
    const accent = rgbOf(theme.accentColor, [1, 0.81, 0.54]);
    const bg = rgbOf(theme.backgroundColor, [0.04, 0.06, 0.09]);
    const vivid = [theme.secondaryColor, theme.primaryColor, ...(theme.wordColors ?? []).map(w => w.color)]
        .map(c => rgbOf(c, [0, 0, 0]))
        .filter(c => toHsl(c)[1] > 0.3 && toHsl(c)[2] > 0.25 && toHsl(c)[2] < 0.9);
    const [ah, as, al] = toHsl(accent);
    const lb = vivid[0] ?? fromHsl([(ah + 0.55) % 1, as, al]);
    const lc = vivid[1] ?? fromHsl([(ah + 0.9) % 1, as, al]);
    return {
        sky0: asSky(bg, 0.05),
        sky1: asSky(bg.map((v, i) => v * 0.7 + accent[i] * 0.3) as Rgb, 0.14),
        la: asLight(accent),
        lb: asLight(lb),
        lc: asLight(lc),
    };
};
