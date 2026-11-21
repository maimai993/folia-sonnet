// src/services/onlineMusic/lxmusic/lxScriptApprovalFlow.ts
// 「执行前确认」的那条流程：谁在等同意、同意之后怎么接着跑。界面只负责把这个状态画出来。
//
// 为什么单独一层：脚本执行的前置确认不止导入一个入口 —— 已有的音源在启动时被加载、用户手动
// 触发「重新加载」，都可能是「这一版脚本还没确认过」（比如升级前就装着的源，那时还没有确认这回事）。
// 把所有入口收在这一处，规则只有一条：**没有这一版脚本的确认记录，就不执行它**。

import { approveScript, isScriptApproved } from './lxScriptApproval';
import { sha256Hex } from './lxFingerprint';
import { KNOWN_PLATFORMS } from './lxSourceParser';
import type { LxSourceMeta } from './lxTypes';

/** 等用户确认的脚本。 */
export interface LxPendingScript {
    /** 确认记录按它存；导入时生成的 uuid 会一直被沿用。 */
    sourceId: string;
    meta: LxSourceMeta;
    /** 脚本正文字节数。 */
    sizeBytes: number;
    /** 正文的 sha256，确认框里完整显示。 */
    fingerprint: string;
    /** 正文里静态扫出来的平台键（提示用）。 */
    platforms: string[];
    /** 规整后的脚本文本；同意之后原样交给沙箱。不写日志、不落盘。 */
    rawScript: string;
    /** 若是从网址导入的，记下来源。 */
    sourceUrl?: string;
}

type Listener = (pending: LxPendingScript | null) => void;

/** 一次待确认：用户决定之后由它接着跑后续动作。 */
interface Waiting {
    pending: LxPendingScript;
    resolve: (approved: boolean) => void;
}

/** 静态扫一遍正文里出现过哪些平台键，只用于确认框的提示（真正的平台以 inited 为准）。 */
const scanPlatforms = (code: string): string[] => {
    const found: string[] = [];
    for (const key of KNOWN_PLATFORMS) {
        // 只看「像对象键」的出现：'wy' / "wy" / wy: —— 免得把英文单词里的两个字母也算进来。
        const pattern = new RegExp(`['"\`]${key}['"\`]|\\b${key}\\s*:`);
        if (pattern.test(code)) found.push(key);
    }
    return found;
};

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

class LxScriptApprovalFlow {
    private waiting: Waiting | null = null;

    private listeners = new Set<Listener>();

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        // 订阅时先给一次当前状态：订阅之前就挂起的确认不能丢。
        listener(this.waiting?.pending ?? null);
        return () => { this.listeners.delete(listener); };
    }

    /** 当前等确认的那一份（界面画出来时用）。 */
    getPending(): LxPendingScript | null {
        return this.waiting?.pending ?? null;
    }

    /**
     * 这个音源的这一版脚本确认过吗；没确认就挂起等用户点，并返回 false。
     *
     * 调用方拿到 false 就当「这次不执行」，别再做别的（比如先执行再问）—— 那条路就是原来的问题本身。
     */
    async ensureApproved(
        sourceId: string,
        rawScript: string,
        meta: LxSourceMeta,
        sourceUrl?: string,
    ): Promise<boolean> {
        if (await isScriptApproved(sourceId, rawScript)) return true;
        const pending: LxPendingScript = {
            sourceId,
            meta,
            sizeBytes: utf8Length(rawScript),
            fingerprint: await sha256Hex(rawScript),
            platforms: scanPlatforms(rawScript),
            rawScript,
            sourceUrl,
        };
        return this.request(pending);
    }

    /** 挂起一次确认，等用户决定。同一时间只挂一个：后来的替换前面的，前一个按「取消」处理。 */
    private request(pending: LxPendingScript): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const previous = this.waiting;
            this.waiting = { pending, resolve };
            this.emit(pending);
            // 先换掉状态再收前一个，免得它的 resolve 触发界面又画一次已经作废的框。
            if (previous) previous.resolve(false);
        });
    }

    private emit(pending: LxPendingScript | null): void {
        this.listeners.forEach((listener) => listener(pending));
    }

    /** 用户点了同意：记下这一版脚本的指纹并放行。 */
    async approve(): Promise<void> {
        const current = this.waiting;
        if (!current) return;
        this.waiting = null;
        this.emit(null);
        await approveScript(current.pending.sourceId, current.pending.rawScript, current.pending.meta.version);
        current.resolve(true);
    }

    /** 用户点了取消（或关掉了框）：这一份不执行。 */
    cancel(): void {
        const current = this.waiting;
        if (!current) return;
        this.waiting = null;
        this.emit(null);
        current.resolve(false);
    }
}

/** 全局唯一的那条确认流程（界面与 store 共用）。 */
export const lxScriptApprovalFlow = new LxScriptApprovalFlow();
