import { parseBlob } from 'music-metadata';
import { describe, expect, it, vi } from 'vitest';
import { repairFlacMetadata } from '../../../src/utils/flacMetadataRepair';

// test/unit/utils/flacMetadataRepair.test.ts
// Exercises malformed local FLAC metadata against the real music-metadata parser.

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), character => character.charCodeAt(0));
const audio = new Uint8Array([0xff, 0xf8, 0x69, 0x18, 0x00, 0x00, 0x23, 0x42]);
const encoder = new TextEncoder();

function block(type: number, data: Uint8Array, last = false): Blob {
    return new Blob([new Uint8Array([(last ? 128 : 0) | type, data.length >>> 16, data.length >>> 8, data.length]), data as Uint8Array<ArrayBuffer>]);
}

function picture(options: { type?: number; mime?: string; dataLength?: number } = {}): Uint8Array {
    const mime = encoder.encode(options.mime ?? 'image/png');
    const bytes = new Uint8Array(32 + mime.length + png.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, options.type ?? 3);
    view.setUint32(4, mime.length);
    bytes.set(mime, 8);
    view.setUint32(12 + mime.length, 1);
    view.setUint32(16 + mime.length, 1);
    view.setUint32(20 + mime.length, 32);
    view.setUint32(28 + mime.length, options.dataLength ?? png.length);
    bytes.set(png, 32 + mime.length);
    return bytes;
}

function comments(entries: string[]): Uint8Array {
    const encoded = entries.map(entry => encoder.encode(entry));
    const bytes = new Uint8Array(8 + encoded.reduce((total, entry) => total + 4 + entry.length, 0));
    const view = new DataView(bytes.buffer);
    view.setUint32(4, entries.length, true);
    let offset = 8;
    for (const entry of encoded) {
        view.setUint32(offset, entry.length, true);
        bytes.set(entry, offset + 4);
        offset += 4 + entry.length;
    }
    return bytes;
}

function flac(metadata: Blob[]): Blob {
    const streamInfo = new Uint8Array(34);
    const view = new DataView(streamInfo.buffer);
    view.setUint16(0, 4096);
    view.setUint16(2, 4096);
    view.setBigUint64(10, (44100n << 44n) | (1n << 41n) | (15n << 36n) | 441000n);
    return new Blob([encoder.encode('fLaC'), block(0, streamInfo, metadata.length === 0), ...metadata, audio], { type: 'audio/flac' });
}

const tags = () => comments(['TITLE=Recovered Title', 'ARTIST=Local Artist', 'ALBUM=Local Album', 'LYRICS=[00:01.00]Recovered lyric', 'REPLAYGAIN_TRACK_GAIN=-6.5 dB']);
const metadataWithPicture = (data: Uint8Array) => flac([block(6, data), block(4, tags(), true)]);
const parsedCover = async (source: Blob) => parseBlob(await repairFlacMetadata(source, true));

describe('repairFlacMetadata', () => {
    it('returns a valid original FLAC unchanged', async () => {
        const source = metadataWithPicture(picture());
        expect(await repairFlacMetadata(source, true)).toBe(source);
        expect((await parseBlob(source)).common.picture?.[0].type).toBe('Cover (front)');
    });

    it('normalizes reserved picture types while retaining the cover and other tags', async () => {
        const source = metadataWithPicture(picture({ type: 0xffffffff }));
        const original = new Uint8Array(await source.arrayBuffer());
        expect((await parseBlob(source)).common.picture?.[0].type).toBeUndefined();
        const repaired = await repairFlacMetadata(source, true);
        const parsed = await parseBlob(repaired);
        expect(parsed.common.picture?.[0]).toMatchObject({ type: 'Other', format: 'image/png', data: png });
        expect(parsed.common).toMatchObject({ title: 'Recovered Title', artist: 'Local Artist', album: 'Local Album', replaygain_track_gain: { dB: -6.5 } });
        expect(parsed.common.lyrics?.[0].syncText?.[0]).toMatchObject({ text: 'Recovered lyric' });
        expect(parsed.format.duration).toBe(10);
        expect(new Uint8Array(await repaired.slice(-audio.length).arrayBuffer())).toEqual(audio);
        expect(new Uint8Array(await source.arrayBuffer())).toEqual(original);
    });

    it.each([0, 1, 0xffffffff])('repairs an inconsistent image length of %i within the block boundary', async dataLength => {
        const source = metadataWithPicture(picture({ dataLength }));
        expect((await parsedCover(source)).common.picture?.[0].data).toEqual(png);
    });

    it('lets music-metadata infer a malformed MIME from the actual image payload', async () => {
        const source = metadataWithPicture(picture({ mime: 'not-a-mime', type: 250 }));
        expect((await parsedCover(source)).common.picture?.[0]).toMatchObject({ format: 'image/png', type: 'Other', data: png });
    });

    it.each(['mime', 'description'])('skips a picture with an unrecoverable %s boundary and retains following metadata/audio', async field => {
        const broken = picture();
        new DataView(broken.buffer).setUint32(field === 'mime' ? 4 : 8 + 'image/png'.length, 0xffffffff);
        const source = metadataWithPicture(broken);
        await expect(parseBlob(source)).rejects.toThrow();
        const repaired = await repairFlacMetadata(source, true);
        const parsed = await parseBlob(repaired);
        expect(parsed.common.picture).toBeUndefined();
        expect(parsed.common.title).toBe('Recovered Title');
        expect(parsed.common.artist).toBe('Local Artist');
        expect(parsed.format.duration).toBe(10);
        expect(new Uint8Array(await repaired.slice(-audio.length).arrayBuffer())).toEqual(audio);
    });

    it('keeps another valid cover when a broken picture is skipped', async () => {
        const source = flac([block(6, new Uint8Array(3)), block(6, picture(), true)]);
        expect((await parsedCover(source)).common.picture).toHaveLength(1);
        expect((await parsedCover(source)).common.picture?.[0].data).toEqual(png);
    });

    it('preserves the final-block flag when the final broken picture becomes padding', async () => {
        const source = flac([block(4, tags()), block(6, new Uint8Array(2), true)]);
        const parsed = await parsedCover(source);
        expect(parsed.common.title).toBe('Recovered Title');
        expect(parsed.format.bitrate).toBe(audio.length * 8 / 10);
    });

    it('repairs base64 picture comments and removes only malformed covers', async () => {
        const pictureComment = btoa(String.fromCharCode(...picture({ type: 100, dataLength: 1 })));
        const source = flac([block(4, comments(['TITLE=Comment Title', `METADATA_BLOCK_PICTURE=${pictureComment}`, 'METADATA_BLOCK_PICTURE=%%%broken%%%', 'ARTIST=Retained Artist']), true)]);
        await expect(parseBlob(source)).rejects.toThrow();
        const parsed = await parsedCover(source);
        expect(parsed.common.title).toBe('Comment Title');
        expect(parsed.common.artist).toBe('Retained Artist');
        expect(parsed.common.picture?.[0]).toMatchObject({ type: 'Other', data: png });
    });

    it('uses skipCovers without reading or repairing cover payloads', async () => {
        const source = metadataWithPicture(new Uint8Array(1));
        const slice = vi.spyOn(source, 'slice');
        expect(await repairFlacMetadata(source, false)).toBe(source);
        expect(slice).not.toHaveBeenCalled();
        const parsed = await parseBlob(source, { skipCovers: true });
        expect(parsed.common.title).toBe('Recovered Title');
    });

    it('does not read/copy the audio payload of large local files', async () => {
        const metadata = metadataWithPicture(picture({ type: 255 }));
        const source = new Blob([metadata, new Uint8Array(8 * 1024 * 1024)], { type: 'audio/flac' });
        const slice = vi.spyOn(source, 'slice');
        vi.spyOn(source, 'arrayBuffer').mockRejectedValue(new Error('Full-file read is forbidden'));
        const repaired = await repairFlacMetadata(source, true);
        expect(repaired).not.toBe(source);
        expect(repaired.size).toBe(source.size);
        const payloadReads = slice.mock.calls.filter(([, end]) => end !== undefined);
        expect(payloadReads.every(([, end]) => end! <= metadata.size - audio.length)).toBe(true);
    });

    it('does not guess recovery when an outer block exceeds the file or has no final block', async () => {
        const source = metadataWithPicture(picture({ type: 255 }));
        const bytes = new Uint8Array(await source.arrayBuffer());
        bytes.set([0xff, 0xff, 0xff], 43);
        const truncated = new Blob([bytes], { type: 'audio/flac' });
        expect(await repairFlacMetadata(truncated, true)).toBe(truncated);
        const noFinal = new Blob([encoder.encode('fLaC'), block(0, new Uint8Array(34)), block(6, picture({ type: 255 }))]);
        expect(await repairFlacMetadata(noFinal, true)).toBe(noFinal);
    });

    it('returns non-FLAC input unchanged', async () => {
        const source = new Blob(['ID3 mp3 audio'], { type: 'audio/mpeg' });
        expect(await repairFlacMetadata(source, true)).toBe(source);
    });

    it('preserves leading ID3v2 tags while repairing native FLAC pictures', async () => {
        const id3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
        const source = new Blob([id3, metadataWithPicture(picture({ type: 100 }))], { type: 'audio/flac' });
        const repaired = await repairFlacMetadata(source, true);
        expect(new Uint8Array(await repaired.slice(0, 10).arrayBuffer())).toEqual(id3);
        expect((await parseBlob(repaired)).common.picture?.[0]).toMatchObject({ type: 'Other', data: png });
    });
});
