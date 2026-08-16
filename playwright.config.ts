import { existsSync } from 'fs';
import { defineConfig } from '@playwright/test';

const loopbackNoProxy = '127.0.0.1,localhost,::1';
process.env.NO_PROXY = process.env.NO_PROXY ? `${process.env.NO_PROXY},${loopbackNoProxy}` : loopbackNoProxy;
process.env.no_proxy = process.env.no_proxy ? `${process.env.no_proxy},${loopbackNoProxy}` : loopbackNoProxy;

const chromiumCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].filter((value): value is string => Boolean(value));

const chromiumExecutablePath = chromiumCandidates.find(candidate => existsSync(candidate));

export default defineConfig({
  testDir: './test/ui',
  fullyParallel: false,
  reporter: 'line',
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    // 多 worker 并行时 CPU 争用会让个别文字标签的抗锯齿/过渡落定结果有微小出入，
    // 实测抖动量级在 ~115px。真实 UI 变化的量级完全不同（基线过期时是 80 万像素），
    // 所以这个容差不会掩盖回归。
    toHaveScreenshot: {
      maxDiffPixels: 600,
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: {
      width: 1440,
      height: 1100,
    },
    trace: 'on-first-retry',
    launchOptions: {
      executablePath: chromiumExecutablePath,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },
  webServer: {
    command: 'cross-env VITE_NETEASE_API_BASE=http://127.0.0.1:4173/__mock_netease__ npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
