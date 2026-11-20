// src/services/onlineMusic/lxmusic/lxImportService.ts
// 导入洛雪音源：在线导入（粘贴网址）与本地导入（选 .js / .json 文件）。
//
// 分两步，中间夹一道用户确认（C2）：先把脚本抓下来、解析、算指纹，交给界面弹确认框；用户点了
// 「同意并运行」之后才真正交给 store 执行。音源脚本是第三方代码，不能「下载完就在页面里跑」。

import { lxSourceStore } from './lxSourceStore';
import { LxSourceParseError, normalizeLxScript, parseLxHeader, validateLxScript } from './lxSourceParser';
import { lxScriptApprovalFlow, type LxPendingScript } from './lxScriptApprovalFlow';
import type { LxSource, LxSourceMeta } from './lxTypes';

/** 等用户确认：脚本已经下载并解析好，但一行代码都还没执行。 */
export type LxImportPending = { ok: false; pending: LxPendingScript };

export type ImportResult =
    | { ok: true; source: LxSource }
    | { ok: false; error: string }
    | LxImportPending;

/** 第二步：把已经解析好的脚本交给 store 执行（用户已经同意）。 */
const runApproved = async (code: string, sourceUrl: string | undefined, sourceId: string): Promise<ImportResult> => {
    try {
        const source = await lxSourceStore.addSource({ rawScript: code, sourceUrl, id: sourceId });
        if (source.error) {
            return { ok: false, error: `音源「${source.meta.name}」加载失败：${source.error}` };
        }
        return { ok: true, source };
    } catch (err) {
        if (err instanceof LxSourceParseError) return { ok: false, error: err.message };
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
};

/**
 * 第一步：校验 + 算指纹，然后把确认挂起来等用户点。
 *
 * 用户同意后在这里接着执行 —— 于是界面只需要处理「待确认」与「结果」两种状态，
 * 不用自己拼「同意之后还要再调一次导入」。
 */
const prepare = async (raw: string, sourceUrl?: string): Promise<ImportResult> => {
    let code: string;
    try {
        code = normalizeLxScript(raw);
        validateLxScript(code);
    } catch (err) {
        if (err instanceof LxSourceParseError) return { ok: false, error: err.message };
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // 导入的脚本每次都是新的 id；确认记录跟着这个 id 走，用户看到的和要跑的是同一份指纹。
    const sourceId = `lx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const meta: LxSourceMeta = parseLxHeader(code);
    const approved = await lxScriptApprovalFlow.ensureApproved(sourceId, code, meta, sourceUrl);
    if (!approved) {
        return { ok: false, error: '已取消：这份脚本没有执行。' };
    }
    return runApproved(code, sourceUrl, sourceId);
};

/** 在线导入：从网址拉取音源脚本，下载完先等确认。 */
export const importLxSourceFromUrl = async (url: string): Promise<ImportResult> => {
    const trimmed = url.trim();
    if (!/^https?:\/\//.test(trimmed)) return { ok: false, error: '请输入以 http(s):// 开头的音源网址。' };
    try {
        const resp = await fetch(trimmed, { mode: 'cors' });
        if (!resp.ok) return { ok: false, error: `下载失败：HTTP ${resp.status}` };
        const text = await resp.text();
        return prepare(text, trimmed);
    } catch (err) {
        return { ok: false, error: `下载失败：${err instanceof Error ? err.message : String(err)}（可能是跨域受限或网址不可达）` };
    }
};

/** 本地导入：读取用户选中的文件，读完先等确认。 */
export const importLxSourceFromFile = async (file: File): Promise<ImportResult> => {
    try {
        const text = await file.text();
        return prepare(text);
    } catch (err) {
        return { ok: false, error: `读取文件失败：${err instanceof Error ? err.message : String(err)}` };
    }
};
