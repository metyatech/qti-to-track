import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;
const PNG_SIGNATURE = Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
]);
const JPEG_START_OF_FRAME_MARKERS = new Set([
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf,
]);
async function replaceImagesInText(text, qtiDir, apiClient, uploadCache) {
    if (!text) {
        return '';
    }
    let result = text;
    const matches = [...text.matchAll(MARKDOWN_IMAGE_REGEX)];
    for (const match of matches) {
        const fullMatch = match[0];
        const alt = match[1];
        const src = match[2];
        if (!src || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
            continue;
        }
        const localPath = resolve(qtiDir, src);
        let remoteUrl = uploadCache.get(localPath);
        if (!remoteUrl) {
            const buffer = await readFile(localPath);
            const blob = new Blob([buffer]);
            const filename = src.split(/[/\\]/).pop() || 'image.png';
            try {
                const dimensions = readImageDimensions(buffer, localPath);
                remoteUrl = await apiClient.uploadImage(blob, filename, dimensions);
            }
            catch (error) {
                throw new Error(`Failed to upload image ${localPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
            uploadCache.set(localPath, remoteUrl);
        }
        if (remoteUrl) {
            result = result.replace(fullMatch, `![${alt}](${remoteUrl})`);
        }
    }
    return result;
}
function readImageDimensions(buffer, imagePath) {
    try {
        return parseImageDimensions(buffer);
    }
    catch (error) {
        throw new Error(`Could not determine image dimensions for ${imagePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function parseImageDimensions(buffer) {
    return (parsePngDimensions(buffer) ??
        parseGifDimensions(buffer) ??
        parseJpegDimensions(buffer) ??
        parseWebpDimensions(buffer) ??
        unsupportedImageFormat());
}
function parsePngDimensions(buffer) {
    if (buffer.length < 24 ||
        !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return undefined;
    }
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    };
}
function parseGifDimensions(buffer) {
    if (buffer.length < 10) {
        return undefined;
    }
    const signature = buffer.toString('ascii', 0, 6);
    if (signature !== 'GIF87a' && signature !== 'GIF89a') {
        return undefined;
    }
    return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
    };
}
function parseJpegDimensions(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return undefined;
    }
    let offset = 2;
    while (offset < buffer.length) {
        while (buffer[offset] === 0xff)
            offset += 1;
        const marker = buffer[offset];
        offset += 1;
        if (marker === undefined || marker === 0xd9) {
            break;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue;
        }
        if (offset + 2 > buffer.length) {
            throw new Error('truncated JPEG segment length');
        }
        const segmentLength = buffer.readUInt16BE(offset);
        if (segmentLength < 2) {
            throw new Error('invalid JPEG segment length');
        }
        const segmentStart = offset + 2;
        if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
            if (segmentStart + 5 > buffer.length) {
                throw new Error('truncated JPEG size segment');
            }
            return {
                width: buffer.readUInt16BE(segmentStart + 3),
                height: buffer.readUInt16BE(segmentStart + 1),
            };
        }
        offset += segmentLength;
    }
    throw new Error('JPEG size segment was not found');
}
function parseWebpDimensions(buffer) {
    if (buffer.length < 30 ||
        buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        buffer.toString('ascii', 8, 12) !== 'WEBP') {
        return undefined;
    }
    const chunkType = buffer.toString('ascii', 12, 16);
    switch (chunkType) {
        case 'VP8X':
            return {
                width: readUInt24LE(buffer, 24) + 1,
                height: readUInt24LE(buffer, 27) + 1,
            };
        case 'VP8L': {
            if (buffer[20] !== 0x2f) {
                throw new Error('invalid WebP lossless signature');
            }
            const b0 = buffer[21] ?? 0;
            const b1 = buffer[22] ?? 0;
            const b2 = buffer[23] ?? 0;
            const b3 = buffer[24] ?? 0;
            return {
                width: 1 + (((b1 & 0x3f) << 8) | b0),
                height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
            };
        }
        case 'VP8 ':
            if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
                throw new Error('invalid WebP lossy frame signature');
            }
            return {
                width: buffer.readUInt16LE(26) & 0x3fff,
                height: buffer.readUInt16LE(28) & 0x3fff,
            };
        default:
            throw new Error(`unsupported WebP chunk type ${chunkType}`);
    }
}
function readUInt24LE(buffer, offset) {
    return ((buffer[offset] ?? 0) |
        ((buffer[offset + 1] ?? 0) << 8) |
        ((buffer[offset + 2] ?? 0) << 16));
}
function unsupportedImageFormat() {
    throw new Error('unsupported image format');
}
export async function uploadImagesAndReplaceUrls(questions, qtiDir, apiClient) {
    const uploadCache = new Map();
    const newQuestions = [];
    for (const q of questions) {
        const newQ = { ...q };
        newQ.content = await replaceImagesInText(q.content, qtiDir, apiClient, uploadCache);
        newQ.howToSolve = await replaceImagesInText(q.howToSolve, qtiDir, apiClient, uploadCache);
        if (q.choices) {
            newQ.choices = await Promise.all(q.choices.map(async (choice) => {
                const newChoice = { ...choice };
                newChoice.content = await replaceImagesInText(choice.content, qtiDir, apiClient, uploadCache);
                return newChoice;
            }));
        }
        newQuestions.push(newQ);
    }
    return newQuestions;
}
