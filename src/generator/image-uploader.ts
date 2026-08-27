import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { DOMParser, XMLSerializer, type Node } from '@xmldom/xmldom';
import type {
  TrackChoicePayload,
  TrackImageDimensions,
  TrackQuestionPayload,
} from '@metyatech/track-tcm-api-client';

interface TrackApiClientUpload {
  uploadImage(
    file: Blob,
    filename: string,
    dimensions: TrackImageDimensions
  ): Promise<string>;
}

export const IMAGE_UPLOAD_CACHE_VERSION = 1 as const;

export interface ImageUploadCacheEntry {
  sourceHash: string;
  url: string;
  relativePath?: string;
}

export interface ImageUploadCache {
  version: typeof IMAGE_UPLOAD_CACHE_VERSION;
  images: Record<string, ImageUploadCacheEntry>;
}

export interface ImageUploadOptions {
  initialCache?: ImageUploadCache;
  onCacheUpdate?: (cache: ImageUploadCache) => void | Promise<void>;
}

/**
 * Carries image progress separately from the underlying API/cache error so
 * the CLI can decide whether an authentication retry is safe.
 */
export class ImageUploadError extends Error {
  public readonly originalError: unknown;
  public readonly uploadedImageCount: number;
  public readonly resolvedImageCount: number;
  public readonly retryStatePersisted: boolean;
  public readonly hasRemoteProgress: boolean;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      uploadedImageCount: number;
      resolvedImageCount: number;
      retryStatePersisted: boolean;
    },
  ) {
    super(message);
    this.name = 'ImageUploadError';
    this.originalError = options.cause;
    this.uploadedImageCount = options.uploadedImageCount;
    this.resolvedImageCount = options.resolvedImageCount;
    this.retryStatePersisted = options.retryStatePersisted;
    this.hasRemoteProgress = options.resolvedImageCount > 0;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

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

async function replaceImagesInText(
  text: string | undefined,
  qtiDir: string,
  apiClient: TrackApiClientUpload,
  uploadCache: Map<string, string>,
  imageUploadCache: ImageUploadCache,
  options: ImageUploadOptions,
  progress: ImageUploadProgress,
): Promise<string> {
  if (!text || !/<img(?:\s|>)/iu.test(text)) {
    return text ?? '';
  }

  const parser = new DOMParser({
    onError(_level, message) {
      throw new Error(`Invalid canonical HTML fragment: ${message}`);
    },
  });
  const serializer = new XMLSerializer();
  const document = parser.parseFromString(`<root>${text}</root>`, 'application/xml');
  const root = document.documentElement;
  if (root === null) {
    throw new Error('Invalid canonical HTML fragment: missing root element.');
  }
  const images = root.getElementsByTagName('img');

  for (let index = 0; index < images.length; index += 1) {
    const image = images.item(index);
    if (image === null) {
      continue;
    }

    const src = image.getAttribute('src');
    if (src === null || shouldPreserveImageSource(src)) {
      continue;
    }

    const localPath = resolve(qtiDir, src);
    let buffer: Buffer;
    try {
      buffer = await readFile(localPath);
    } catch (error) {
      throw createImageUploadError(
        `Failed to read image ${localPath}: ${formatError(error)}`,
        error,
        progress,
      );
    }

    const sourceHash = hashImageContent(buffer);
    let remoteUrl = uploadCache.get(sourceHash);

    if (!remoteUrl) {
      const blob = new Blob([Uint8Array.from(buffer)]);
      const filename = src.split(/[/\\]/).pop() || 'image.png';
      try {
        const dimensions = readImageDimensions(buffer, localPath);
        remoteUrl = await apiClient.uploadImage(blob, filename, dimensions);
      } catch (error) {
        throw createImageUploadError(
          `Failed to upload image ${localPath}: ${formatError(error)}`,
          error,
          progress,
        );
      }

      progress.uploadedImageCount += 1;
      progress.resolvedImageCount += 1;
      uploadCache.set(sourceHash, remoteUrl);

      if (options.onCacheUpdate === undefined) {
        progress.retryStatePersisted = false;
      } else {
        const nextCache: ImageUploadCache = {
          version: IMAGE_UPLOAD_CACHE_VERSION,
          images: {
            ...imageUploadCache.images,
            [sourceHash]: {
              sourceHash,
              url: remoteUrl,
              relativePath: relative(qtiDir, localPath).replaceAll('\\', '/'),
            },
          },
        };
        try {
          await options.onCacheUpdate(nextCache);
        } catch (error) {
          throw createImageUploadError(
            `Failed to save image upload cache after uploading ${localPath}: ${formatError(error)}`,
            error,
            { ...progress, retryStatePersisted: false },
          );
        }
        imageUploadCache.images = nextCache.images;
        progress.retryStatePersisted = true;
      }
    } else {
      progress.resolvedImageCount += 1;
    }

    image.setAttribute('src', remoteUrl);
  }

  return Array.from(root.childNodes, (node: Node) => serializer.serializeToString(node)).join('');
}

interface ImageUploadProgress {
  uploadedImageCount: number;
  resolvedImageCount: number;
  retryStatePersisted: boolean;
}

function createImageUploadError(
  message: string,
  cause: unknown,
  progress: ImageUploadProgress,
): ImageUploadError {
  return new ImageUploadError(message, {
    cause,
    uploadedImageCount: progress.uploadedImageCount,
    resolvedImageCount: progress.resolvedImageCount,
    retryStatePersisted: progress.retryStatePersisted,
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hashImageContent(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function emptyImageUploadCache(): ImageUploadCache {
  return { version: IMAGE_UPLOAD_CACHE_VERSION, images: {} };
}

export async function loadImageUploadCache(filePath: string): Promise<ImageUploadCache> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return emptyImageUploadCache();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid image upload cache ${filePath}: ${formatError(error)}`);
  }

  if (!isRecord(parsed) || parsed.version !== IMAGE_UPLOAD_CACHE_VERSION || !isRecord(parsed.images)) {
    throw new Error(`Invalid image upload cache ${filePath}: expected version ${IMAGE_UPLOAD_CACHE_VERSION}`);
  }

  const images: Record<string, ImageUploadCacheEntry> = {};
  for (const [key, value] of Object.entries(parsed.images)) {
    if (
      !isRecord(value) ||
      typeof value.sourceHash !== 'string' ||
      value.sourceHash.length === 0 ||
      typeof value.url !== 'string' ||
      value.url.length === 0 ||
      (value.relativePath !== undefined && typeof value.relativePath !== 'string')
    ) {
      throw new Error(`Invalid image upload cache ${filePath}: invalid image entry ${key}`);
    }
    images[key] = {
      sourceHash: value.sourceHash,
      url: value.url,
      ...(value.relativePath === undefined ? {} : { relativePath: value.relativePath }),
    };
  }

  return { version: IMAGE_UPLOAD_CACHE_VERSION, images };
}

export async function saveImageUploadCache(
  filePath: string,
  cache: ImageUploadCache,
): Promise<void> {
  const content = `${JSON.stringify(cache, null, 2)}\n`;
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Preserve the original cache write failure.
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function shouldPreserveImageSource(src: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(src) || isAbsolute(src);
}

function readImageDimensions(
  buffer: Buffer,
  imagePath: string
): TrackImageDimensions {
  try {
    return parseImageDimensions(buffer);
  } catch (error) {
    throw new Error(
      `Could not determine image dimensions for ${imagePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function parseImageDimensions(buffer: Buffer): TrackImageDimensions {
  return (
    parsePngDimensions(buffer) ??
    parseGifDimensions(buffer) ??
    parseJpegDimensions(buffer) ??
    parseWebpDimensions(buffer) ??
    unsupportedImageFormat()
  );
}

function parsePngDimensions(buffer: Buffer): TrackImageDimensions | undefined {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return undefined;
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseGifDimensions(buffer: Buffer): TrackImageDimensions | undefined {
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

function parseJpegDimensions(buffer: Buffer): TrackImageDimensions | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
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

function parseWebpDimensions(buffer: Buffer): TrackImageDimensions | undefined {
  if (
    buffer.length < 30 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
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

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (
    (buffer[offset] ?? 0) |
    ((buffer[offset + 1] ?? 0) << 8) |
    ((buffer[offset + 2] ?? 0) << 16)
  );
}

function unsupportedImageFormat(): never {
  throw new Error('unsupported image format');
}

export async function uploadImagesAndReplaceUrls(
  questions: TrackQuestionPayload[],
  qtiDir: string,
  apiClient: TrackApiClientUpload,
  options: ImageUploadOptions = {},
): Promise<TrackQuestionPayload[]> {
  const uploadCache = new Map<string, string>();
  const imageUploadCache: ImageUploadCache = {
    version: IMAGE_UPLOAD_CACHE_VERSION,
    images: { ...(options.initialCache?.images ?? {}) },
  };
  for (const entry of Object.values(imageUploadCache.images)) {
    if (entry.sourceHash.length > 0 && entry.url.length > 0) {
      uploadCache.set(entry.sourceHash, entry.url);
    }
  }
  const progress: ImageUploadProgress = {
    uploadedImageCount: 0,
    resolvedImageCount: 0,
    retryStatePersisted: options.initialCache !== undefined,
  };
  const newQuestions: TrackQuestionPayload[] = [];

  for (const q of questions) {
    const newQ: TrackQuestionPayload = { ...q };

    newQ.content = await replaceImagesInText(
      q.content,
      qtiDir,
      apiClient,
      uploadCache,
      imageUploadCache,
      options,
      progress,
    );
    newQ.howToSolve = await replaceImagesInText(
      q.howToSolve,
      qtiDir,
      apiClient,
      uploadCache,
      imageUploadCache,
      options,
      progress,
    );

    if (q.choices) {
      newQ.choices = [];
      for (const choice of q.choices) {
        const newChoice: TrackChoicePayload = { ...choice };
        newChoice.content = await replaceImagesInText(
          choice.content,
          qtiDir,
          apiClient,
          uploadCache,
          imageUploadCache,
          options,
          progress,
        );
        newQ.choices.push(newChoice);
      }
    }

    newQuestions.push(newQ);
  }

  return newQuestions;
}
