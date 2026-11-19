import {
    type AudioConsoleCompressorBand,
} from './model';
import {
    AUDIO_CONSOLE_KNEE_MIN,
} from './defaults';

// 供压缩器面板显示的静态传输曲线。
/**
 * 一段压缩的静态曲线：给定输入电平，返回输出电平（dB）。
 *
 * 只用于画出那条折线；真正的压缩在原生侧按块算，两条曲线用的是同一组
 * 阈值 / 比率 / 软拐点宽度，所以界面上看到的就是听到的。
 *
 * `mix` 不参与这条曲线：它决定的是「压过的信号混回多少」，画在曲线上会把
 * 一条本该是折线的形状压成两条线的加权平均，反而看不出拐点在哪。
 */
export const compressorTransferDb = (inputDb: number, band: AudioConsoleCompressorBand): number => {
    if (!band.enabled || band.ratio <= 1.001) return inputDb;
    const knee = Math.max(AUDIO_CONSOLE_KNEE_MIN, band.kneeDb);
    const over = inputDb - band.thresholdDb;
    const reduction = over <= -knee / 2
        ? 0
        : over < knee / 2
            ? (1 / band.ratio - 1) * (over + knee / 2) * (over + knee / 2) / (2 * knee)
            : (1 / band.ratio - 1) * over;
    return inputDb + reduction + band.makeupDb;
};

/** 增益衰减量（负数，dB）：给界面上的「-6.3 dB」用。 */
export const compressorGainReductionDb = (inputDb: number, band: AudioConsoleCompressorBand): number => (
    compressorTransferDb(inputDb, band) - inputDb
);
