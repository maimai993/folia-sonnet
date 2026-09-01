import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

// playwright.probe.config.ts
// Runs the *.probe.ts measurement files, which are deliberately excluded from `npm run test:ui`.
// A render count is only attributable on a machine that is not otherwise busy: under the parallel
// suite the app never goes idle, and the numbers stop meaning anything. One worker, on purpose.
export default defineConfig({
  ...baseConfig,
  testMatch: '**/*.probe.ts',
  workers: 1,
  fullyParallel: false,
});
