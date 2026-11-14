import { API_BASE, fetchJsonWithHeaders, unwrap } from './api';
import { isBilibiliAvailable, requestBilibiliUrl } from './transport';
import { readBilibiliAuthNative, readBilibiliCsrfNative } from '../../platform/foliaNative';

// src/services/bilibili/account.ts
// 账号相关：我的关注 / 我的粉丝 / 改签名。
//
// 接口照 BiliPai（core-data/.../ApiClient.kt 的 relation 段与 ProfileAccountRepository）：
//   GET  x/relation/followings?vmid&pn&ps&order_type
//   GET  x/relation/fans?vmid&pn&ps&order=desc&order_type=attention
//   POST x/member/web/sign/update  (user_sign + csrf)
//
// 读的两个列表要 Cookie（有人在隐身 / 隐私设置里把关注藏起来时，不带登录态就是空），
// 写的那个还要 csrf —— 都从原生侧拿，渲染层不碰 SESSDATA。

export interface RelationUser {
    mid: number;
    name: string;
    avatarUrl: string;
    sign: string;
}

export interface RelationPage {
    users: RelationUser[];
    /** 对方页面上还有没有下一页。 */
    hasMore: boolean;
    /** 总人数（接口给的时候才有）。 */
    total: number;
}

const PAGE_SIZE = 30;

const normalizeAvatar = (url: string): string => {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    return url.replace(/^http:\/\//, 'https://');
};

interface RelationListItem {
    mid?: number;
    uname?: string;
    face?: string;
    sign?: string;
}

const readRelationPage = (payload: { list?: RelationListItem[]; total?: number }) : RelationPage => {
    const list = Array.isArray(payload.list) ? payload.list : [];
    const users = list.flatMap((item): RelationUser[] => {
        const mid = typeof item.mid === 'number' ? item.mid : Number(item.mid);
        if (!Number.isFinite(mid)) return [];
        return [{
            mid,
            name: typeof item.uname === 'string' ? item.uname : '',
            avatarUrl: normalizeAvatar(typeof item.face === 'string' ? item.face : ''),
            sign: typeof item.sign === 'string' ? item.sign : '',
        }];
    });
    const total = typeof payload.total === 'number' ? payload.total : users.length;
    return { users, hasMore: list.length >= PAGE_SIZE && users.length < total, total };
};

/** 当前登录的 mid。没登录就是空串。 */
const currentMid = async (): Promise<string> => {
    const status = await readBilibiliAuthNative();
    return status.signedIn ? (status.uid || '') : '';
};

/**
 * 我的关注。
 *
 * 走的是「谁关注了谁」那条公开接口，但带上自己的 Cookie 才看得全 —— 关注列表
 * 默认对别人藏着，对自己不藏。
 */
export const listBilibiliFollowings = async (page = 1): Promise<RelationPage> => {
    if (!isBilibiliAvailable()) return { users: [], hasMore: false, total: 0 };
    const vmid = await currentMid();
    if (!vmid) return { users: [], hasMore: false, total: 0 };
    const url = `${API_BASE}/x/relation/followings?vmid=${vmid}&pn=${page}&ps=${PAGE_SIZE}&order_type=attention`;
    const envelope = await fetchJsonWithHeaders<{ list?: RelationListItem[]; total?: number }>(
        url,
        { Referer: `https://space.bilibili.com/${vmid}/fans/follow` },
    );
    return readRelationPage(unwrap(envelope));
};

/** 我的粉丝。 */
export const listBilibiliFans = async (page = 1): Promise<RelationPage> => {
    if (!isBilibiliAvailable()) return { users: [], hasMore: false, total: 0 };
    const vmid = await currentMid();
    if (!vmid) return { users: [], hasMore: false, total: 0 };
    const url = `${API_BASE}/x/relation/fans?vmid=${vmid}&pn=${page}&ps=${PAGE_SIZE}&order=desc&order_type=attention`;
    const envelope = await fetchJsonWithHeaders<{ list?: RelationListItem[]; total?: number }>(
        url,
        { Referer: `https://space.bilibili.com/${vmid}/fans/fans` },
    );
    return readRelationPage(unwrap(envelope));
};

/**
 * 改自己的签名。
 *
 * 表单里那句 csrf 是双重提交令牌：cookie 里有一个同样的值，两处对上才认。
 * 返回 true 表示站上真的改了；抛错表示没改成（消息来自接口）。
 */
export const updateBilibiliSign = async (sign: string): Promise<boolean> => {
    if (!isBilibiliAvailable()) throw new Error('bilibili requests need the Android app');
    const csrf = await readBilibiliCsrfNative();
    if (!csrf) throw new Error('not signed in');
    const body = new URLSearchParams({ user_sign: sign, csrf }).toString();
    const response = await requestBilibiliUrl(`${API_BASE}/x/member/web/sign/update`, {
        method: 'POST',
        body,
        headers: {
            Referer: 'https://space.bilibili.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });
    if (!response.bodyText) throw new Error('empty response');
    const payload = JSON.parse(response.bodyText) as { code?: number; message?: string };
    if (payload.code !== 0) throw new Error(payload.message || `bilibili error ${payload.code}`);
    return true;
};

/** 自己主页上的签名（改完之后回填 / 进来时显示当前值）。 */
export const readMySign = async (): Promise<string> => {
    if (!isBilibiliAvailable()) return '';
    try {
        const envelope = await fetchJsonWithHeaders<{ sign?: string }>(
            `${API_BASE}/x/member/web/account`,
            { Referer: 'https://space.bilibili.com/' },
        );
        return unwrap(envelope).sign ?? '';
    } catch {
        return '';
    }
};
