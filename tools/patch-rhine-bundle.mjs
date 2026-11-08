// tools/patch-rhine-bundle.mjs
//
// 给 RhineLabUI 的构建产物打两个叠层用的探针。
//
// 背景：Three.js 的 renderer / scene / 材质构造函数全是模块私有变量，没有全局
// THREE（`window.__THREE__` 只是个版本号字符串），外部完全拿不到场景。唯一稳定
// 的接缝是 bundle 里每一次 `this.render=function(M,B){...}` 赋值 —— 在它开头插
// 一行回调，就能每次绘制都拿到 scene 和 renderer。
//
// 探针二：`this.rotation` 是选中卡片的转动角度（±0.8 弧度），宿主那层 DOM 叠层
// 靠它跟着拖动平移。它也只在 bundle 内部，同样只能插一行镜像出来。
//
// 这个脚本是**幂等**的：重复跑不会叠加。每个锚点必须唯一，否则直接失败 ——
// 上游换构建时宁可报错，也不要在错误的行上插代码。
//
// 跑：node tools/patch-rhine-bundle.mjs [--check]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ASSET_DIR = 'public/rhinelab/assets';

/**
 * 每个探针：锚点原文、可读名、插入位置（'after-brace' 在 `{` 之后，'before' 在锚点之前）、
 * 以及插入的代码。插入代码必须自包含，且失败不能影响原逻辑。
 */
const PROBES = [
    {
        label: 'render 回调（拿 scene）',
        mark: '__FOLIA_OVERLAY_ON_RENDER__',
        anchor: 'this.render=function(M,B){',
        inject: 'this.render=function(M,B){try{window.__FOLIA_OVERLAY_ON_RENDER__&&window.__FOLIA_OVERLAY_ON_RENDER__(M,this)}catch(_foliaErr){console.warn("[rhine-overlay] render hook",_foliaErr)}',
    },
    {
        label: 'rotation 镜像（跟随拖动）',
        mark: '__FOLIA_OVERLAY_ON_ROTATION__',
        anchor: 'this.rotation=this.targetDetail?Ie.lerp(this.rotation,this.targetRotation,o):of(this.rotation,s,!this.motion.detailTransition);',
        inject: 'this.rotation=this.targetDetail?Ie.lerp(this.rotation,this.targetRotation,o):of(this.rotation,s,!this.motion.detailTransition);try{window.__FOLIA_OVERLAY_ON_ROTATION__&&window.__FOLIA_OVERLAY_ON_ROTATION__(this.rotation)}catch(_foliaErr){}',
    },
];

const checkOnly = process.argv.includes('--check');

/** 找出要处理的 bundle：名字形如 index-<hash>.js。 */
const bundles = readdirSync(ASSET_DIR).filter(name => /^index-[A-Za-z0-9_-]+\.js$/.test(name));
if (!bundles.length) {
    console.error(`在 ${ASSET_DIR} 里找不到 index-*.js`);
    process.exit(1);
}

let failed = 0;
for (const name of bundles) {
    const path = join(ASSET_DIR, name);
    let source = readFileSync(path, 'utf8');
    const before = source.length;
    let touched = 0;

    for (const probe of PROBES) {
        if (source.includes(probe.mark)) {
            console.log(`${name}: ${probe.label} 已打过，跳过`);
            continue;
        }
        const hits = source.split(probe.anchor).length - 1;
        if (hits !== 1) {
            console.error(`${name}: ${probe.label} 的锚点出现 ${hits} 次（需要恰好 1 次）—— 上游结构变了，先确认再改`);
            failed += 1;
            continue;
        }
        if (checkOnly) {
            console.log(`${name}: ${probe.label} 可以打`);
            continue;
        }
        source = source.replace(probe.anchor, probe.inject);
        touched += 1;
        console.log(`${name}: 已插入 ${probe.label}`);
    }

    if (!touched) continue;
    // 打完先做一次语法体检：这是构建产物，改坏了整个页面都起不来。
    try {
        new Function(source);
    } catch (error) {
        console.error(`${name}: 打补丁后语法不合法（${error.message}），已放弃写入`);
        failed += 1;
        continue;
    }
    writeFileSync(path, source, 'utf8');
    console.log(`${name}: 写入完成（${before} -> ${source.length} 字节）`);
}

process.exit(failed ? 1 : 0);
