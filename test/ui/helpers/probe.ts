import type { Page } from '@playwright/test';
import { APP_VERSION, GUIDE_VERSION_STORAGE_KEY } from './appState';

// test/ui/helpers/probe.ts

/**
 * 打开 dev 组件探针页并挂载指定探针。
 *
 * 探针页只挂单个组件，不启动整个应用，所以既快又不受首页数据、弹窗、背景 shader 影响；
 * 适合给那些「只有真实浏览器才暴露」的组件级问题写回归用例。
 * 探针清单见 dev/probes/*.probe.tsx。
 */
export async function openProbe(page: Page, probeId: string): Promise<void> {
    await page.addInitScript(([version, guideKey]) => {
        localStorage.clear();
        localStorage.setItem('i18nextLng', 'en');
        localStorage.setItem('static_mode', 'true');
        localStorage.setItem(guideKey, version);
    }, [APP_VERSION, GUIDE_VERSION_STORAGE_KEY]);

    await page.goto(`/dev-probe.html?probe=${encodeURIComponent(probeId)}`);
    await page.waitForSelector(`[data-probe-id="${probeId}"]`);
}
