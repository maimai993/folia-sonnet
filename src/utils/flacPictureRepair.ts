// src/utils/flacPictureRepair.ts
// Repairs bounded FLAC PICTURE fields without changing the embedded image bytes.

const textDecoder = new TextDecoder();

/** Returns null when field boundaries cannot safely identify the image payload. */
export function repairFlacPicture(bytes: Uint8Array): Uint8Array | null {
    if (bytes.length < 32) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const mimeLength = view.getUint32(4);
    if (mimeLength > bytes.length - 32) return null;
    const descriptionOffset = 8 + mimeLength;
    const descriptionLength = view.getUint32(descriptionOffset);
    if (descriptionLength > bytes.length - descriptionOffset - 24) return null;
    const dataLengthOffset = descriptionOffset + 4 + descriptionLength + 16;
    const availableDataLength = bytes.length - dataLengthOffset - 4;
    if (availableDataLength === 0) return null;

    const mime = textDecoder.decode(bytes.subarray(8, descriptionOffset));
    const validMime = mime === '-->' || /^image\/[a-z0-9!#$&^_.+\-]+$/i.test(mime);
    const invalidType = view.getUint32(0) > 20;
    const invalidLength = view.getUint32(dataLengthOffset) !== availableDataLength;
    if (!invalidType && !invalidLength && (validMime || mimeLength === 0)) return bytes;

    // An empty MIME lets music-metadata infer the image format from its payload.
    const removedMimeLength = validMime ? 0 : mimeLength;
    const repaired = new Uint8Array(bytes.length - removedMimeLength);
    repaired.set(bytes.subarray(0, 8));
    repaired.set(bytes.subarray(8 + removedMimeLength), 8);
    const repairedView = new DataView(repaired.buffer);
    if (invalidType) repairedView.setUint32(0, 0); // Reserved types become "Other".
    if (removedMimeLength) repairedView.setUint32(4, 0);
    repairedView.setUint32(dataLengthOffset - removedMimeLength, availableDataLength);
    return repaired;
}

/** Fixes picture comments individually so one bad cover cannot discard other tags. */
export function repairFlacPictureComments(bytes: Uint8Array): Uint8Array {
    if (bytes.length < 8) return bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vendorLength = view.getUint32(0, true);
    if (vendorLength > bytes.length - 8) return bytes;
    let offset = 8 + vendorLength;
    const count = view.getUint32(4 + vendorLength, true);
    if (count > (bytes.length - offset) / 4) return bytes;
    const comments: Uint8Array[] = [];
    let changed = false;

    for (let index = 0; index < count; index++) {
        if (offset + 4 > bytes.length) return bytes;
        const length = view.getUint32(offset, true);
        if (length > bytes.length - offset - 4) return bytes;
        const comment = bytes.subarray(offset + 4, offset + 4 + length);
        const decoded = textDecoder.decode(comment);
        const separator = decoded.indexOf('=');
        let repairedComment: Uint8Array | null = comment;
        if (separator > 0 && decoded.slice(0, separator).toUpperCase() === 'METADATA_BLOCK_PICTURE') {
            try {
                const picture = Uint8Array.from(atob(decoded.slice(separator + 1)), character => character.charCodeAt(0));
                const repaired = repairFlacPicture(picture);
                if (repaired !== picture) {
                    changed = true;
                    let binary = '';
                    for (let offset = 0; repaired && offset < repaired.length; offset += 8192) {
                        binary += String.fromCharCode(...repaired.subarray(offset, offset + 8192));
                    }
                    repairedComment = repaired
                        ? new TextEncoder().encode(`METADATA_BLOCK_PICTURE=${btoa(binary)}`)
                        : null;
                }
            } catch {
                changed = true;
                repairedComment = null;
            }
        }
        if (repairedComment) {
            if (repairedComment === comment) {
                comments.push(bytes.subarray(offset, offset + 4 + length));
            } else {
                const record = new Uint8Array(4 + repairedComment.length);
                new DataView(record.buffer).setUint32(0, repairedComment.length, true);
                record.set(repairedComment, 4);
                comments.push(record);
            }
        }
        offset += 4 + length;
    }
    if (!changed) return bytes;
    const repaired = new Uint8Array(8 + vendorLength + comments.reduce((total, comment) => total + comment.length, 0) + bytes.length - offset);
    repaired.set(bytes.subarray(0, 8 + vendorLength));
    new DataView(repaired.buffer).setUint32(4 + vendorLength, comments.length, true);
    let writeOffset = 8 + vendorLength;
    for (const comment of comments) {
        repaired.set(comment, writeOffset);
        writeOffset += comment.length;
    }
    repaired.set(bytes.subarray(offset), writeOffset);
    return repaired;
}
