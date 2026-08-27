import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrackApiError, type TrackQuestionPayload } from '@metyatech/track-tcm-api-client';
import {
  createImageUploadRetryState,
  ImageUploadError,
  loadImageUploadCache,
  saveImageUploadCache,
  uploadImagesAndReplaceUrls,
} from '../src/generator/image-uploader.js';
import { getPublishFailureExitCode, isTrackAuthenticationError } from '../src/publish/publisher.js';

function question(content: string, howToSolve = '<p>Review <img src="assets/diagram.png" alt="solution" /></p>'): TrackQuestionPayload {
  return {
    title: 'Image Question',
    questionKind: 3,
    status: 2,
    content,
    howToSolve,
    choices: [{ content: '<p>Pick <img src="assets/diagram.png" alt="choice" /></p>', correct: true }],
    quizCategories: [99],
    availableApps: ['training'],
  };
}

describe('uploadImagesAndReplaceUrls', () => {
  it('uploads local HTML images once and preserves every other image attribute', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), pngHeader(2, 3));

    const uploadedFiles: string[] = [];
    const [updated] = await uploadImagesAndReplaceUrls(
      [question('<p>Explain <img src="assets/diagram.png" alt="diagram" title="title" class="hero" style="width: 2em;" /></p>')],
      qtiDir,
      {
        async uploadImage(file, filename, dimensions) {
          uploadedFiles.push(`${filename}:${String(file.size)}:${String(dimensions.width)}x${String(dimensions.height)}`);
          return `https://res.cloudinary.example/${filename}`;
        },
      },
    );

    expect(uploadedFiles).toEqual(['diagram.png:24:2x3']);
    expect(updated?.content).toBe('<p>Explain <img src="https://res.cloudinary.example/diagram.png" alt="diagram" title="title" class="hero" style="width: 2em;"/></p>');
    expect(updated?.howToSolve).toBe('<p>Review <img src="https://res.cloudinary.example/diagram.png" alt="solution"/></p>');
    expect(updated?.choices?.[0]?.content).toBe('<p>Pick <img src="https://res.cloudinary.example/diagram.png" alt="choice"/></p>');
  });

  it('does not upload remote or data image sources', async () => {
    let uploadCalled = false;
    const remoteQuestion = question('<p><img src="https://cdn.example/remote.png" alt="remote" /><img src="data:image/png;base64,abc" alt="data" /></p>', '<p><img src="//cdn.example/remote-how-to-solve.png" alt="how-to-solve" /></p>');
    remoteQuestion.choices = [{ content: '<p><img src="https://cdn.example/remote-choice.png" alt="choice" /></p>', correct: true }];
    const [updated] = await uploadImagesAndReplaceUrls(
      [remoteQuestion],
      'unused-qti-directory',
      {
        async uploadImage() {
          uploadCalled = true;
          return 'https://res.cloudinary.example/unexpected.png';
        },
      },
    );

    expect(uploadCalled).toBe(false);
    expect(updated?.content).toBe('<p><img src="https://cdn.example/remote.png" alt="remote"/><img src="data:image/png;base64,abc" alt="data"/></p>');
  });

  it('fails instead of keeping a local image path when upload fails', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), pngHeader(2, 3));

    await expect(
      uploadImagesAndReplaceUrls(
        [question('<p>Explain <img src="assets/diagram.png" alt="diagram" /></p>')],
        qtiDir,
        {
          async uploadImage() {
            throw new Error('Invalid Signature');
          },
        },
      ),
    ).rejects.toThrow(/Failed to upload image .*assets.*diagram\.png: Invalid Signature/u);
  });

  it('fails before upload when local image dimensions cannot be determined', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), 'not an image');

    let uploadCalled = false;
    await expect(
      uploadImagesAndReplaceUrls(
        [question('<p>Explain <img src="assets/diagram.png" alt="diagram" /></p>')],
        qtiDir,
        {
          async uploadImage() {
            uploadCalled = true;
            return 'https://res.cloudinary.example/diagram.png';
          },
        },
      ),
    ).rejects.toThrow(/Could not determine image dimensions .*unsupported image format/u);
    expect(uploadCalled).toBe(false);
  });

  it.each([401, 403])('preserves Track authentication errors from image upload-signature: %s', async (status) => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-auth-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), pngHeader(2, 3));
    const trackError = trackApiError(status);

    const error = await uploadImagesAndReplaceUrls(
      [imageQuestion('assets/diagram.png')],
      qtiDir,
      {
        async uploadImage() {
          throw trackError;
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ImageUploadError);
    expect(isTrackAuthenticationError(error)).toBe(true);
    expect(getPublishFailureExitCode(error)).toBe(3);
    expect((error as ImageUploadError).cause).toBe(trackError);
    expect((error as ImageUploadError).uploadedImageCount).toBe(0);
    expect((error as ImageUploadError).hasRemoteProgress).toBe(false);
  });

  it('persists each successful image and reuses it on the next publish attempt', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-cache-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'one.png'), pngHeader(2, 3));
    await writeFile(join(qtiDir, 'assets', 'two.png'), pngHeader(4, 5));
    const cachePath = join(qtiDir, 'image-upload-cache.json');
    const firstUploads: string[] = [];

    const firstError = await uploadImagesAndReplaceUrls(
      [imageQuestionWithSources(['assets/one.png', 'assets/two.png'])],
      qtiDir,
      {
        async uploadImage(_file, filename) {
          firstUploads.push(filename);
          if (filename === 'two.png') throw trackApiError(401);
          return 'https://cdn.example/one.png';
        },
      },
      {
        initialCache: await loadImageUploadCache(cachePath),
        onCacheUpdate: (cache) => saveImageUploadCache(cachePath, cache),
      },
    ).catch((caught: unknown) => caught);

    expect(firstError).toBeInstanceOf(ImageUploadError);
    expect(isTrackAuthenticationError(firstError)).toBe(true);
    expect((firstError as ImageUploadError).hasRemoteProgress).toBe(true);
    expect((firstError as ImageUploadError).retryStatePersisted).toBe(true);
    expect(firstUploads).toEqual(['one.png', 'two.png']);

    const savedCache = await loadImageUploadCache(cachePath);
    const savedOne = Object.values(savedCache.images).find((entry) => entry.relativePath === 'assets/one.png');
    expect(savedOne).toMatchObject({
      sourceHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      url: 'https://cdn.example/one.png',
      relativePath: 'assets/one.png',
    });

    const retryUploads: string[] = [];
    const [retryQuestion] = await uploadImagesAndReplaceUrls(
      [imageQuestionWithSources(['assets/one.png', 'assets/two.png'])],
      qtiDir,
      {
        async uploadImage(_file, filename) {
          retryUploads.push(filename);
          return 'https://cdn.example/two.png';
        },
      },
      {
        initialCache: savedCache,
        onCacheUpdate: (cache) => saveImageUploadCache(cachePath, cache),
      },
    );

    expect(retryUploads).toEqual(['two.png']);
    expect(retryQuestion?.content).toContain('https://cdn.example/one.png');
    expect(retryQuestion?.content).toContain('https://cdn.example/two.png');
  });

  it('reports completed image retry safety to the caller', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-progress-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), pngHeader(2, 3));

    const withoutCache = createImageUploadRetryState();
    await uploadImagesAndReplaceUrls(
      [imageQuestion('assets/diagram.png')],
      qtiDir,
      { async uploadImage() { return 'https://cdn.example/diagram.png'; } },
      { progress: withoutCache },
    );
    expect(withoutCache).toEqual({
      uploadedImageCount: 1,
      hasRemoteProgress: true,
      retryStatePersisted: false,
    });

    const cachePath = join(qtiDir, 'image-upload-cache.json');
    const withCache = createImageUploadRetryState();
    await uploadImagesAndReplaceUrls(
      [imageQuestion('assets/diagram.png')],
      qtiDir,
      { async uploadImage() { return 'https://cdn.example/diagram.png'; } },
      {
        initialCache: await loadImageUploadCache(cachePath),
        onCacheUpdate: (cache) => saveImageUploadCache(cachePath, cache),
        progress: withCache,
      },
    );
    expect(withCache).toEqual({
      uploadedImageCount: 1,
      hasRemoteProgress: true,
      retryStatePersisted: true,
    });

    const cacheHit = createImageUploadRetryState();
    await uploadImagesAndReplaceUrls(
      [imageQuestion('assets/diagram.png')],
      qtiDir,
      { async uploadImage() { throw new Error('cache hit should not upload'); } },
      {
        initialCache: await loadImageUploadCache(cachePath),
        progress: cacheHit,
      },
    );
    expect(cacheHit).toEqual({
      uploadedImageCount: 0,
      hasRemoteProgress: false,
      retryStatePersisted: true,
    });
  });

  it('does not reuse a cache entry when the image content hash changes', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-hash-'));
    await mkdir(join(qtiDir, 'assets'));
    const imagePath = join(qtiDir, 'assets', 'diagram.png');
    await writeFile(imagePath, pngHeader(2, 3));
    const cachePath = join(qtiDir, 'image-upload-cache.json');

    await uploadImagesAndReplaceUrls(
      [imageQuestion('assets/diagram.png')],
      qtiDir,
      { async uploadImage() { return 'https://cdn.example/old.png'; } },
      {
        initialCache: await loadImageUploadCache(cachePath),
        onCacheUpdate: (cache) => saveImageUploadCache(cachePath, cache),
      },
    );
    await writeFile(imagePath, pngHeader(9, 10));

    let uploadCount = 0;
    const [updated] = await uploadImagesAndReplaceUrls(
      [imageQuestion('assets/diagram.png')],
      qtiDir,
      {
        async uploadImage() {
          uploadCount += 1;
          return 'https://cdn.example/new.png';
        },
      },
      {
        initialCache: await loadImageUploadCache(cachePath),
        onCacheUpdate: (cache) => saveImageUploadCache(cachePath, cache),
      },
    );

    expect(uploadCount).toBe(1);
    expect(updated?.content).toContain('https://cdn.example/new.png');
  });

  it('reports an unsafe image retry when cache persistence fails after remote upload', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-cache-failure-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), pngHeader(2, 3));

    const error = await uploadImagesAndReplaceUrls(
      [imageQuestion('assets/diagram.png')],
      qtiDir,
      { async uploadImage() { return 'https://cdn.example/diagram.png'; } },
      {
        initialCache: { version: 1, images: {} },
        onCacheUpdate: async () => {
          throw new Error('disk full');
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ImageUploadError);
    expect((error as ImageUploadError).uploadedImageCount).toBe(1);
    expect((error as ImageUploadError).hasRemoteProgress).toBe(true);
    expect((error as ImageUploadError).retryStatePersisted).toBe(false);
    expect((error as ImageUploadError).message).toContain('Failed to save image upload cache');
    expect(getPublishFailureExitCode(error)).toBe(1);
  });

  it('does not classify a Cloudinary error as Track authentication failure', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-cloudinary-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), pngHeader(2, 3));

    const error = await uploadImagesAndReplaceUrls(
      [imageQuestion('assets/diagram.png')],
      qtiDir,
      {
        async uploadImage() {
          throw new Error('Cloudinary upload POST failed: 500 Internal Server Error');
        },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ImageUploadError);
    expect(isTrackAuthenticationError(error)).toBe(false);
    expect(getPublishFailureExitCode(error)).toBe(1);
  });

  it('writes a versioned cache atomically and reloads its entries', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-atomic-cache-'));
    const cachePath = join(qtiDir, 'nested', 'image-upload-cache.json');
    await saveImageUploadCache(cachePath, {
      version: 1,
      images: {
        'sha256:example': {
          sourceHash: 'sha256:example',
          url: 'https://cdn.example/image.png',
          relativePath: 'assets/image.png',
        },
      },
    });

    const content = JSON.parse(await readFile(cachePath, 'utf8')) as { version: number; images: object };
    expect(content).toEqual({
      version: 1,
      images: {
        'sha256:example': {
          sourceHash: 'sha256:example',
          url: 'https://cdn.example/image.png',
          relativePath: 'assets/image.png',
        },
      },
    });
    await expect(loadImageUploadCache(cachePath)).resolves.toEqual(content);
  });
});

function imageQuestion(src: string): TrackQuestionPayload {
  return {
    title: 'Image Question',
    questionKind: 3,
    status: 2,
    content: `<p><img src="${src}" alt="image" /></p>`,
    howToSolve: '',
    quizCategories: [99],
    availableApps: ['training'],
  };
}

function imageQuestionWithSources(sources: string[]): TrackQuestionPayload {
  const question = imageQuestion(sources[0] ?? 'assets/missing.png');
  question.content = `<p>${sources.map((src) => `<img src="${src}" alt="image" />`).join('')}</p>`;
  return question;
}

function trackApiError(status: number): TrackApiError {
  return new TrackApiError({
    method: 'POST',
    url: 'https://tracks.dev/api/images/upload-signature',
    status,
    statusText: status === 401 ? 'Unauthorized' : 'Forbidden',
    responseBody: status === 401 ? 'Unauthorized' : 'Forbidden',
    apiMessage: status === 401 ? 'Unauthorized' : 'Forbidden',
  });
}

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
