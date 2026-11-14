// src/services/foliaCredits.ts
// 「这台设备还剩多少额度」——用机器码本身去问（它就是那把 Key）。
//
// 为什么不让客户端带管理令牌：那个令牌是给机器人用的，绝不能进前端包。而「我这条 Key
// 还剩多少」本来就该由持有者问，机器码就是凭据，所以走 `/api/folia/machine/me`，
// 用 `Authorization: Bearer <机器码>` 鉴权，服务端只回这一条 Key 的额度。

import { createAiFetch } from './aiNativeFetch';
import { ensureMachineCode } from './foliaMachineCode';
import { FOLIA_WORK_API_ROOT } from '../../shared/ai/foliawork.mjs';

export interface FoliaCredits {
    /** 这个机器码在后台有没有建过 Key（没有就是还没绑定）。 */
    bound: boolean;
    /** Key 被停用了（换了机器码 / 管理员回收）。 */
    disabled: boolean;
    /** 还剩多少；不限额时为 null。 */
    remaining: number | null;
    limit: number;
    used: number;
    /**
     * 今天签过没有。以**服务端**为准 —— 群里签过之后 App 也要显示「今日已签到」，
     * 两边共用同一条记录（folia_checkins 的 (机器码, 日期) 唯一索引）。
     */
    checkedInToday: boolean;
    /**
     * 上次实际用的模型。`auto` 会换模型，所以界面上要单独显示「这次跑的是哪个」——
     * 光写「自动」会让人不知道到底降级没有。
     */
    lastModel: string;
}

const ME_URL = `${FOLIA_WORK_API_ROOT}/api/folia/machine/me`;

const asNumber = (value: unknown): number => (
    typeof value === 'number' && Number.isFinite(value) ? value : 0
);

/**
 * 查额度。返回 null 表示「这次没查到」（网络、超时、后台拒绝）——
 * 调用方要能把它和「没绑定」分开，否则一次网络抖动会被说成「你没绑定」。
 */
export const fetchFoliaCredits = async (): Promise<FoliaCredits | null> => {
    const code = ensureMachineCode();
    try {
        const response = await createAiFetch()(ME_URL, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${code}`,
            },
        });
        if (!response.ok) return null;
        const body = await response.json().catch(() => null) as {
            ok?: unknown;
            bound?: unknown;
            disabled?: unknown;
            checkedInToday?: unknown;
            lastModel?: unknown;
            key?: { remaining?: unknown; creditLimit?: unknown; creditUsed?: unknown; unlimited?: unknown };
        } | null;
        if (!body || body.ok === false) return null;
        if (body.bound !== true) {
            return { bound: false, disabled: false, remaining: null, limit: 0, used: 0, checkedInToday: false, lastModel: '' };
        }
        const key = body.key ?? {};
        return {
            bound: true,
            disabled: body.disabled === true,
            remaining: key.unlimited === true ? null : asNumber(key.remaining),
            limit: asNumber(key.creditLimit),
            used: asNumber(key.creditUsed),
            checkedInToday: body.checkedInToday === true,
            lastModel: typeof body.lastModel === 'string' ? body.lastModel : '',
        };
    } catch {
        return null;
    }
};
