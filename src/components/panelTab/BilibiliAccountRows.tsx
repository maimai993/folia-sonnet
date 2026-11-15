import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Users } from 'lucide-react';
import {
    listBilibiliFans,
    listBilibiliFollowings,
    readMySign,
    updateBilibiliSign,
    type RelationPage,
    type RelationUser,
} from '../../services/bilibili/account';
import { GroupLine } from './shell/GroupLine';
import { PanelButton } from './shell/PanelButton';
import { PanelRow } from './shell/PanelRow';
import { Button, TextField } from '@/components/ui';

// src/components/panelTab/BilibiliAccountRows.tsx
// 「账号」页里 B 站特有的那几行：我的关注 / 我的粉丝 / 修改签名。
//
// 三个都只在登录着的时候有意义，所以整块由调用方按登录态决定挂不挂。
// 关注与粉丝是同一种列表（头像 + 名字 + 签名），用同一份渲染，点一行展开——
// 不另开页面：这是侧栏里的一小节，跳走再跳回来比就地展开更重。

interface BilibiliAccountRowsProps {
    /** 换掉当前页签时不保留展开状态。 */
    providerId: string;
    /** 点关注 / 粉丝列表里的头像：去这个 UP 主的投稿页。不给就不可点。 */
    onOpenUser?: (user: RelationUser) => void;
}

/**
 * 关注 / 粉丝列表。
 *
 * 滑到底自动翻页：这份名单动辄几十上百人，只给第一页（20 个）等于「翻不到后面的人」。
 * 头像单独可点 —— 点整行是展开签名，点头像是去这个人的投稿，两件事分开。
 */
const RelationList: React.FC<{
    page: RelationPage | null;
    loading: boolean;
    loadingMore: boolean;
    empty: string;
    onReachEnd: () => void;
    onOpenUser?: (user: RelationUser) => void;
}> = ({ page, loading, loadingMore, empty, onReachEnd, onOpenUser }) => {
    const { t } = useTranslation();
    /*
     * 到底了就再要一页。
     *
     * 监听的是滚动容器的 scroll 事件而不是给底部放一个哨兵：这个列表只有 64 的高度，
     * IntersectionObserver 在这种小滚动区里对「滚到最底」的判定经常慢半拍，
     * 而这里本来就是一次翻页就够（滚动事件很便宜）。
     */
    const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
        if (loading || loadingMore || !page?.hasMore) return;
        const box = event.currentTarget;
        // 留 24px 提前量：滑到离底还有一点就开始取，滚动不会顿一下。
        if (box.scrollTop + box.clientHeight >= box.scrollHeight - 24) onReachEnd();
    };

    if (loading) return <div className="px-2 py-2 text-xs text-[color:var(--st-t2)]">{t('account.loading')}</div>;
    const users = page?.users ?? [];
    if (users.length === 0) return <div className="px-2 py-2 text-xs text-[color:var(--st-t2)]">{empty}</div>;
    return (
        <div className="max-h-64 space-y-1 overflow-y-auto px-1 pb-1" onScroll={handleScroll}>
            {users.map((user: RelationUser) => (
                <div key={user.mid} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-white/5">
                    {/*
                     * 头像是「去这个人的投稿页」的入口，不是装饰。
                     *
                     * 没登录 / 不可点的时候退化成 <span>：一个点了没反应的按钮
                     * 比一张图片更让人困惑。
                     */}
                    {onOpenUser ? (
                        <Button
                            variant="bare"
                            onClick={() => onOpenUser(user)}
                            tip={t('account.openUploads', { name: user.name })}
                            className="shrink-0 rounded-full transition-opacity hover:opacity-80"
                        >
                            {user.avatarUrl ? (
                                <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                            ) : (
                                <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--st-fill)]">
                                    <Users size={14} />
                                </span>
                            )}
                        </Button>
                    ) : user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                    ) : (
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--st-fill)]">
                            <Users size={14} />
                        </span>
                    )}
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-[color:var(--st-t1)]">{user.name}</span>
                        <span className="block truncate text-[11px] text-[color:var(--st-t2)]">
                            {user.sign || `UID ${user.mid}`}
                        </span>
                    </span>
                </div>
            ))}
            {loadingMore && (
                <div className="px-1.5 py-1 text-[11px] text-[color:var(--st-t2)]">{t('account.loading')}</div>
            )}
        </div>
    );
};

const BilibiliAccountRows: React.FC<BilibiliAccountRowsProps> = ({ providerId, onOpenUser }) => {
    const { t } = useTranslation();
    const [open, setOpen] = React.useState<'following' | 'fans' | null>(null);
    const [following, setFollowing] = React.useState<RelationPage | null>(null);
    const [fans, setFans] = React.useState<RelationPage | null>(null);
    const [loading, setLoading] = React.useState(false);
    /*
     * 翻页要记住「拉到第几页了」。
     *
     * 放在 ref 里而不是 state：它只在拉取时被读写，改它不该重渲染；
     * 用 state 的话每次翻页都会多渲染一次整个账号页。
     */
    const nextPage = React.useRef<Record<'following' | 'fans', number>>({ following: 1, fans: 1 });
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [sign, setSign] = React.useState('');
    const [signDraft, setSignDraft] = React.useState('');
    const [editing, setEditing] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [notice, setNotice] = React.useState('');

    // 进来先把自己的签名读回来（改完回填也用它）。
    React.useEffect(() => {
        let alive = true;
        void readMySign().then((value) => {
            if (!alive) return;
            setSign(value);
            setSignDraft(value);
        });
        return () => { alive = false; };
    }, [providerId]);

    const fetchPage = (which: 'following' | 'fans', page: number) => (
        which === 'following' ? listBilibiliFollowings(page) : listBilibiliFans(page)
    );

    /** 展开 / 收起。展开时总是从第一页重新拉 —— 名单是会变的，旧的留着不如重新问一次。 */
    const load = async (which: 'following' | 'fans') => {
        if (open === which) {
            setOpen(null);
            return;
        }
        setOpen(which);
        setLoading(true);
        nextPage.current[which] = 1;
        try {
            const page = await fetchPage(which, 1);
            if (which === 'following') setFollowing(page);
            else setFans(page);
            nextPage.current[which] = 2;
        } catch {
            if (which === 'following') setFollowing({ users: [], hasMore: false, total: 0 });
            else setFans({ users: [], hasMore: false, total: 0 });
        } finally {
            setLoading(false);
        }
    };

    /**
     * 滑到底了，接下一页。
     *
     * 接在已有的后面而不是替换：这是「一直往下滑」，不是「跳到第 N 页」。
     * 已经在拉、或者已经到底了就什么都不做（滚动事件会连着来好几次）。
     */
    const loadMore = async (which: 'following' | 'fans') => {
        if (loadingMore || loading) return;
        const current = which === 'following' ? following : fans;
        if (!current?.hasMore) return;
        setLoadingMore(true);
        try {
            const page = await fetchPage(which, nextPage.current[which]);
            const merge = (previous: RelationPage | null): RelationPage => {
                const seen = new Set((previous?.users ?? []).map(user => user.mid));
                const fresh = page.users.filter(user => !seen.has(user.mid));
                return {
                    users: [...(previous?.users ?? []), ...fresh],
                    // 接口说没有了就是没有了；它还说有、却一个新人也没多出来，也算到底 ——
                    // 否则这里会一直问同一页，永远滑不完。
                    hasMore: page.hasMore && fresh.length > 0,
                    total: page.total || (previous?.total ?? 0),
                };
            };
            if (which === 'following') setFollowing(merge);
            else setFans(merge);
            nextPage.current[which] += 1;
        } catch {
            // 这一页没拿到就先停在这里：下次滑动还会再试。
        } finally {
            setLoadingMore(false);
        }
    };

    const save = async () => {
        setSaving(true);
        setNotice('');
        try {
            await updateBilibiliSign(signDraft);
            setSign(signDraft);
            setEditing(false);
            setNotice(t('account.signSaved'));
        } catch (error) {
            setNotice(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <GroupLine />
            <PanelRow label={t('account.bilibiliFollowing')}>
                <PanelButton icon={ChevronDown} onClick={() => void load('following')}>
                    {open === 'following' ? t('account.collapse') : t('account.expand')}
                </PanelButton>
            </PanelRow>
            {open === 'following' && (
                <RelationList
                    page={following}
                    loading={loading}
                    loadingMore={loadingMore}
                    empty={t('account.relationEmpty')}
                    onReachEnd={() => void loadMore('following')}
                    onOpenUser={onOpenUser}
                />
            )}
            <PanelRow label={t('account.bilibiliFans')}>
                <PanelButton icon={ChevronDown} onClick={() => void load('fans')}>
                    {open === 'fans' ? t('account.collapse') : t('account.expand')}
                </PanelButton>
            </PanelRow>
            {open === 'fans' && (
                <RelationList
                    page={fans}
                    loading={loading}
                    loadingMore={loadingMore}
                    empty={t('account.relationEmpty')}
                    onReachEnd={() => void loadMore('fans')}
                    onOpenUser={onOpenUser}
                />
            )}
            <PanelRow label={t('account.bilibiliSign')} hint={sign || undefined}>
                <PanelButton onClick={() => setEditing(value => !value)}>
                    {t('account.editSign')}
                </PanelButton>
            </PanelRow>
            {editing && (
                <div className="flex items-center gap-2 px-1 pb-1">
                    <TextField
                        value={signDraft}
                        onChange={event => setSignDraft(event.target.value)}
                        maxLength={120}
                        placeholder={t('account.signPlaceholder')}
                        className="min-w-0 flex-1"
                    />
                    <PanelButton disabled={saving} onClick={() => void save()}>
                        {saving ? t('account.saving') : t('account.save')}
                    </PanelButton>
                </div>
            )}
            {notice && <div className="px-2 pb-1 text-[11px] text-[color:var(--st-t2)]">{notice}</div>}
        </>
    );
};

export default BilibiliAccountRows;
