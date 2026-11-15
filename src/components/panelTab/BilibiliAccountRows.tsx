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
import { TextField } from '@/components/ui';

// src/components/panelTab/BilibiliAccountRows.tsx
// 「账号」页里 B 站特有的那几行：我的关注 / 我的粉丝 / 修改签名。
//
// 三个都只在登录着的时候有意义，所以整块由调用方按登录态决定挂不挂。
// 关注与粉丝是同一种列表（头像 + 名字 + 签名），用同一份渲染，点一行展开——
// 不另开页面：这是侧栏里的一小节，跳走再跳回来比就地展开更重。

interface BilibiliAccountRowsProps {
    /** 换掉当前页签时不保留展开状态。 */
    providerId: string;
}

const RelationList: React.FC<{ page: RelationPage | null; loading: boolean; empty: string }> = ({
    page,
    loading,
    empty,
}) => {
    const { t } = useTranslation();
    if (loading) return <div className="px-2 py-2 text-xs text-[color:var(--st-t2)]">{t('account.loading')}</div>;
    const users = page?.users ?? [];
    if (users.length === 0) return <div className="px-2 py-2 text-xs text-[color:var(--st-t2)]">{empty}</div>;
    return (
        <div className="max-h-64 space-y-1 overflow-y-auto px-1 pb-1">
            {users.map((user: RelationUser) => (
                <div key={user.mid} className="flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-white/5">
                    {user.avatarUrl ? (
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
        </div>
    );
};

const BilibiliAccountRows: React.FC<BilibiliAccountRowsProps> = ({ providerId }) => {
    const { t } = useTranslation();
    const [open, setOpen] = React.useState<'following' | 'fans' | null>(null);
    const [following, setFollowing] = React.useState<RelationPage | null>(null);
    const [fans, setFans] = React.useState<RelationPage | null>(null);
    const [loading, setLoading] = React.useState(false);
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

    const load = async (which: 'following' | 'fans') => {
        setOpen(prev => (prev === which ? null : which));
        setLoading(true);
        try {
            if (which === 'following') setFollowing(await listBilibiliFollowings());
            else setFans(await listBilibiliFans());
        } catch {
            if (which === 'following') setFollowing({ users: [], hasMore: false, total: 0 });
            else setFans({ users: [], hasMore: false, total: 0 });
        } finally {
            setLoading(false);
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
                <RelationList page={following} loading={loading} empty={t('account.relationEmpty')} />
            )}
            <PanelRow label={t('account.bilibiliFans')}>
                <PanelButton icon={ChevronDown} onClick={() => void load('fans')}>
                    {open === 'fans' ? t('account.collapse') : t('account.expand')}
                </PanelButton>
            </PanelRow>
            {open === 'fans' && (
                <RelationList page={fans} loading={loading} empty={t('account.relationEmpty')} />
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
