// src/services/onlineMusic/lxmusic/lxFingerprint.ts
// 音源脚本的指纹：sha256(脚本正文)。确认记录（lxScriptApproval.ts）与界面上的「指纹」都用它。
//
// 为什么单独一个文件：同时被「确认记录」和「导入预览」用到，两边必须算的是同一个东西；而且
// crypto.subtle 在非安全上下文里不存在（老 WebView 在 http 页面下），要有一层兜底，否则导入
// 音源会直接抛错。兜底实现只在没有 subtle 的少数环境用到，输出格式与 sha256 一致。

/** 正文的 UTF-8 字节算 sha256。 */
export const sha256Hex = async (text: string): Promise<string> => {
    const bytes = new TextEncoder().encode(text);
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        const digest = await subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return fallbackSha256Hex(bytes);
};

/** 短指纹：界面上只显示前后各 8 位，够用户核对「和上次不一样」这件事。 */
export const shortFingerprint = (digest: string): string => (
    digest.length <= 16 ? digest : `${digest.slice(0, 8)}…${digest.slice(-8)}`
);

/*
 * 下面是没有 crypto.subtle 时的 SHA-256。只在老 WebView 的 http 上下文里才会走到；
 * 实现按 FIPS 180-4 写，纯计算，不依赖任何库（worker / 主线程都能跑）。
 */
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const fallbackSha256Hex = (input: Uint8Array): string => {
    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const bitLength = BigInt(input.length) * 8n;
    const withPadding = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
    withPadding.set(input);
    withPadding[input.length] = 0x80;
    for (let i = 0; i < 8; i += 1) withPadding[withPadding.length - 8 + i] = Number((bitLength >> BigInt(8 * (7 - i))) & 0xffn);

    const w = new Uint32Array(64);
    const rotr = (value: number, shift: number): number => ((value >>> shift) | (value << (32 - shift))) >>> 0;
    for (let offset = 0; offset < withPadding.length; offset += 64) {
        for (let i = 0; i < 16; i += 1) {
            const p = offset + i * 4;
            w[i] = ((withPadding[p] << 24) | (withPadding[p + 1] << 16) | (withPadding[p + 2] << 8) | withPadding[p + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i += 1) {
            const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
            const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h[0];
        let b = h[1];
        let c = h[2];
        let d = h[3];
        let e = h[4];
        let f = h[5];
        let g = h[6];
        let hh = h[7];
        for (let i = 0; i < 64; i += 1) {
            const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const temp2 = (S0 + maj) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
        h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0;
        h[7] = (h[7] + hh) >>> 0;
    }
    return Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('');
};
