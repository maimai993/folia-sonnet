/*
 * canvas.php 的边界：字数上限、宽度、长文本会不会被截断。
 *
 * 用户要求做预览（用它的字符映射表）。列表里一张卡片不大，
 * 得知道能塞多少字才不会挤成一团。
 *
 * 跑法：node tools/probe-canvas-limits.mjs
 */
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const fontFile = '41569-0eb5046846c738e9eb6f95120c2ab057.ttf';
const previewer = 'https://previewer.fonts.net.cn/canvas.php';

/** 读 JPEG 的宽高。 */
const jpegSize = (buffer) => {
    let at = 2;
    while (at < buffer.length) {
        if (buffer[at] !== 0xff) { at += 1; continue; }
        const marker = buffer[at + 1];
        const length = buffer.readUInt16BE(at + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
        }
        at += 2 + length;
    }
    return null;
};

const samples = [
    '永',
    '字体',
    '永风起时',
    '永风起时花落无声',
    '永风起时花落无声，云归处山青水秀。',
    'The quick brown fox',
    'AaBbCcDdEeFfGg 0123456789',
    '永风起时花落无声永风起时花落无声永风起时花落无声永风起时花落无声',
];

for (const text of samples) {
    const url = `${previewer}?font=${encodeURIComponent(fontFile)}&text=${encodeURIComponent(text)}`;
    const response = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.fonts.net.cn/' } });
    const buffer = Buffer.from(await response.arrayBuffer());
    const size = jpegSize(buffer);
    const blank = buffer.length <= 1600;
    console.log(`${String([...text].length).padStart(3)} 字  ${String(buffer.length).padStart(6)} 字节  ${size ? `${size.width}x${size.height}` : '尺寸?'}  ${blank ? '【疑似空白】' : ''}  ${text.slice(0, 20)}`);
    if (text === '永风起时花落无声') writeFileSync('tools/_preview_10.jpg', buffer);
    if (text === '永风起时花落无声，云归处山青水秀。') writeFileSync('tools/_preview_20.jpg', buffer);
}
