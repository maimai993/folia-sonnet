// test/manual/rhinePatchSyntax.cjs
//
// 快速语法与接线自检：补丁脚本能被解析、关键入口都在。
// 跑：node test/manual/rhinePatchSyntax.cjs
const fs = require('fs');

const source = fs.readFileSync('public/rhinelab/folia-rhine-patch.js', 'utf8');
try {
    new Function(source);
    console.log('语法 OK');
} catch (error) {
    console.log('语法错误:', error.message);
    process.exit(1);
}

const checks = [
    ['bootGraceMs', '开屏宽限期'],
    ['inBootGrace', '宽限期判定'],
    ['installSelectingAnimations', 'SELECTING 动画'],
    ['SELECTING FILES...', '打字目标串'],
    ['__FOLIA_RHINE_SET__', '策略入口'],
    ['maxPixelRatio', 'DPR 上限'],
];
let bad = 0;
for (const [needle, label] of checks) {
    const hit = source.includes(needle);
    console.log(`${hit ? '✓' : '✗'} ${label} (${needle})`);
    if (!hit) bad += 1;
}
process.exit(bad ? 1 : 0);
