import React from 'react';
import { AudioLines } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isCapacitorAndroid } from '../../platform/runtime';
import { useWebAudioSignal } from './useWebAudioSignal';

// 复用信号通路 Sheet 的 Web Audio 内容：顶上写转码播放还是 Web 引擎，下面是应用转码与系统输出，未测量的环节不作直通保证。
//
// 安卓上换成原生那一份：壳里没有 Web Audio 播放链，这段文字每一句都会写错（见 NativePlayerSignalPath）。

const WebAudioRoute: React.FC = () => {
    const { t } = useTranslation();
    const signal = useWebAudioSignal();
    return (
        <>
            <section className="flex items-start gap-3 rounded-xl bg-[var(--st-card)] px-4 py-3.5 shadow-[0_0_0_1px_var(--st-line)]">
                <AudioLines size={22} aria-hidden className="mt-0.5 shrink-0 text-[color:var(--st-accent)]" />
                <div>
                    <p role="status" className="text-lg font-semibold leading-7">
                        {t(signal.transcode === 'transcoded' ? 'hifi.route.transcoded' : 'hifi.route.webEngine')}
                    </p>
                    <p className="mt-0.5 text-[13px] leading-5 text-[color:var(--st-t2)]">{t(signal.active ? 'hifi.web.engineDesc' : 'hifi.web.noSource')}</p>
                </div>
            </section>
            <dl className="mt-5 space-y-4 px-1 text-sm">
                <div>
                    <dt className="font-semibold">{t('hifi.web.transcodeLabel')}</dt>
                    <dd className="mt-1 text-[color:var(--st-t2)]">{t(`hifi.web.${signal.transcode}`)}</dd>
                    {signal.mimeType && <dd className="mt-1 font-mono text-xs text-[color:var(--st-t3)]">{signal.mimeType}</dd>}
                </div>
                <div>
                    <dt className="font-semibold">{t('hifi.web.outputLabel')}</dt>
                    <dd className="mt-1 text-[color:var(--st-t2)]">{t('hifi.web.outputDesc')}</dd>
                </div>
            </dl>
        </>
    );
};

/**
 * 安卓的原生链路。
 *
 * 这一屏要回答的还是同一个问题 ——「我听到的声音在路上被动了什么」—— 只是这条路没有
 * mpv 也没有 Web Audio：源文件由 ExoPlayer 解，中间挂着均衡器和过渡 DSP，最后交给
 * AudioTrack，采样率由系统混音器定。所以这里不承诺直通，只如实说哪一级做了什么。
 */
const NativePlayerRoute: React.FC = () => {
    const { t } = useTranslation();
    // 转码那一行仍然有用：歌可能是 Folia 自己转出来的副本，那也算这一级动过。
    const signal = useWebAudioSignal();
    return (
        <>
            <section className="flex items-start gap-3 rounded-xl bg-[var(--st-card)] px-4 py-3.5 shadow-[0_0_0_1px_var(--st-line)]">
                <AudioLines size={22} aria-hidden className="mt-0.5 shrink-0 text-[color:var(--st-accent)]" />
                <div>
                    <p role="status" className="text-lg font-semibold leading-7">{t('hifi.native.title')}</p>
                    <p className="mt-0.5 text-[13px] leading-5 text-[color:var(--st-t2)]">{t(signal.active ? 'hifi.native.desc' : 'hifi.web.noSource')}</p>
                </div>
            </section>
            <dl className="mt-5 space-y-4 px-1 text-sm">
                <div>
                    <dt className="font-semibold">{t('hifi.native.decodeLabel')}</dt>
                    <dd className="mt-1 text-[color:var(--st-t2)]">{t('hifi.native.decodeDesc')}</dd>
                </div>
                <div>
                    <dt className="font-semibold">{t('hifi.native.processLabel')}</dt>
                    <dd className="mt-1 text-[color:var(--st-t2)]">{t('hifi.native.processDesc')}</dd>
                </div>
                <div>
                    <dt className="font-semibold">{t('hifi.web.transcodeLabel')}</dt>
                    <dd className="mt-1 text-[color:var(--st-t2)]">{t(`hifi.web.${signal.transcode}`)}</dd>
                    {signal.mimeType && <dd className="mt-1 font-mono text-xs text-[color:var(--st-t3)]">{signal.mimeType}</dd>}
                </div>
                <div>
                    <dt className="font-semibold">{t('hifi.native.outputLabel')}</dt>
                    <dd className="mt-1 text-[color:var(--st-t2)]">{t('hifi.native.outputDesc')}</dd>
                </div>
            </dl>
            <p className="mt-4 px-1 text-xs leading-5 text-[color:var(--st-t3)]">{t('hifi.native.note')}</p>
        </>
    );
};

export const WebAudioSignalPath: React.FC = () => (
    isCapacitorAndroid() ? <NativePlayerRoute /> : <WebAudioRoute />
);
