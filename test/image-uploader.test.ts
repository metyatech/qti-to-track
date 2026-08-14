import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uploadImagesAndReplaceUrls } from '../src/generator/image-uploader.js';
import type { TrackQuestionPayload } from '@metyatech/track-tcm-api-client';

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
});

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
