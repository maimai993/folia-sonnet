import {
    AUDIO_CONSOLE_REVERB_RT60_MIN,
    AUDIO_CONSOLE_REVERB_RT60_MAX,
} from './defaults';

// 从脉冲响应量出参数化混响的起点。
/** WAV 脉冲响应的分析结果。 */
export type AudioConsoleImpulseProfile = {
    /** 从直达声衰减 60 dB 的时间，夹在 0.3 ~ 10 秒。 */
    rt60: number;
    /** 预延迟（毫秒）：直达声之前的那一段静音。 */
    preDelayMs: number;
    /** 阻尼 0 ～ 1：尾巴越暗越大。 */
    damping: number;
    /** 文件里带的采样率，只用于显示。 */
    sampleRate: number;
    /** 时长（秒）。 */
    durationSeconds: number;
};

/**
 * 从一段 WAV 脉冲响应里量出「这个空间有多大、多暗、多远」。
 *
 * 为什么不做真卷积：48 kHz 立体声、2 秒的 IR 是 21 万个抽头，逐样本卷积在中端机上是
 * 几十个点的 CPU；分块 FFT 卷积能跑，但那是另一个量级的实现。这里的做法是**测量**这份
 * IR，把它的三个可听特征（衰减时间、预延迟、高频阻尼）折成参数化混响的参数 ——
 * 听感上得到同一个空间，代价是失去了 IR 里那些细节（比如某个特定的早期反射）。
 *
 * 只支持未压缩的 WAV（PCM 8/16/24/32 位或 IEEE float）。其它格式抛错，由调用方提示。
 */
export const analyzeImpulseWav = (buffer: ArrayBuffer): AudioConsoleImpulseProfile => {
    const view = new DataView(buffer);
    if (buffer.byteLength < 44) throw new Error('not a wav');

    const readTag = (offset: number) => String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
    );

    if (readTag(0) !== 'RIFF' || readTag(8) !== 'WAVE') throw new Error('not a wav');

    let cursor = 12;
    let channels = 1;
    let sampleRate = 48000;
    let bitsPerSample = 16;
    let audioFormat = 1;
    let dataOffset = -1;
    let dataLength = 0;

    while (cursor + 8 <= buffer.byteLength) {
        const tag = readTag(cursor);
        const size = view.getUint32(cursor + 4, true);
        const body = cursor + 8;
        if (tag === 'fmt ') {
            audioFormat = view.getUint16(body, true);
            channels = view.getUint16(body + 2, true) || 1;
            sampleRate = view.getUint32(body + 4, true) || 48000;
            bitsPerSample = view.getUint16(body + 14, true) || 16;
        } else if (tag === 'data') {
            dataOffset = body;
            dataLength = Math.min(size, buffer.byteLength - body);
            break;
        }
        cursor = body + size + (size % 2);
    }

    if (dataOffset < 0) throw new Error('no data chunk');

    const bytesPerSample = Math.max(1, Math.round(bitsPerSample / 8));
    const frameBytes = bytesPerSample * channels;
    const frames = Math.floor(dataLength / frameBytes);
    if (frames < 64) throw new Error('too short');

    const sampleAt = (frame: number): number => {
        const offset = dataOffset + frame * frameBytes;
        if (audioFormat === 3 && bitsPerSample === 32) return view.getFloat32(offset, true);
        if (bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
        if (bitsPerSample === 16) return view.getInt16(offset, true) / 32768;
        if (bitsPerSample === 24) {
            const low = view.getUint8(offset);
            const mid = view.getUint8(offset + 1);
            const high = view.getInt8(offset + 2);
            return ((high << 16) | (mid << 8) | low) / 8388608;
        }
        return view.getInt32(offset, true) / 2147483648;
    };

    // ① 峰值与它的位置：用来定预延迟，也用来把后续的量都相对它做。
    let peak = 0;
    let peakFrame = 0;
    for (let frame = 0; frame < frames; frame += 1) {
        const magnitude = Math.abs(sampleAt(frame));
        if (magnitude > peak) {
            peak = magnitude;
            peakFrame = frame;
        }
    }
    if (peak <= 0) throw new Error('silent impulse');

    // ② 预延迟：峰值之前、最后一次低于峰值 -40 dB 的位置。
    let directStart = peakFrame;
    for (let frame = peakFrame; frame >= 0; frame -= 1) {
        if (Math.abs(sampleAt(frame)) < peak * 0.01) {
            directStart = frame;
            break;
        }
    }
    const preDelayMs = (directStart / sampleRate) * 1000;

    // ③ RT60：Schroeder 反向能量积分，取 -5 dB 到 -35 dB 那一段的斜率外推到 -60 dB。
    //    直接找「-60 dB 那一点」在真实 IR 上不可靠：噪声底会把尾巴托住。
    const envelope = new Float64Array(frames);
    let accumulator = 0;
    for (let frame = frames - 1; frame >= 0; frame -= 1) {
        const sample = sampleAt(frame);
        accumulator += sample * sample;
        envelope[frame] = accumulator;
    }
    const total = envelope[0] || 1;
    const dbAt = (frame: number) => 10 * Math.log10(Math.max(envelope[frame] / total, 1e-12));

    let startDbFrame = -1;
    let endDbFrame = -1;
    for (let frame = 0; frame < frames; frame += 1) {
        const db = dbAt(frame);
        if (startDbFrame < 0 && db <= -5) startDbFrame = frame;
        if (endDbFrame < 0 && db <= -35) {
            endDbFrame = frame;
            break;
        }
    }
    let rt60 = 2.2;
    if (startDbFrame >= 0 && endDbFrame > startDbFrame) {
        const slope = (dbAt(endDbFrame) - dbAt(startDbFrame)) / (endDbFrame - startDbFrame);
        if (slope < 0) rt60 = (-60 / slope) / sampleRate;
    }
    rt60 = Math.min(AUDIO_CONSOLE_REVERB_RT60_MAX, Math.max(AUDIO_CONSOLE_REVERB_RT60_MIN, rt60));

    // ④ 阻尼：尾巴前半段与后半段的高频能量比。用一阶差分当高通，近似看「亮不亮」。
    const tailStart = Math.max(endDbFrame, directStart);
    const mid = Math.floor((tailStart + frames) / 2);
    let brightEarly = 0;
    let brightLate = 0;
    for (let frame = tailStart + 1; frame < mid; frame += 1) {
        brightEarly += Math.abs(sampleAt(frame) - sampleAt(frame - 1));
    }
    for (let frame = mid + 1; frame < frames; frame += 1) {
        brightLate += Math.abs(sampleAt(frame) - sampleAt(frame - 1));
    }
    const brightRatio = brightEarly > 0 ? brightLate / brightEarly : 1;
    const damping = Math.min(0.6, Math.max(0.05, 0.35 - (brightRatio - 1) * 0.3));

    return {
        rt60,
        preDelayMs: Math.min(120, Math.max(0, preDelayMs)),
        damping,
        sampleRate,
        durationSeconds: frames / sampleRate,
    };
};
