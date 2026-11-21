// src/services/onlineMusic/lxmusic/lxScriptApproval.ts
// 洛雪音源脚本的「先问再跑」：执行之前把脚本能做什么摊给用户看，并把确认记录钉在脚本内容上。
//
// 为什么需要这一层：音源是用户自己从网上拿来的第三方脚本。沙箱（lxSourceSandbox.ts）已经把它的
// 能力压到一张白名单，但白名单里的两件事仍然是不小的权限 —— 发任意 HTTP 请求（音源服务器的域名
// 千奇百怪，不能按域名放行）和占用 worker 的 CPU。所以按 C2 的要求再加两道：
//
//   1. **执行前确认**：把「这个脚本能做什么」逐条摆出来（能请求网络、能声明哪些平台、脚本从前
//      面注释里自称的名字/作者/版本、指纹），用户点了同意才执行。
//   2. **确认绑内容**：确认记录里存的是脚本正文的 sha256。脚本改一个字，指纹就变，必须重新确认 ——
//      否则「导入时看过的脚本」和「实际跑起来的脚本」可能不是同一份（更新、别人替换了文件）。
//
// 确认记录存在 localStorage 的 lxmusic_script_approvals_v1 里，键是音源 id（导入时的 uuid）。
// 与模组的信任根（app-private 目录）不同，这里没有更强的落脚点：渲染进程能写的只有 localStorage，
// 但它拦的是「用户有没有看过这一版脚本」，写它的人就是用户自己的设备，不是模组那种要防的角色。

import { sha256Hex } from './lxFingerprint';

/** 存储键；新键已登记在 dev/dedicatus/storageKeys.mjs（D507）。 */
export const LX_SCRIPT_APPROVALS_KEY = 'lxmusic_script_approvals_v1';

/** 一条确认记录：某个音源 id 的某一版脚本（按指纹）被同意过。 */
export interface LxScriptApproval {
    /** 脚本正文的 sha256（与 lxSourceSandbox 侧的指纹同一算法）。 */
    digest: string;
    /** 确认的时间戳。 */
    approvedAt: number;
    /** 确认时脚本自称的版本，只用于界面上「上次确认的是哪一版」。 */
    scriptVersion?: string;
}

export type LxScriptApprovalTable = Record<string, LxScriptApproval>;

const readTable = (): LxScriptApprovalTable => {
    try {
        const raw = localStorage.getItem(LX_SCRIPT_APPROVALS_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: LxScriptApprovalTable = {};
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue;
            const record = value as Partial<LxScriptApproval>;
            if (typeof record.digest !== 'string' || record.digest.length === 0) continue;
            out[id] = {
                digest: record.digest,
                approvedAt: typeof record.approvedAt === 'number' ? record.approvedAt : 0,
                scriptVersion: typeof record.scriptVersion === 'string' ? record.scriptVersion : undefined,
            };
        }
        return out;
    } catch (err) {
        // 记录坏了就当没确认过：重新问一次是安全的默认（不能反过来默认放行）。
        console.warn('[lx] 读取音源确认记录失败，按未确认处理：', err);
        return {};
    }
};

const writeTable = (table: LxScriptApprovalTable): void => {
    try {
        localStorage.setItem(LX_SCRIPT_APPROVALS_KEY, JSON.stringify(table));
    } catch (err) {
        console.warn('[lx] 保存音源确认记录失败：', err);
    }
};

/** 这个 id 的这一版脚本已经确认过了吗。 */
export const isScriptApproved = async (sourceId: string, rawScript: string): Promise<boolean> => {
    const digest = await sha256Hex(rawScript);
    return readTable()[sourceId]?.digest === digest;
};

/** 记下「用户看过这一版脚本并同意执行」。 */
export const approveScript = async (
    sourceId: string,
    rawScript: string,
    scriptVersion?: string,
): Promise<void> => {
    const digest = await sha256Hex(rawScript);
    const table = readTable();
    table[sourceId] = { digest, approvedAt: Date.now(), scriptVersion };
    writeTable(table);
};

/** 忘掉某个音源的确认（删除音源、或用户主动收回时）。 */
export const forgetScriptApproval = (sourceId: string): void => {
    const table = readTable();
    if (!(sourceId in table)) return;
    delete table[sourceId];
    writeTable(table);
};
