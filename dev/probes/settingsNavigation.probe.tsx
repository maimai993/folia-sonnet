import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, Cpu, Database, Monitor, Settings2, Sparkles } from 'lucide-react';
import { SettingsAnchor, SettingsAnchorProvider, useSettingsAnchorList, useSettingsAnchorStore } from '../../src/components/modal/settings/navigation/SettingsAnchorContext';
import SettingsSectionHeading from '../../src/components/modal/settings/navigation/SettingsSectionHeading';
import SettingsSidebarChips from '../../src/components/modal/settings/navigation/SettingsSidebarChips';
import SettingsSidebarWide from '../../src/components/modal/settings/navigation/SettingsSidebarWide';
import { buildSettingsNavGroups, type SettingsSectionId } from '../../src/components/modal/settings/navigation/settingsNavModel';
import { useMediaQuery } from '../../src/hooks/useMediaQuery';
import { useSettingsScrollSpy } from '../../src/hooks/useSettingsScrollSpy';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { ProbeDefinition } from './definition';
// dev/probes/settingsNavigation.probe.tsx

/**
 * 设置弹窗的导航层：分组侧栏、二级锚点目录和 scrollspy。
 *
 * 只挂导航层，不挂真的 SettingsModal（它有近百个 props）。假内容列里的小节高度刻意拉开差距，
 * 并且有一个小节延迟三帧才出现，用来复刻 Integration 里那些等异步状态才渲染的区块 ——
 * 锚点必须自己补进目录，而且要落在正确的 DOM 位置而不是追加到末尾。
 * 探针页开着 StrictMode，正好压 register/unregister/register 这条最容易翻车的路径。
 */
const SECTIONS = [
    { id: 'alpha', label: 'Alpha Section', icon: Sparkles, height: 700 },
    { id: 'bravo', label: 'Bravo Section', icon: Monitor, height: 260 },
    { id: 'charlie', label: 'Charlie Section', icon: Cpu, height: 900 },
    { id: 'delta', label: 'Delta Section', icon: Database, height: 320 },
    { id: 'echo', label: 'Echo Section', icon: Boxes, height: 480 },
];

/** Stands in for a section gated on an async status that has not arrived yet. */
const LATE_SECTION = { id: 'bravoLate', label: 'Bravo Late Section', icon: Settings2, height: 300 };

const LABELS: Record<string, string> = {
    'options.settingsGroupAppearance': 'Appearance',
    'options.settingsGroupControls': 'Controls',
    'options.settingsGroupConnections': 'Connections & Data',
    'options.settingsGroupSystem': 'System',
};

/** Stands in for i18n so the probe reads the same as the shipped English copy. */
const fakeTranslate = (key: string): string => LABELS[key] ?? (key.split('.').pop() ?? key);

const useDelayedMount = (frames: number): boolean => {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        let remaining = frames;
        let raf = 0;
        const tick = () => {
            remaining -= 1;
            if (remaining <= 0) {
                setMounted(true);
                return;
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [frames]);

    return mounted;
};

const ProbeBody: React.FC = () => {
    const store = useSettingsAnchorStore();
    const anchors = useSettingsAnchorList(store);
    const contentRef = useRef<HTMLDivElement>(null);
    const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance');
    const isWide = useMediaQuery('(min-width: 768px)');
    const showLate = useDelayedMount(4);

    const groups = useMemo(() => buildSettingsNavGroups(fakeTranslate, { isElectron: true }), []);
    const { activeAnchorId, scrollToAnchor } = useSettingsScrollSpy({
        containerRef: contentRef,
        anchors,
        enabled: isWide,
        reducedMotion: false,
    });

    useEffect(() => {
        if (contentRef.current) {
            contentRef.current.scrollTop = 0;
        }
    }, [activeSection]);

    return (
        <SettingsAnchorProvider store={store}>
            <div
                className="h-screen bg-zinc-950 p-6"
                style={{
                    '--text-primary': DEFAULT_THEME.primaryColor,
                    '--text-secondary': DEFAULT_THEME.secondaryColor,
                } as React.CSSProperties}
            >
                <div className="flex h-full flex-col gap-4 md:flex-row md:gap-6">
                    {isWide ? (
                        <SettingsSidebarWide
                            groups={groups}
                            activeSectionId={activeSection}
                            onSelectSection={setActiveSection}
                            anchors={anchors}
                            activeAnchorId={activeAnchorId}
                            onSelectAnchor={scrollToAnchor}
                            isDaylight={false}
                            reducedMotion={false}
                            theme={DEFAULT_THEME}
                        />
                    ) : (
                        <SettingsSidebarChips
                            groups={groups}
                            activeSectionId={activeSection}
                            onSelectSection={setActiveSection}
                            isDaylight={false}
                        />
                    )}
                    <div ref={contentRef} data-probe-content className="relative flex-1 overflow-y-auto pb-4 pl-2 pr-4">
                        <div className="space-y-8">
                            {SECTIONS.map(section => (
                                <React.Fragment key={section.id}>
                                    <SettingsAnchor anchorId={section.id} label={section.label}>
                                        <SettingsSectionHeading icon={section.icon} label={section.label} />
                                        <div
                                            className="rounded-xl border border-white/10 bg-white/5"
                                            style={{ height: section.height }}
                                        />
                                    </SettingsAnchor>
                                    {section.id === 'bravo' && showLate && (
                                        <SettingsAnchor anchorId={LATE_SECTION.id} label={LATE_SECTION.label}>
                                            <SettingsSectionHeading icon={LATE_SECTION.icon} label={LATE_SECTION.label} />
                                            <div
                                                className="rounded-xl border border-white/10 bg-white/5"
                                                style={{ height: LATE_SECTION.height }}
                                            />
                                        </SettingsAnchor>
                                    )}
                                </React.Fragment>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </SettingsAnchorProvider>
    );
};

const probe: ProbeDefinition = {
    id: 'settingsNavigation',
    title: '设置导航·分组侧栏与二级目录',
    description: '分组副标题、二级锚点目录、scrollspy，以及窄屏 chip 条不被分组结构影响',
    Component: ProbeBody,
};

export default probe;
