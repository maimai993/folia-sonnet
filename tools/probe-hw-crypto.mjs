/*
 * 壁纸汇的参数加密 Re() 到底做什么？能不能在 App 里复现？
 *
 * 看 D6JdM6wX.js 里 Re 与 F（解密）的定义。
 * 如果是标准 AES + 固定 key，可以复现；如果是站点内生成的随机密钥，就不值得做。
 *
 * 跑法：node tools/probe-hw-crypto.mjs
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const text = await (await fetch('https://www.haowallpaper.com/_nuxt/D6JdM6wX.js', { headers: { 'User-Agent': UA } })).text();

// 该块的 import 语句，看加密函数从哪来
console.log('=== import 语句 ===');
const imports = [...text.matchAll(/import\{([^}]*)\}from"([^"]+)"/g)];
imports.forEach(([, names, from]) => console.log(`  from ${from}: ${names.slice(0, 200)}`));

// 找 Re 与 F 的赋值
console.log('\n=== 局部别名 ===');
for (const alias of ['Re', 'F', 'k', 'O']) {
    const pattern = new RegExp(`[,{;]\\s*${alias}\\s*=\\s*([A-Za-z0-9_$]+)`);
    const match = pattern.exec(text);
    if (match) console.log(`  ${alias} = ${match[1]}`);
}
