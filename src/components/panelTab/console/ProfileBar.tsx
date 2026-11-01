import React, { useEffect, useRef, useState } from 'react';
import { Check, Headphones, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AUDIO_PROFILE_LIMIT, AUDIO_PROFILE_NAME_MAX } from '../../../utils/audioProfiles';
import { useAudioProfilesStore } from '../../../stores/useAudioProfilesStore';
import ConfirmDialog from '../../shared/ConfirmDialog';
import { Button } from '../../ui';
import TextField from '../../ui/TextField';
import PanelIconButton from '../shell/PanelIconButton';

// src/components/panelTab/console/ProfileBar.tsx
// 窗口最上面那条「耳机方案」：一行芯片切换，右边三个动作（复制 / 改名 / 删除）。
//
// 布局上有意把高度钉死在 32px：芯片只横向滚动、不换行，改名时输入框占据同一条，
// 所以方案多少套、改不改名，下面的页签都不会上下跳。

type ProfileBarProps = {
    isDaylight: boolean;
};

const ProfileBar: React.FC<ProfileBarProps> = ({ isDaylight }) => {
    const { t } = useTranslation();
    const profiles = useAudioProfilesStore(state => state.profiles);
    const activeId = useAudioProfilesStore(state => state.activeId);
    const switchTo = useAudioProfilesStore(state => state.switchTo);
    const duplicateActive = useAudioProfilesStore(state => state.duplicateActive);
    const renameActive = useAudioProfilesStore(state => state.renameActive);
    const deleteActive = useAudioProfilesStore(state => state.deleteActive);

    const [renaming, setRenaming] = useState(false);
    const [draftName, setDraftName] = useState('');
    // 确认框只在真要删的时候挂上：平时不占一棵隐藏的对话框树。
    const [pendingDelete, setPendingDelete] = useState(false);
    const stripRef = useRef<HTMLDivElement>(null);

    // 复制出来的那一套在最右端，切过去时如果不在视野里，芯片看着像没动。
    // 这里直接改 scrollLeft（不带动画），只把当前那枚推回视野，不整条重排。
    useEffect(() => {
        const strip = stripRef.current;
        const chip = strip?.querySelector<HTMLElement>(`[data-profile-id="${activeId}"]`);
        if (!strip || !chip) return;
        const left = chip.offsetLeft;
        const right = left + chip.offsetWidth;
        if (left < strip.scrollLeft) {
            strip.scrollLeft = Math.max(0, left - 4);
        } else if (right > strip.scrollLeft + strip.clientWidth) {
            strip.scrollLeft = right - strip.clientWidth + 4;
        }
    }, [activeId, profiles.length]);

    const active = profiles.find(profile => profile.id === activeId) ?? profiles[0];
    const full = profiles.length >= AUDIO_PROFILE_LIMIT;

    const beginRename = () => {
        setDraftName(active.name);
        setRenaming(true);
    };

    const commitRename = () => {
        renameActive(draftName);
        setRenaming(false);
    };

    return (
        <div data-folia-profiles className="flex h-8 items-center gap-2">
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-[color:var(--st-t3)]">
                <Headphones size={12} />
                {t('ui.consoleProfiles')}
            </span>

            {renaming ? (
                <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5">
                    <TextField
                        autoFocus
                        value={draftName}
                        maxLength={AUDIO_PROFILE_NAME_MAX}
                        placeholder={t('ui.consoleProfileNamePlaceholder')}
                        aria-label={t('ui.consoleProfileNamePlaceholder')}
                        onChange={event => setDraftName(event.target.value)}
                        onFocus={event => event.currentTarget.select()}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') commitRename();
                            if (event.key === 'Escape') setRenaming(false);
                        }}
                        className="h-7 min-w-0 flex-1 rounded-lg border border-[var(--st-line)] bg-[var(--st-fill)] px-2.5 text-[13px] text-[color:var(--st-t1)] outline-none focus:border-[var(--st-accent)]"
                    />
                    <PanelIconButton size="s" label={t('ui.consoleProfileRenameSave')} onClick={commitRename}>
                        <Check size={14} />
                    </PanelIconButton>
                    <PanelIconButton size="s" label={t('ui.consoleProfileRenameCancel')} onClick={() => setRenaming(false)}>
                        <X size={14} />
                    </PanelIconButton>
                </div>
            ) : (
                <>
                    <div ref={stripRef} className="hide-scrollbar flex h-8 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
                        {profiles.map(profile => (
                            <Button
                                key={profile.id}
                                data-profile-id={profile.id}
                                onClick={() => switchTo(profile.id)}
                                aria-pressed={profile.id === activeId}
                                className={`st-t-fast h-7 max-w-[8.5rem] shrink-0 truncate whitespace-nowrap rounded-lg px-3 text-[13px] transition-[background-color,color,scale] active:scale-[0.96] ${profile.id === activeId
                                    ? 'bg-[var(--st-accent)] text-[color:var(--st-on-accent)]'
                                    : 'bg-[var(--st-fill)] text-[color:var(--st-t2)] hover:bg-[var(--st-fill2)] hover:text-[color:var(--st-t1)]'}`}
                            >
                                <span className="block truncate">{profile.name}</span>
                            </Button>
                        ))}
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5">
                        <PanelIconButton
                            size="s"
                            label={full ? t('ui.consoleProfileFull', { max: AUDIO_PROFILE_LIMIT }) : t('ui.consoleProfileAdd')}
                            disabled={full}
                            onClick={duplicateActive}
                        >
                            <Plus size={14} />
                        </PanelIconButton>
                        <PanelIconButton size="s" label={t('ui.consoleProfileRename')} onClick={beginRename}>
                            <Pencil size={13} />
                        </PanelIconButton>
                        <PanelIconButton
                            size="s"
                            label={t('ui.consoleProfileDelete')}
                            disabled={profiles.length <= 1}
                            onClick={() => setPendingDelete(true)}
                        >
                            <Trash2 size={13} />
                        </PanelIconButton>
                    </div>
                </>
            )}

            {pendingDelete && (
                <ConfirmDialog
                    isOpen
                    isDaylight={isDaylight}
                    title={t('ui.consoleProfileDeleteTitle', { name: active.name })}
                    description={t('ui.consoleProfileDeleteDescription')}
                    confirmText={t('ui.consoleProfileDeleteConfirm')}
                    confirmVariant="danger"
                    onConfirm={() => {
                        setPendingDelete(false);
                        deleteActive();
                    }}
                    onClose={() => setPendingDelete(false)}
                />
            )}
        </div>
    );
};

export default ProfileBar;
