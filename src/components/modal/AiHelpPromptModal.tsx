import { useMemo, useState } from 'react';
import { BookOpen, Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Sheet, SheetButton } from '../shared/Sheet';
import { Group, Row, Value, type SettingsGroupDef } from './settings/kit';
import { copyText } from '../../utils/system/clipboard';
import { openOutsideLink } from '../../utils/system/outsideLink';
import { iconLabel } from './settings/pages/iconLabel';

// src/components/modal/AiHelpPromptModal.tsx
// The 遇到问题？ dialog of the Help page: where to read and where to ask, and a prompt to copy for
// an AI model, which names the guide and the repository.

const FOLIA_GUIDE_URL = 'https://folia-site.cielaniska.top/guide/llm-routing';
const FOLIA_DOCS_URL = 'https://folia-site.cielaniska.top/guide/';
// fork 的仓库，不是上游 chthollyphile/folia-major —— 同步上游时被带回原版过，
// 别再让它落回去。
const FOLIA_REPOSITORY_URL = 'https://github.com/Folia-CE/folia-sonnet';

const LINKS: SettingsGroupDef = { id: 'aiHelpLinks', titleKey: 'aiHelp.title' };
const ASK_AI: SettingsGroupDef = { id: 'aiHelpPrompt', titleKey: 'aiHelp.askAiTitle' };

type AiHelpPromptModalProps = {
    isOpen: boolean;
    isDaylight: boolean;
    onClose: () => void;
};

export const AiHelpPromptModal: React.FC<AiHelpPromptModalProps> = ({
    isOpen,
    isDaylight,
    onClose,
}) => {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);

    const prompt = useMemo(() => t('aiHelp.prompt', {
        guideUrl: FOLIA_GUIDE_URL,
        repoUrl: FOLIA_REPOSITORY_URL,
        defaultValue: [
            'I am using Folia and need help with a problem.',
            '',
            `Folia Guide: ${FOLIA_GUIDE_URL}`,
            `Folia repository: ${FOLIA_REPOSITORY_URL}`,
            '',
            'Please read these references as context, then help me understand and solve the problem I describe next. Ask for any missing details before making assumptions, and give me steps I can try safely.'
        ].join('\n')
    }), [t]);

    const handleCopyPrompt = async () => {
        try {
            await copyText(prompt);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch (error) {
            console.error('Failed to copy AI help prompt:', error);
            setCopied(false);
        }
    };

    return (
        <Sheet
            isOpen={isOpen}
            onClose={onClose}
            isDaylight={isDaylight}
            size="m"
            title={t('aiHelp.title')}
            footer={(
                <>
                    <SheetButton onClick={onClose}>{t('ui.cancel')}</SheetButton>
                    <SheetButton variant="primary" onClick={() => void handleCopyPrompt()}>
                        {/* Both states lie in one cell, so the button keeps its width when its text changes. */}
                        <span className="grid justify-items-center">
                            <span className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 ${copied ? 'invisible' : ''}`}>
                                <Copy size={14} />
                                {t('aiHelp.copyPrompt')}
                            </span>
                            <span className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 ${copied ? '' : 'invisible'}`}>
                                <Check size={14} />
                                {t('status.copied')}
                            </span>
                        </span>
                    </SheetButton>
                </>
            )}
        >
            {/* A group keeps the space a settings page has above its first card; here the sheet's own padding is that space. */}
            <div className="-mt-5">
                <Group def={LINKS} bare>
                    <Row label={iconLabel(BookOpen, t('aiHelp.docsTitle'))} onClick={() => openOutsideLink(FOLIA_DOCS_URL)}>
                        <Value>{t('aiHelp.openDocs')}</Value>
                    </Row>
                    {/*
                     * 以前这里还有一条 Discord 社区（论坛）入口，按用户要求删掉。
                     * 别再从 shared/discordCommunity 或 help.communityDiscord / aiHelp.discordTitle
                     * 把它接回来 —— 上游合并最容易把这类「本来就没有」的入口带回来。
                     */}
                </Group>
                <Group def={ASK_AI} foot={t('aiHelp.usageHint')}>
                    <pre className="select-text whitespace-pre-wrap break-words px-4 py-3.5 font-mono text-xs leading-[19px] text-[color:var(--st-t1)]">
                        {prompt}
                    </pre>
                </Group>
            </div>
        </Sheet>
    );
};
