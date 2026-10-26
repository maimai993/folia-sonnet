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
    include: ['test/unit/**/*.test.ts'],
    /*
     * 单测的默认超时从 vitest 的 5 秒放宽到 20 秒。
     *
     * 5 秒是「一个用例该多快跑完」的判断，不是「这台机器最慢的一次要多久」：跑全量时
     * 一千多个测试文件并行、各自还要加载几千行的模块图，落在那 5 秒里的工作量跟单跑
     * 一个文件完全不是一回事。实际的失败长这样——同一个用例单跑 3 秒过，全量跑就
     * `Test timed out in 5000ms`，报的还是**随机某个**文件，谁的 CPU 被抢到了谁超时。
     *
     * 放宽不会盖住真的挂死：真挂死的是 20 秒也回不来，只是晚一点报。
     */
    testTimeout: 20_000,
    /*
     * 限制并发，别让一千多个文件把 8 核抢穿。
     *
     * vitest 默认按 CPU 数量开 worker，每个 worker 还要自己加载模块图 + jsdom。
     * 在真实开发机上这就是上面那些「单跑 3 秒、全量 20 秒都不够」的来源：不是用例变慢，
     * 是同一时刻有十几个进程在抢同一批核和同一块内存。留出余量之后，全量跑的总时长
     * 反而更短（少了互相把对方挤出超时的重试）。
     */
    maxWorkers: 4,
  }
});
