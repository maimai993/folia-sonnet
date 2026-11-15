import React, { useRef } from 'react';
import { Disc } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SongResult } from '../../../types';
import { getProviderSongMetadata } from '../../../services/onlineMusic/songMetadata';
import { getSizedCoverUrl } from '../../../utils/coverUrl';
import { LikeButton, type SongLike } from './LikeButton';
import { useIsWideShortViewport } from './panelViewport';
import { useMeasuredSize } from './useMeasuredSize';
import { Button } from '../../ui';

// src/components/panelTab/shell/SongHeader.tsx
// The playing song at the top of the panel. On the cover tab it is the large cover with what the
// caller puts under it (title, artists, album, the row of actions). On every other tab it folds to
// one line: a small cover, title, artist and the heart; a press on that line goes to the cover tab.
// Both forms are in the document at once, so the cover can grow and shrink between them.

/** The height of the folded line, and the side of its cover. */
export const FOLDED_PX = 48;
/**
 * 封面与下面文字块之间的距离（上游 14px）。
 *
 * 这几个尺寸一律用 rem，不用 px —— 界面缩放动的是**根字号**：androidPhoneFit.css 里
 * `html` 的 font-size 跟着 `--folia-ui-scale-*` 走，而 Tailwind 的间距、字号、圆角大多
 * 按 rem 算，于是会跟着一起缩。写死 px 的话，滑条拉到底这两处也一动不动：面板缩了、
 * 封面不缩，比例散掉，按钮就叠到一块去了。
 *
 * 数值按 1rem = 16px 折算，与上游原本的 px 一一对齐。
 */
const COVER_GAP = '0.875rem';
/** The large cover is never lower than this, however short the window. */
const MIN_COVER = '6rem';
/**
 * 整个封面页签（大封面 + 下面那块文字）的高度上限。
 *
 * 上游没有这一道：窗口一高，封面就一路顶到 336px，手机上几乎占掉一屏。留着它 ——
 * 这就是「手机没那么大」要的那一下。
 *
 * 30rem（480px）：封面改成正方形之后，铺满面板内宽（336）那一格自己就要 336 高，
 * 20.625rem 会把边长压到 200 上下，看着像凭空小了一圈。
 */
const COVER_TAB_MAX = '30rem';
/**
 * 大封面的**边长**上限：铺满面板内宽。
 *
 * 上游这里写的是高度的 70%（约 208px），宽度却是 100% —— 那一格是个 336×208 的长方形，
 * 而 `object-cover` 是按格子裁的，方形封面上下各有 60 多像素被切掉：「封面显示不全」
 * 就是这么来的。改成正方形（宽 = 高），方形封面一格正好放得下整张。
 */
const COVER_MAX = '100cqw';
/** 矮而宽时封面挪到左边，边长压到这个尺寸：右边还要留出写歌名、摆按钮的地方。 */
const COMPACT_COVER_MAX = 'min(26cqw, 8rem)';

type SongHeaderProps = {
    /** The cover tab is open: the large form. */
    isBig: boolean;
    currentSong: SongResult | null;
    coverUrl: string | null;
    like: SongLike;
    /** Goes to the cover tab. */
    onShowCover: () => void;
    /** What stands under the large cover. */
    children: React.ReactNode;
};

const SongHeader: React.FC<SongHeaderProps> = ({ isBig, currentSong, coverUrl, like, onShowCover, children }) => {
    const { t } = useTranslation();
    const underRef = useRef<HTMLDivElement>(null);
    const under = useMeasuredSize(underRef);
    // 矮而宽（横过来的手机）：封面挪到左边，文字与按钮排在它右边。竖着叠要占两截高度，
    // 横着放只占一截 —— 那种窗口缺的正是纵向。
    // （判定本身不能写成 `isBig && use…`：短路会让这个 hook 在收起态不执行，hooks 的顺序就散了。）
    const isWideShort = useIsWideShortViewport();
    const sideBySide = isBig && isWideShort;
    const artists = (currentSong ? getProviderSongMetadata(currentSong).artists : []).map(artist => artist.name).join(' / ');
    /*
     * 回到上游的**两段式**：可用高度（--pn-room）先让出文字块那一截，剩下的全给封面，
     * 页签整高 = 封面 + 文字块两段。
     *
     * 之前为了压矮整个页签，把文字挪去压在封面底边上（页签只剩封面那么高）—— 屏一矮，
     * 封面就缩到下限，文字与下面那排按钮挤在同一条里，于是互相重叠。
     * 改回两段：封面归封面，歌名/歌手和那一排按钮排在它下面，各占各的位置。
     *
     * 上面那几个常量用 rem 而不是 px：界面缩放动的是根字号，rem 会跟着一起缩，
     * px 不会 —— 手机上正是这个「各缩各的」把按钮挤到一块的。
     */
    const underPx = `calc(${COVER_GAP} + ${under.height}px)`;
    /**
     * 封面的**边长**（宽 = 高）。
     *
     * 并排时它不与文字抢高度，所以不用减掉文字那一截；叠着放才要减。
     * 两种排法的总高也不同：并排取两者较大的那个，叠着放是相加。
     */
    const coverSide = `clamp(${MIN_COVER}, calc(min(var(--pn-room), ${COVER_TAB_MAX})${sideBySide ? '' : ` - ${underPx}`}), ${sideBySide ? COMPACT_COVER_MAX : COVER_MAX})`;
    const bigHeight = sideBySide ? `max(${coverSide}, ${under.height}px)` : `calc(${coverSide} + ${underPx})`;

    return (
        <header
            // 矮而宽时不过渡高度：横屏的封面尺寸由 --pn-room（跟底栏位置走的 MotionValue）与下面
            // 那块文字的高度（量出来才知道）共同决定，这两个数落在不同的帧上，再叠一层 height 过渡
            // 就会看到封面先跳一下再归位。横屏不缺宽度，封面尺寸本来就是被 COMPACT_COVER_MAX 卡住的
            // 固定值，直接给最终值，进出由面板自己的 unfold 动画负责。
            className={`st-t-unfold relative shrink-0 overflow-hidden ${isWideShort ? 'transition-none' : 'transition-[height]'}`}
            style={{ height: isBig ? bigHeight : FOLDED_PX }}
        >
            {/* The cover is where the lessons about this panel's song buttons point (data-ponder-panel-artwork). */}
            <div
                data-ponder-panel-artwork
                onClick={isBig ? undefined : onShowCover}
                // 正方形：宽高同一个数，方形封面才放得下整张（见 COVER_MAX 的注释）。
                // 叠着放时居中（左右会剩下两条边），并排时贴左。
                className={`st-t-unfold absolute top-0 grid place-items-center overflow-hidden bg-[var(--st-fill)] ${isWideShort ? 'transition-[border-radius]' : 'transition-[width,height,border-radius]'} ${isBig
                    ? `rounded-[10px] ${sideBySide ? 'left-0' : 'left-0 right-0 mx-auto'}`
                    : 'left-0 cursor-pointer rounded-lg'}`}
                style={isBig ? { width: coverSide, height: coverSide } : { width: FOLDED_PX, height: FOLDED_PX }}
            >
                {coverUrl ? (
                    <img src={getSizedCoverUrl(coverUrl, 512)} alt="Art" decoding="async" className="h-full w-full object-cover" />
                ) : (
                    <Disc size={isBig ? 40 : 20} className="text-[color:var(--st-t3)]" />
                )}
                <span className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_var(--st-line)]" />
            </div>

            <Button
                // A new song's line comes in as a page of the kit does.
                key={currentSong?.id ?? ''}
                onClick={onShowCover}
                inert={isBig}
                className={`st-page-in st-t-move absolute left-[60px] right-11 top-[5px] flex flex-col text-left transition-[opacity,translate] ${isBig ? '-translate-y-1 opacity-0' : ''}`}
            >
                <span className="truncate text-sm font-semibold leading-5">{currentSong?.name || t('ui.noTrack')}</span>
                <span className="truncate text-xs leading-[18px] text-[color:var(--st-t2)]">{artists}</span>
            </Button>
            <LikeButton
                like={like}
                className={`st-t-move absolute right-0 top-2 transition-[opacity,translate,visibility] ${isBig ? 'invisible -translate-y-1 opacity-0' : ''}`}
            />

            <div
                inert={!isBig}
                className={`absolute bottom-0 right-1 transition-[opacity,translate,visibility] ${sideBySide ? 'top-0 flex flex-col justify-center' : 'left-1'} ${isBig ? 'st-t-move' : 'st-t-fast invisible translate-y-2 opacity-0'}`}
                style={sideBySide ? { left: `calc(${coverSide} + ${COVER_GAP})` } : undefined}
            >
                {/*
                 * 量的是里面这一层，不是外面那层：并排时外面那层被拉满整个 header 的高度，
                 * 量它等于量自己撑出来的结果（文字一多就永远量不出来，只会被裁掉）。
                 */}
                <div ref={underRef} className={sideBySide ? 'w-fit' : undefined}>
                    {children}
                </div>
            </div>
        </header>
    );
};

export default SongHeader;
