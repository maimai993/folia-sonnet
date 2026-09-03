import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import { commandPinyinPlugin } from './dev/pinyin/commandPinyinPlugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 命令面板的检索索引在单测里也要读到构建期生成的拼音字典。
  plugins: [commandPinyinPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts']
  }
});
