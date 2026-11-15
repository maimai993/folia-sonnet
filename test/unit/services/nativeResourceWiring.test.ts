import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 不启动 Android；核对纯策略（RemoteAudioRegistry）确实接到生产 OkHttp/插件出口。
// 原生侧在 dev 上已完成 Kotlin 迁移（.java → .kt），路径常量名沿用旧称。
const javaRoot = new URL('../../../android/app/src/main/java/top/izuna/foliamajor/', import.meta.url);
const server = readFileSync(new URL('LocalAudioServer.kt', javaRoot), 'utf8');
const plugin = readFileSync(new URL('FoliaNativePlugin.kt', javaRoot), 'utf8');

describe('native resource policy wiring (static)', () => {
    it('disables both redirect modes for credential requests, retaining normal CDN redirects', () => {
        expect(server).toMatch(/credentialResourceClient: OkHttpClient = remoteAudioClient\.newBuilder\(\)\s*\.followRedirects\(false\)\s*\.followSslRedirects\(false\)/);
        expect(server).toContain('if (entry.allowsRedirects()) remoteAudioClient.newCall(request.build()).execute()');
        expect(server).toContain('else credentialResourceClient.newCall(request.build()).execute()');
    });

    it('validates origin before scoped registration and exposes explicit revoke support', () => {
        expect(server).toMatch(/RemoteAudioRegistry\.validateOrigin\(value, origin\)\s+return registerRemoteAudio\(value, headers, true, false\)/);
        expect(server).toContain('remoteAudioRegistry.remove(');
        expect(plugin).toContain('fun registerScopedRemoteAudio(call: PluginCall)');
        expect(plugin).toContain('fun unregisterRemoteAudio(call: PluginCall)');
        expect(plugin).toContain('localAudioServer!!.registerScopedRemoteAudio(url, headers, credentialOrigin)');
    });
});
