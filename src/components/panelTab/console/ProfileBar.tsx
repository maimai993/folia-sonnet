import React, { useRef, useState } from 'react';
import { Check, Ellipsis, Headphones, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AUDIO_PROFILE_LIMIT, AUDIO_PROFILE_NAME_MAX } from '../../../utils/audioProfiles';
import { useAudioProfilesStore } from '../../../stores/useAudioProfilesStore';
import ConfirmDialog from '../../shared/ConfirmDialog';
import { Menu } from '../../modal/settings/kit';
import { Button } from '../../ui';
import TextField from '../../ui/TextField';
import PanelIconButton from '../shell/PanelIconButton';

// src/components/panelTab/console/ProfileBar.tsx
// 「耳机方案」那一段：芯片切换 + 三个动作（复制 / 改名 / 删除）。
//
// 它不单独占一行，而是和页签并排在同一条工具行里（见 ConsoleToolbar）：窄窗上一条
// 就够，两条会把正文顶掉一大截。高度钉死 28px，改名时输入框就地替换芯片条，整行不跳。

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
    // 三个动作收进一枚「⋯」：并排放在手机上是 93px，等于一套半方案，芯片本该滚起来的位置全被它们占了。
    const [menuOpen, setMenuOpen] = useState(false);
    const menuAnchor = useRef<HTMLButtonElement>(null);

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
        <div data-folia-profiles className="flex min-w-0 items-center gap-1 px-0.5 max-sm:flex-1">
            {/* 窄窗不写「耳机方案」四个字：这一行还要放芯片与三个动作，四个字占掉的宽度
                正好是一枚芯片。文字留给读屏。 */}
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-[color:var(--st-t3)] max-sm:sr-only">
                <Headphones size={11} aria-hidden />
                {t('ui.consoleProfiles')}
            </span>

            {renaming ? (
                <div className="flex h-7 min-w-0 flex-1 items-center gap-1">
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
                    <div
                        className="flex min-w-0 shrink flex-wrap items-center justify-end gap-1 max-sm:justify-start"
                    >
                        {profiles.map(profile => (
                            <Button
                                key={profile.id}
                                data-profile-id={profile.id}
                                onClick={() => switchTo(profile.id)}
                                aria-pressed={profile.id === activeId}
                                className={`st-t-fast h-7 max-w-[9rem] shrink-0 truncate whitespace-nowrap rounded-lg px-2.5 text-[12.5px] transition-[background-color,color,scale] active:scale-[0.96] ${profile.id === activeId
                                    ? 'bg-[var(--st-accent)] font-medium text-[color:var(--st-on-accent)] shadow-[0_1px_2px_rgba(0,0,0,0.18)]'
                                    : 'bg-[var(--st-fill)] text-[color:var(--st-t2)] hover:bg-[var(--st-fill2)] hover:text-[color:var(--st-t1)]'}`}
                            >
                                <span className="block truncate">{profile.name}</span>
                            </Button>
                        ))}

                        {/* 分隔线跟着「⋯」走：芯片换行时它落在最后一行的末尾，不会孤零零吊在右边一列。 */}
                        <span aria-hidden className="ml-0.5 h-4 w-px shrink-0 bg-[var(--st-line)]" />
                    <PanelIconButton
                        ref={menuAnchor}
                        size="s"
                        label={t('ui.consoleProfileActions')}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen(open => !open)}
                    >
                        <Ellipsis size={15} />
                    </PanelIconButton>
                    <Menu
                        anchorRef={menuAnchor}
                        open={menuOpen}
                        onClose={() => setMenuOpen(false)}
                        label={t('ui.consoleProfileActions')}
                        align="end"
                        items={[
                            {
                                id: 'copy',
                                label: full ? t('ui.consoleProfileFull', { max: AUDIO_PROFILE_LIMIT }) : t('ui.consoleProfileAdd'),
                                icon: Plus,
                                disabled: full,
                                onSelect: duplicateActive,
                            },
                            { id: 'rename', label: t('ui.consoleProfileRename'), icon: Pencil, onSelect: beginRename },
                            {
                                id: 'delete',
                                label: t('ui.consoleProfileDelete'),
                                icon: Trash2,
                                disabled: profiles.length <= 1,
                                onSelect: () => setPendingDelete(true),
                            },
                        ]}
                    />
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
