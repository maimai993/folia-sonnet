import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

// test/unit/mod-system/androidNodeAssets.test.ts
// Keep the Android Node host self-contained so startup cannot fail on a missing npm dependency.

const assetRoot = path.resolve('android/app/src/main/assets/folia-node');

describe('Android Node host assets', () => {
    it('ships the fflate CommonJS runtime used by zipInstall', () => {
        const packagePath = path.join(assetRoot, 'node_modules/fflate/package.json');
        const entryPath = path.join(assetRoot, 'node_modules/fflate/index.cjs');
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { name?: string; version?: string; main?: string };
        expect(packageJson).toMatchObject({ name: 'fflate', version: '0.8.3', main: './index.cjs' });
        expect(fs.existsSync(entryPath)).toBe(true);
        const fflate = require(entryPath) as { unzipSync?: unknown };
        expect(typeof fflate.unzipSync).toBe('function');
    });

    /*
     * 悬浮窗归属（issue H19）。
     *
     * 禁用/卸载模组时，原生只能关掉「这个模组名下」的窗口 —— 那么开窗时就必须把归属报上去，
     * 总开关关掉时就必须显式请求全关。这两处都是纯字符串契约，删掉了不会有任何编译错误，
     * 只会退回「关掉模组浮窗还在动」的老毛病，所以在这里钉住。
     *
     * 用正则匹配真实调用形态而不是裸子串：第一版写成 `toContain('ownerModId')`，
     * 把标识符改名成 `ownerModIdRemoved` 之后仍然命中，反向验证照样绿 —— 那等于没测。
     */
    it('reports the owning mod when a mod opens an overlay window', () => {
        const host = fs.readFileSync(path.join(assetRoot, 'host.js'), 'utf8');
        // create 时把 ownerModId 塞进参数里，值来自调用栈反查。
        expect(host).toMatch(/ownerModId:\s*callerModId\(\)/);
        // 反查函数本身得在：从栈帧取出文件名、交给 modIdForFile。
        expect(host).toMatch(/const callerModId = \(\) =>/);
        expect(host).toMatch(/modIdForFile\(filename\)/);
    });

    it('tears down every overlay window when the mod system is switched off', () => {
        const host = fs.readFileSync(path.join(assetRoot, 'host.js'), 'utf8');
        expect(host).toMatch(/callOverlay\('destroy-all'/);
    });
});
