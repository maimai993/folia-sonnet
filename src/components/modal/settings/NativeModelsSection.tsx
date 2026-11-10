// src/components/modal/settings/NativeModelsSection.tsx
//
// Automix 分析模型的「原生」状态区块（安卓 App）。
//
// 与上游（Electron）那一版最大的不同：**没有下载**。
// 两个权重打在 APK 的 assets 里（约 182MB），用户装上就已经拥有它们；
// 首次用到某个模型时，原生侧把它从 assets 拷到应用私有目录
// （ONNX Runtime 要真实文件路径），71ms 一次，之后一直用那份。
//
// 所以这个区块只做三件事：说清楚每个模型是什么、有多大、现在能不能用，
// 以及一个「准备好」按钮（把 assets 落盘）。没有镜像、没有网盘、没有失败重试 ——
// 那些都是「需要联网取权重」才存在的问题，这里根本不存在。

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Cpu, Loader2, Music2, Sparkles } from 'lucide-react';
import { Button } from '../../ui';
import {
    fetchModelsStatus,
    installModel,
    isNativeModelsAvailable,
    onModelProgress,
    progressPercent,
    refreshModelAvailability,
    type AutomixModelInfo,
    type AutomixModelName,
    type AutomixModelProgress,
} from '../../../services/automix/nativeModels';

/** 字节数 → 人读的 MB。这里的量级都是几十上百 MB。 */
const megabytes = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;

/** 一个模型能开什么功能。不是一对一（分轨同时开 automix 的分轨与动感模式的鼓点）。 */
const scopesOf = (name: AutomixModelName): { key: string; fallback: string; Icon: typeof Sparkles }[] => (
    name === 'htdemucs'
        ? [
            { key: 'options.modelScopeStems', fallback: '四轨分离', Icon: Music2 },
            { key: 'options.modelScopePerformance', fallback: '智能过渡', Icon: Sparkles },
        ]
        : [{ key: 'options.modelScopeBeatGrid', fallback: '节拍网格', Icon: Cpu }]
);

const titleOf = (name: AutomixModelName): { key: string; fallback: string } => (
    name === 'beat_this'
        ? { key: 'options.modelBeatThis', fallback: '节拍分析（Beat This!）' }
        : { key: 'options.modelHtdemucs', fallback: '四轨分离（htdemucs）' }
);

const NativeModelsSection: React.FC = () => {
    const { t } = useTranslation();
    const [models, setModels] = React.useState<AutomixModelInfo[] | null>(null);
    const [busy, setBusy] = React.useState<AutomixModelName | null>(null);
    const [progress, setProgress] = React.useState<AutomixModelProgress | null>(null);
    const [failure, setFailure] = React.useState<string | null>(null);

    const refresh = React.useCallback(async () => {
        const status = await fetchModelsStatus();
        if (status) {
            setModels(status.models);
            await refreshModelAvailability();
        }
    }, []);

    React.useEffect(() => {
        if (!isNativeModelsAvailable()) return;
        void refresh();
        return onModelProgress((event) => {
            setProgress(event);
            if (event.status !== 'downloading') void refresh();
        });
    }, [refresh]);

    // 非安卓（浏览器预览、桌面）没有这套能力，整块不画。
    if (!isNativeModelsAvailable()) return null;

    // 第一次查询还没回来时也不画 —— 一个空标题比闪一下更糟。
    if (!models) return null;

    const prepare = async (name: AutomixModelName) => {
        setBusy(name);
        setFailure(null);
        setProgress(null);
        const ok = await installModel(name);
        if (!ok) setFailure(t('options.modelPrepareFailed', '准备失败，请检查存储空间'));
        setBusy(null);
        setProgress(null);
        await refresh();
    };

    return (
        <section className="space-y-3">
            <header className="space-y-1">
                <h3 className="text-[13px] font-medium text-[var(--st-t1)]">
                    {t('options.modelsTitle', '分析模型')}
                </h3>
                <p className="text-[11.5px] leading-relaxed text-[var(--st-t2)]">
                    {t(
                        'options.modelsBundledDesc',
                        '这两个模型已内置在安装包里，不需要下载。首次使用时会在本机准备一下（几秒钟）。',
                    )}
                </p>
            </header>

            {models.map((model) => {
                const title = titleOf(model.name);
                const live = progress && progress.name === model.name ? progress : null;
                const running = busy === model.name;
                const percent = running ? progressPercent(live) : 0;

                return (
                    <div
                        key={model.name}
                        className="rounded-lg border border-[color:var(--st-line2)] px-3 py-2.5 space-y-2"
                    >
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--st-t1)]">
                                    {model.ready && <Check size={13} className="shrink-0 text-[var(--st-ok)]" />}
                                    <span className="truncate">{t(title.key, title.fallback)}</span>
                                    <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--st-t3)]">
                                        {megabytes(model.bytes)}
                                    </span>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                    {scopesOf(model.name).map(({ key, fallback, Icon }) => (
                                        <span
                                            key={key}
                                            className="inline-flex items-center gap-1 rounded-full bg-[var(--st-fill)] px-1.5 py-0.5 text-[10px] text-[var(--st-t2)]"
                                        >
                                            <Icon size={10} />
                                            {t(key, fallback)}
                                        </span>
                                    ))}
                                </div>
                            </div>

                            {model.ready ? (
                                <span className="shrink-0 text-[11px] text-[var(--st-t2)]">
                                    {t('options.modelReady', '已就绪')}
                                </span>
                            ) : running ? (
                                <Button variant="quiet" disabled>
                                    <Loader2 size={12} className="animate-spin" />
                                    {percent > 0 ? `${Math.round(percent)}%` : t('options.modelPreparing', '准备中')}
                                </Button>
                            ) : (
                                <Button variant="quiet" onClick={() => void prepare(model.name)}>
                                    {t('options.modelPrepare', '准备')}
                                </Button>
                            )}
                        </div>

                        {running && (
                            <div className="h-1 overflow-hidden rounded-full bg-[var(--st-fill)]">
                                <div
                                    className="h-full rounded-full bg-[var(--st-accent)] transition-[width] duration-200"
                                    style={{ width: `${percent}%`, opacity: 0.7 }}
                                />
                            </div>
                        )}
                    </div>
                );
            })}

            {failure && (
                <p className="text-[11px] text-[var(--st-err)]">{failure}</p>
            )}
        </section>
    );
};

export default NativeModelsSection;
