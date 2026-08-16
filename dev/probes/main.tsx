import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { PROBES, PROBE_LIST } from './registry';
// dev/probes/main.tsx

/**
 * 组件探针的挂载入口。用 ?probe=<id> 选择要挂载的探针，缺省时列出全部。
 *
 * 存在的理由：这个仓库没有 jsdom/RTL 组件测试环境，而实际踩到的坑（层叠命中测试、
 * Tailwind v4 语法、StrictMode 双调用）全都只在真实浏览器里才暴露。探针提供的是
 * 真实 vite + 真实 Tailwind + StrictMode 的最小宿主，能单独挂一个组件反复戳。
 *
 * StrictMode 是刻意开的：effect 双调用引发的 bug 只有在这里才复现。
 */
const ProbeIndex: React.FC = () => (
    <div className="mx-auto max-w-2xl p-10 font-sans text-zinc-100">
        <h1 className="mb-1 text-xl font-bold">Component Probes</h1>
        <p className="mb-6 text-sm text-zinc-400">在 URL 上加 ?probe=&lt;id&gt; 挂载单个组件。</p>
        <ul className="flex flex-col gap-3">
            {PROBE_LIST.map(probe => (
                <li key={probe.id}>
                    <a
                        className="block rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:bg-white/10"
                        href={`?probe=${probe.id}`}
                    >
                        <span className="block text-sm font-semibold">{probe.title}</span>
                        <span className="mt-1 block text-xs text-zinc-400">{probe.description}</span>
                        <code className="mt-2 block text-[11px] text-zinc-500">?probe={probe.id}</code>
                    </a>
                </li>
            ))}
            {PROBE_LIST.length === 0 && <li className="text-sm text-zinc-400">还没有探针。</li>}
        </ul>
    </div>
);

const requestedId = new URLSearchParams(window.location.search).get('probe');
const selected = requestedId ? PROBES[requestedId] : undefined;

if (requestedId && !selected) {
    console.error(`[Probe] Unknown probe "${requestedId}". Available: ${PROBE_LIST.map(p => p.id).join(', ')}`);
}

const Selected = selected?.Component;

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <div className="min-h-screen bg-zinc-900" data-probe-id={selected?.id ?? ''}>
            {Selected ? <Selected /> : <ProbeIndex />}
        </div>
    </React.StrictMode>,
);
