import React from 'react';
import type { ProbeDefinition } from './definition';
import { PlatformIcon } from '../../src/components/shared/platformIcons/PlatformIcon';
import { PLATFORM_ICONS } from '../../src/components/shared/platformIcons/registry';
import { PlatformMark } from '../../src/components/login/PlatformMark';
import type { OnlineProviderId } from '../../src/types/onlineMusic';

// dev/probes/platformIcons.probe.tsx
/**
 * 自绘的平台图标（issue #451）在四种尺寸、浅底与深底上的样子。
 *
 * 项目里已经没有任何第三方平台的位图：图标一律由 components/shared/platformIcons 按平台 id 现画，
 * 安卓通知栏的角标也是从同一份几何生成的纯白剪影。这里要看的几件事：
 *
 * 1. 16 / 24 / 32 / 48 四档都还认得出（16px 时描边只有 1px，最细的三角与最小的符头最容易糊掉）；
 * 2. 圆形裁切下没有被切掉的笔画（内容框留白够不够）；
 * 3. 摆在一起是一组：底板圆角、留白、描边粗细一致；
 * 4. 没登记的来源回落成「字 + 颜色」，出现一个空洞就是错（右下角那两格）。
 */

const SIZES = [16, 24, 32, 48] as const;

/** 没登记的来源：mod 加进来的平台与本地曲库都走这一条。 */
const UNREGISTERED: Array<{ id: string; label: string }> = [
    { id: 'local', label: '本地' },
    { id: 'mod.someone.player', label: 'MP' },
];

const Cell: React.FC<{ caption: string; children: React.ReactNode }> = ({ caption, children }) => (
    <div className="flex w-[96px] flex-col items-center gap-2">
        <div className="flex h-14 items-end justify-center">{children}</div>
        <span className="text-[11px] text-[color:var(--st-t3)]">{caption}</span>
    </div>
);

const Row: React.FC<{ title: string; tone: 'light' | 'dark'; children: React.ReactNode }> = ({ title, tone, children }) => (
    <section
        className={`rounded-xl p-5 ${tone === 'dark' ? 'bg-[#141821] text-white' : 'bg-[#f4f5f7] text-[#20242c]'}`}
        data-probe-row={tone}
    >
        <h2 className="mb-4 text-sm font-semibold">{title}</h2>
        <div className="flex flex-wrap gap-4">{children}</div>
    </section>
);

const Probe: React.FC = () => (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5 p-6">
        {(['light', 'dark'] as const).map(tone => (
            <Row key={tone} title={`自绘图标 · ${tone === 'light' ? '浅底' : '深底'} · 四种尺寸与圆形裁切`} tone={tone}>
                {PLATFORM_ICONS.map(entry => (
                    <Cell key={entry.id} caption={entry.id}>
                        <div className="flex items-end gap-3">
                            <PlatformIcon platformId={entry.id} size={SIZES[0]} />
                            <PlatformIcon platformId={entry.id} size={SIZES[1]} />
                            <PlatformIcon platformId={entry.id} size={SIZES[2]} round />
                            <PlatformIcon platformId={entry.id} size={SIZES[3]} round />
                        </div>
                    </Cell>
                ))}
            </Row>
        ))}

        {/* 平台记号（登录窗口、切换器、资料库徽章都画它）：有图形的画图形，没登记的画字 + 颜色。 */}
        <Row title="平台记号：登记过的画图形，没登记的回落「字 + 颜色」" tone="light">
            {[...PLATFORM_ICONS.map(entry => ({ id: entry.id as string, label: entry.id })), ...UNREGISTERED].map(({ id, label }) => (
                <Cell key={id} caption={label}>
                    <div className="flex items-end gap-3">
                        <PlatformMark providerId={id as OnlineProviderId} label={label} size={16} />
                        <PlatformMark providerId={id as OnlineProviderId} label={label} size={24} />
                        <PlatformMark providerId={id as OnlineProviderId} label={label} size={32} />
                        <PlatformMark providerId={id as OnlineProviderId} label={label} size={48} />
                    </div>
                </Cell>
            ))}
        </Row>

        {/* 一行排开看「是不是一组」：圆角、留白、描边粗细应该一致。 */}
        <Row title="排成一行：底板圆角、留白与描边粗细应当一致" tone="light">
            <div className="flex flex-wrap items-center gap-3">
                {PLATFORM_ICONS.map(entry => (
                    <PlatformIcon key={entry.id} platformId={entry.id} size={32} label={entry.id} />
                ))}
            </div>
            <p className="mt-3 w-full text-[12px] text-[color:var(--st-t2)]">
                同一份几何还转成了安卓通知栏的纯白剪影（res/drawable/ic_provider_*.xml），
                npm run build:provider-badges 生成，改了图形忘了重新生成时单测会红。
            </p>
        </Row>
    </div>
);

const probe: ProbeDefinition = {
    id: 'platformIcons',
    title: '自绘的平台图标',
    description: '四种尺寸与圆形裁切下认不认得出、排在一起是不是一组、没登记的来源回落成字 + 颜色',
    Component: Probe,
};

export default probe;
