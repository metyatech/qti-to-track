import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uploadImagesAndReplaceUrls } from '../src/generator/image-uploader.js';
import type { TrackQuestionPayload } from '@metyatech/track-tcm-api-client';

function question(content: string): TrackQuestionPayload {
  return {
    title: 'Image Question',
    questionKind: 3,
    status: 2,
    content,
    howToSolve: 'Review ![solution](assets/diagram.png)',
    choices: [{ content: 'Pick ![choice](assets/diagram.png)', correct: true }],
    quizCategories: [99],
    availableApps: ['training'],
  };
}

describe('uploadImagesAndReplaceUrls', () => {
  it('uploads local images and replaces every matching Track payload field', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), 'png');

    const uploadedFiles: string[] = [];
    const [updated] = await uploadImagesAndReplaceUrls(
      [question('Explain ![diagram](assets/diagram.png)')],
      qtiDir,
      {
        async uploadImage(file, filename) {
          uploadedFiles.push(`${filename}:${String(file.size)}`);
          return `https://res.cloudinary.example/${filename}`;
        },
      }
    );

    expect(uploadedFiles).toEqual(['diagram.png:3']);
    expect(updated?.content).toBe(
      'Explain ![diagram](https://res.cloudinary.example/diagram.png)'
    );
    expect(updated?.howToSolve).toBe(
      'Review ![solution](https://res.cloudinary.example/diagram.png)'
    );
    expect(updated?.choices?.[0]?.content).toBe(
      'Pick ![choice](https://res.cloudinary.example/diagram.png)'
    );
  });

  it('fails instead of keeping a local image path when upload fails', async () => {
    const qtiDir = await mkdtemp(join(tmpdir(), 'qti-to-track-images-'));
    await mkdir(join(qtiDir, 'assets'));
    await writeFile(join(qtiDir, 'assets', 'diagram.png'), 'png');

    await expect(
      uploadImagesAndReplaceUrls(
        [question('Explain ![diagram](assets/diagram.png)')],
        qtiDir,
        {
          async uploadImage() {
            throw new Error('Invalid Signature');
          },
        }
      )
    ).rejects.toThrow(/Failed to upload image .*assets.*diagram\.png: Invalid Signature/u);
  });
});
