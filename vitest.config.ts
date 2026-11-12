import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import { commandPinyinPlugin } from './dev/pinyin/commandPinyinPlugin.mjs';
import { traditionalLocalePlugin } from './dev/i18n/traditionalLocalePlugin.mjs';
import { icuFoliaDataPlugin } from './dev/icuFolia/icuFoliaDataPlugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 命令面板的检索索引在单测里也要读到构建期生成的拼音字典。
  // 繁中 locale 由 zh-CN 在构建期转换生成，同样只以虚拟模块存在。
  // icu-folia 的 jieba 词典和 HMM 表同样以虚拟模块提供，单测走的是和正式构建同一条加载路径。
  plugins: [commandPinyinPlugin(), traditionalLocalePlugin(), icuFoliaDataPlugin()],
  // 单测默认按官方构建跑（vite.config 构建期注入的值）；非官方分支由各自的用例显式传入构建环境。
  define: {
    __BUILD_KIND__: JSON.stringify('official'),
    __BUILD_HOST__: JSON.stringify(''),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  test: {
    environment: 'node',
    // 第二消费者始终参与单测；test.env 与 vi.stubEnv 使用同一入口，可覆写验证关闭/生产边界。
    // 初始选择钉在 grid：现有用例都假设没选过 suite 的人看到网格（开发阶段的初始选择是 bravais）。
    env: { VITE_LIBRARY_TUI: 'true', VITE_LIBRARY_INITIAL_SUITE: 'grid' },
    include: ['test/unit/**/*.test.ts', 'packages/*/test/**/*.test.mjs'],
    // Node 25 起自带的 localStorage 占位会盖住 jsdom 的那份：jsdom 用例在这里统一补内存实现，node 用例删掉占位。
    setupFiles: ['test/unit/jsdomLocalStorage.ts'],
    /*
     * 默认 5 秒是给「逻辑跑多久」定的预算。有几个用例每个都要 `vi.resetModules()` 重走一遍
     * 整张模块图（导演 → omni → providerRegistry → 各平台 transport，v0.7.26 之后还要加上
     * appleMusic / fnmusic / hifi 几条链），冷启动那一次十几秒都算正常 —— 那是加载成本，
     * 不是断言变慢。放松到 20 秒只影响这类冷启动用例，逻辑挂住照样会超时。
     *
     * ★ 全量跑（test/unit 下 1287 个文件一起跑）时，20 秒不够。
     *
     * 有两类用例天生就慢：一类是「全树扫描」的架构边界测试（layerBoundaries、
     * omniArchitecture 之类，要遍历整个 src/ 并解析所有 import），单跑就要 5~15 秒；
     * 另一类是「整张命令注册表」的加载（libraryGridOnlySettings）。
     *
     * 它们单独跑都过，全量跑时被其余上千个文件抢走 CPU，就一个个超时 ——
     * 报错是 "Test timed out"，不是断言失败，看着像代码坏了，其实是机器忙。
     *
     * 所以超时按「跑多少」分级：
     *   · 单独跑一个文件（CI 里最常见的用法）→ 20 秒，逻辑挂住照样会超时；
     *   · 全量跑（FOLIA_TEST_FULL=1）→ 180 秒，够这些扫描型用例把源码树走完。
     *
     * 覆盖的是时间上限，断言一个字没动。
     */
    testTimeout: process.env.FOLIA_TEST_FULL ? 180_000 : 20_000,
    // hook 同理：icuFolia 的 beforeAll 要加载 wasm 并初始化，默认 10 秒在忙的时候也会挂。
    hookTimeout: process.env.FOLIA_TEST_FULL ? 120_000 : 20_000,
  }
});
