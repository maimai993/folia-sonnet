// dev/build/rhineThemeAssets.mjs
// 把仓库根的 `res/` 目录原样搬进构建产物。
//
// 为什么需要：`res/rhine-theme/` 是「莱茵生命」主题的静态代码（上游 RhinE 的 js/、columns/，
// 加上我们写的壳），由 `RhineHome` 用 iframe 指向 `./res/rhine-theme/index.html` 打开。
// Vite 只把 `public/` 原样复制进 outDir，`res/` 不在其中 —— 不搬的话开发时能看见（dev server
// 直接读磁盘），打包后这个目录根本不存在，主题页白屏。这个插件补上那一步，两边路径一致。
//
// 只复制文件、不做任何转换：主题那边的 js 是按浏览器直接执行写的，不该过我们的打包管线。

import { cpSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @param {{ dir?: string }} [options] `dir` 是相对仓库根的源目录，默认 `res`。
 */
export function rhineThemeAssetsPlugin({ dir = 'res' } = {}) {
    let root = process.cwd();
    let outDir = 'dist';

    return {
        name: 'folia:rhine-theme-assets',
        apply: 'build',
        configResolved(config) {
            root = config.root;
            outDir = config.build.outDir;
        },
        closeBundle() {
            const from = resolve(root, dir);
            if (!existsSync(from) || !statSync(from).isDirectory()) return;
            const to = resolve(root, outDir, dir);
            cpSync(from, to, { recursive: true });
        },
    };
}
