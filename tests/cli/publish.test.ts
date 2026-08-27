import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadTrackMap } from '../../src/publish/track-map.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = resolve(repoRoot, 'test/fixtures/canonical-qti');
const cliPath = resolve(repoRoot, 'dist/cli/index.js');

async function runPublish(args: string[]) {
  return await runPublishFromDir(fixtureDir, args);
}

async function runPublishFromDir(qtiDir: string, args: string[]) {
  return await execFileAsync(process.execPath, [cliPath, 'publish', '--qti-dir', qtiDir, '--json', ...args], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
    },
  });
}

describe('publish CLI', () => {
  it('dry-runs through payload generation without credentials', async () => {
    const { stdout } = await runPublish([]);

    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain('"trackQuestionIds"');
    expect(stdout).toContain('"materialAction": "dry-run"');
  });

  it('supports --no-material in dry-run results', async () => {
    const { stdout } = await runPublish(['--no-material']);

    expect(stdout).toContain('"dryRun": true');
    expect(stdout).toContain('"materialAction": "skipped"');
    expect(stdout).not.toContain('"trackMaterialId"');
  });

  it('rejects --track-map with --no-track-map', async () => {
    await expect(runPublish(['--track-map', 'track-map.yaml', '--no-track-map'])).rejects.toMatchObject({
      stderr: expect.stringContaining('--track-map and --no-track-map cannot be used together'),
    });
  });

  it('requires credentials when --check-existing is used during dry-run', async () => {
    await expect(runPublish(['--check-existing'])).rejects.toMatchObject({
      stderr: expect.stringContaining('Track appspace is required'),
    });
  });

  it('uses track-map target as publish target defaults', async () => {
    const trackMapPath = await writeTrackMapTarget({
      baseUrl: 'https://tracks.example.test',
      appspace: 'map-appspace',
    });

    await expect(
      runPublish(['--track-map', trackMapPath, '--check-existing']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Track credentials are required'),
    });
  });

  it('rejects publish target values that conflict with track-map target', async () => {
    const trackMapPath = await writeTrackMapTarget({
      baseUrl: 'https://tracks.example.test',
      appspace: 'map-appspace',
    });

    await expect(
      runPublish([
        '--track-map',
        trackMapPath,
        '--base-url',
        'https://other.example.test',
        '--appspace',
        'other-appspace',
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('conflicts with Track map target'),
    });
  });

  it('returns the auth exit code and saves partial question IDs before exiting', async () => {
    const dir = join(tmpdir(), `qti-to-track-auth-publish-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const trackMapPath = join(dir, 'track-map.yaml');
    let createCount = 0;
    const server = createMockTrackServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/questions') {
        response.statusCode = 404;
        response.end('Not Found');
        return;
      }

      createCount += 1;
      if (createCount === 3) {
        response.statusCode = 401;
        response.statusMessage = 'Unauthorized';
        response.end('Unauthorized');
        return;
      }

      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { id: 100 + createCount, title: `Question ${createCount}` } }));
    });
    const port = await listenMockTrackServer(server);

    try {
      const error = await runPublish([
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--track-map',
        trackMapPath,
        '--no-material',
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(3);
      expect(error?.code).not.toBe(3221226505);
      expect(error?.stderr).toContain('401');
      expect(createCount).toBe(3);

      const trackMap = await loadTrackMap(trackMapPath);
      expect(trackMap.questions).toMatchObject({
        'qti/choice-item': { track_question_id: 101 },
        'qti/cloze-item': { track_question_id: 102 },
      });
      expect(trackMap.questions?.['qti/descriptive-item']).toBeUndefined();
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses successful image uploads from the cache after one auth retry', async () => {
    const dir = join(tmpdir(), `qti-to-track-image-auth-retry-${process.pid}-${Date.now()}`);
    const qtiDir = await writeTwoImageQtiFixture(dir);
    const cachePath = join(dir, 'image-upload-cache.json');

    let port = 0;
    let signatureRequests = 0;
    let cloudinaryUploads = 0;
    let questionRequests = 0;
    const server = createMockTrackServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/images/upload-signature') {
        signatureRequests += 1;
        if (signatureRequests === 2) {
          response.statusCode = 401;
          response.statusMessage = 'Unauthorized';
          response.end('Unauthorized');
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          result: {
            timestamp: '1',
            api_key: 'test-key',
            signature: 'test-signature',
            tags: '',
            url: `http://127.0.0.1:${port}/cloudinary`,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/cloudinary') {
        cloudinaryUploads += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ secure_url: `https://cdn.example/image-${cloudinaryUploads}.png` }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/questions') {
        questionRequests += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ result: { id: 100 + questionRequests, title: `Question ${questionRequests}` } }));
        return;
      }
      response.statusCode = 404;
      response.end('Not Found');
    });
    port = await listenMockTrackServer(server);

    try {
      const publishArgs = [
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--no-track-map',
        '--no-material',
        '--upload-images',
        '--image-upload-cache',
        cachePath,
        '--yes',
      ];
      const firstError = await runPublishFromDir(qtiDir, publishArgs).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(firstError).toBeDefined();
      expect(firstError?.code).toBe(3);
      expect(firstError?.code).not.toBe(3221226505);
      expect(firstError?.stderr).toContain('401');
      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
        version: number;
        images: Record<string, { url: string; relativePath?: string }>;
      };
      expect(cache.version).toBe(1);
      expect(Object.values(cache.images)).toContainEqual(expect.objectContaining({
        url: 'https://cdn.example/image-1.png',
        relativePath: 'assets/one.png',
      }));

      const secondResult = await runPublishFromDir(qtiDir, publishArgs);
      expect(secondResult.stdout).toContain('"dryRun": false');
      expect(signatureRequests).toBe(3);
      expect(cloudinaryUploads).toBe(2);
      expect(questionRequests).toBe(3);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downgrades a later auth failure when completed image uploads have no retry cache', async () => {
    const dir = join(tmpdir(), `qti-to-track-image-later-auth-unsafe-${process.pid}-${Date.now()}`);
    const qtiDir = await writeTwoImageQtiFixture(dir);
    let port = 0;
    let signatureRequests = 0;
    let cloudinaryUploads = 0;
    let questionRequests = 0;
    const server = createMockTrackServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/images/upload-signature') {
        signatureRequests += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          result: {
            timestamp: '1',
            api_key: 'test-key',
            signature: 'test-signature',
            tags: '',
            url: `http://127.0.0.1:${port}/cloudinary`,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/cloudinary') {
        cloudinaryUploads += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ secure_url: `https://cdn.example/image-${cloudinaryUploads}.png` }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/questions') {
        questionRequests += 1;
        response.statusCode = 401;
        response.statusMessage = 'Unauthorized';
        response.end('Unauthorized');
        return;
      }
      response.statusCode = 404;
      response.end('Not Found');
    });
    port = await listenMockTrackServer(server);

    try {
      const error = await runPublishFromDir(qtiDir, [
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--no-track-map',
        '--no-material',
        '--upload-images',
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(1);
      expect(error?.code).not.toBe(3);
      expect(error?.code).not.toBe(3221226505);
      expect(error?.stderr).toContain('401');
      expect(error?.stderr).toContain('Automatic authentication retry is unsafe because image upload progress could not be persisted.');
      expect(signatureRequests).toBe(2);
      expect(cloudinaryUploads).toBe(2);
      expect(questionRequests).toBe(1);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a later auth failure retryable when completed image uploads are cached', async () => {
    const dir = join(tmpdir(), `qti-to-track-image-later-auth-safe-${process.pid}-${Date.now()}`);
    const qtiDir = await writeTwoImageQtiFixture(dir);
    const cachePath = join(dir, 'image-upload-cache.json');
    let port = 0;
    let signatureRequests = 0;
    let cloudinaryUploads = 0;
    const server = createMockTrackServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/images/upload-signature') {
        signatureRequests += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          result: {
            timestamp: '1',
            api_key: 'test-key',
            signature: 'test-signature',
            tags: '',
            url: `http://127.0.0.1:${port}/cloudinary`,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/cloudinary') {
        cloudinaryUploads += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ secure_url: `https://cdn.example/image-${cloudinaryUploads}.png` }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/questions') {
        response.statusCode = 401;
        response.statusMessage = 'Unauthorized';
        response.end('Unauthorized');
        return;
      }
      response.statusCode = 404;
      response.end('Not Found');
    });
    port = await listenMockTrackServer(server);

    try {
      const error = await runPublishFromDir(qtiDir, [
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--no-track-map',
        '--no-material',
        '--upload-images',
        '--image-upload-cache',
        cachePath,
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(3);
      expect(error?.code).not.toBe(3221226505);
      expect(error?.stderr).toContain('401');
      expect(error?.stderr).not.toContain('Automatic authentication retry is unsafe because image upload progress could not be persisted.');
      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as {
        version: number;
        images: Record<string, unknown>;
      };
      expect(cache.version).toBe(1);
      expect(Object.keys(cache.images)).toHaveLength(2);
      expect(signatureRequests).toBe(2);
      expect(cloudinaryUploads).toBe(2);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('combines safe image progress with safe partial question progress', async () => {
    const dir = join(tmpdir(), `qti-to-track-image-partial-safe-${process.pid}-${Date.now()}`);
    const qtiDir = await writeTwoImageQtiFixture(dir);
    const cachePath = join(dir, 'image-upload-cache.json');
    const trackMapPath = join(dir, 'track-map.yaml');
    let port = 0;
    let createCount = 0;
    const server = createMockTrackServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/images/upload-signature') {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          result: {
            timestamp: '1',
            api_key: 'test-key',
            signature: 'test-signature',
            tags: '',
            url: `http://127.0.0.1:${port}/cloudinary`,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/cloudinary') {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ secure_url: 'https://cdn.example/image.png' }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/questions') {
        createCount += 1;
        if (createCount === 2) {
          response.statusCode = 401;
          response.statusMessage = 'Unauthorized';
          response.end('Unauthorized');
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ result: { id: 200 + createCount, title: `Question ${createCount}` } }));
        return;
      }
      response.statusCode = 404;
      response.end('Not Found');
    });
    port = await listenMockTrackServer(server);

    try {
      const error = await runPublishFromDir(qtiDir, [
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--track-map',
        trackMapPath,
        '--no-material',
        '--upload-images',
        '--image-upload-cache',
        cachePath,
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(3);
      expect(error?.stderr).toContain('401');
      expect(error?.stderr).not.toContain('Automatic authentication retry is unsafe because image upload progress could not be persisted.');
      const trackMap = await loadTrackMap(trackMapPath);
      expect(trackMap.questions?.['qti/choice-item']).toMatchObject({ track_question_id: 201 });
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not retry when partial question progress is unsafe even if images are cached', async () => {
    const dir = join(tmpdir(), `qti-to-track-image-partial-map-unsafe-${process.pid}-${Date.now()}`);
    const qtiDir = await writeTwoImageQtiFixture(dir);
    const cachePath = join(dir, 'image-upload-cache.json');
    const trackMapPath = join(dir, 'missing-parent', 'track-map.yaml');
    let port = 0;
    let createCount = 0;
    const server = createMockTrackServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/images/upload-signature') {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          result: {
            timestamp: '1',
            api_key: 'test-key',
            signature: 'test-signature',
            tags: '',
            url: `http://127.0.0.1:${port}/cloudinary`,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/cloudinary') {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ secure_url: 'https://cdn.example/image.png' }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/questions') {
        createCount += 1;
        if (createCount === 2) {
          response.statusCode = 401;
          response.statusMessage = 'Unauthorized';
          response.end('Unauthorized');
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ result: { id: 300 + createCount, title: `Question ${createCount}` } }));
        return;
      }
      response.statusCode = 404;
      response.end('Not Found');
    });
    port = await listenMockTrackServer(server);

    try {
      const error = await runPublishFromDir(qtiDir, [
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--track-map',
        trackMapPath,
        '--no-material',
        '--upload-images',
        '--image-upload-cache',
        cachePath,
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(1);
      expect(error?.code).not.toBe(3);
      expect(error?.stderr).toContain('401');
      expect(error?.stderr).toContain('Failed to save partial track-map');
      expect(error?.stderr).toContain('Automatic authentication retry is unsafe because partial publish progress could not be persisted.');
      expect(error?.stderr).not.toContain('Automatic authentication retry is unsafe because image upload progress could not be persisted.');
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats image cache hits as safe for a later auth failure', async () => {
    const dir = join(tmpdir(), `qti-to-track-image-cache-hit-auth-${process.pid}-${Date.now()}`);
    const qtiDir = await writeTwoImageQtiFixture(dir);
    const cachePath = join(dir, 'image-upload-cache.json');
    let port = 0;
    let failQuestions = false;
    let signatureRequests = 0;
    let cloudinaryUploads = 0;
    let questionRequests = 0;
    const server = createMockTrackServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/images/upload-signature') {
        signatureRequests += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          result: {
            timestamp: '1',
            api_key: 'test-key',
            signature: 'test-signature',
            tags: '',
            url: `http://127.0.0.1:${port}/cloudinary`,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/cloudinary') {
        cloudinaryUploads += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ secure_url: `https://cdn.example/image-${cloudinaryUploads}.png` }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/questions') {
        questionRequests += 1;
        if (failQuestions) {
          response.statusCode = 401;
          response.statusMessage = 'Unauthorized';
          response.end('Unauthorized');
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ result: { id: 400 + questionRequests, title: `Question ${questionRequests}` } }));
        return;
      }
      response.statusCode = 404;
      response.end('Not Found');
    });
    port = await listenMockTrackServer(server);

    try {
      const publishArgs = [
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--no-track-map',
        '--no-material',
        '--upload-images',
        '--image-upload-cache',
        cachePath,
        '--yes',
      ];
      await runPublishFromDir(qtiDir, publishArgs);
      failQuestions = true;
      const error = await runPublishFromDir(qtiDir, publishArgs).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(3);
      expect(error?.code).not.toBe(3221226505);
      expect(error?.stderr).toContain('401');
      expect(error?.stderr).not.toContain('Automatic authentication retry is unsafe because image upload progress could not be persisted.');
      expect(signatureRequests).toBe(2);
      expect(cloudinaryUploads).toBe(2);
      expect(questionRequests).toBe(4);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns ordinary failure when image progress has no retry cache', async () => {
    const dir = join(tmpdir(), `qti-to-track-image-unsafe-${process.pid}-${Date.now()}`);
    const qtiDir = await writeTwoImageQtiFixture(dir);
    let port = 0;
    let signatureRequests = 0;
    let cloudinaryUploads = 0;
    const server = createMockTrackServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/images/upload-signature') {
        signatureRequests += 1;
        if (signatureRequests === 2) {
          response.statusCode = 401;
          response.statusMessage = 'Unauthorized';
          response.end('Unauthorized');
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          result: {
            timestamp: '1',
            api_key: 'test-key',
            signature: 'test-signature',
            tags: '',
            url: `http://127.0.0.1:${port}/cloudinary`,
          },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/cloudinary') {
        cloudinaryUploads += 1;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ secure_url: `https://cdn.example/image-${cloudinaryUploads}.png` }));
        return;
      }
      response.statusCode = 404;
      response.end('Not Found');
    });
    port = await listenMockTrackServer(server);

    try {
      const error = await runPublishFromDir(qtiDir, [
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--no-track-map',
        '--no-material',
        '--upload-images',
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(1);
      expect(error?.code).not.toBe(3);
      expect(error?.code).not.toBe(3221226505);
      expect(error?.stderr).toContain('401');
      expect(error?.stderr).toContain('Automatic authentication retry is unsafe because image upload progress could not be persisted.');
      expect(signatureRequests).toBe(2);
      expect(cloudinaryUploads).toBe(1);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns an ordinary failure exit code for a non-auth Track error', async () => {
    const dir = join(tmpdir(), `qti-to-track-ordinary-publish-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    let requestCount = 0;
    const server = createMockTrackServer((_request, response) => {
      requestCount += 1;
      response.statusCode = 500;
      response.statusMessage = 'Internal Server Error';
      response.end('Internal Server Error');
    });
    const port = await listenMockTrackServer(server);

    try {
      const error = await runPublish([
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--track-map',
        join(dir, 'track-map.yaml'),
        '--no-material',
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(1);
      expect(error?.code).not.toBe(3);
      expect(error?.code).not.toBe(3221226505);
      expect(error?.stderr).toContain('500');
      expect(requestCount).toBe(1);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the original auth error when partial track-map persistence fails', async () => {
    const dir = join(tmpdir(), `qti-to-track-map-save-failure-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    let createCount = 0;
    const server = createMockTrackServer((_request, response) => {
      createCount += 1;
      if (createCount === 2) {
        response.statusCode = 401;
        response.statusMessage = 'Unauthorized';
        response.end('Unauthorized');
        return;
      }

      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { id: 101, title: 'Question 1' } }));
    });
    const port = await listenMockTrackServer(server);

    try {
      const error = await runPublish([
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--track-map',
        join(dir, 'missing-parent', 'track-map.yaml'),
        '--no-material',
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(1);
      expect(error?.code).not.toBe(3);
      expect(error?.stderr).toContain('401');
      expect(error?.stderr).toContain('Failed to save partial track-map');
      expect(error?.stderr).toContain('Automatic authentication retry is unsafe because partial publish progress could not be persisted.');
      expect(createCount).toBe(2);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([401, 403])('returns an ordinary failure when partial progress has no track-map: %s', async (status) => {
    const dir = join(tmpdir(), `qti-to-track-no-map-partial-${process.pid}-${Date.now()}-${status}`);
    await mkdir(dir, { recursive: true });
    let requestCount = 0;
    const server = createMockTrackServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 2) {
        response.statusCode = status;
        response.statusMessage = status === 401 ? 'Unauthorized' : 'Forbidden';
        response.end(response.statusMessage);
        return;
      }

      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: { id: 100 + requestCount, title: `Question ${requestCount}` } }));
    });
    const port = await listenMockTrackServer(server);

    try {
      const error = await runPublish([
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--no-track-map',
        '--no-material',
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(1);
      expect(error?.code).not.toBe(3);
      expect(error?.code).not.toBe(3221226505);
      expect(error?.stderr).toContain(String(status));
      expect(error?.stderr).toContain('Automatic authentication retry is unsafe because partial publish progress could not be persisted.');
      expect(requestCount).toBe(2);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([401, 403])('returns the auth exit code when 401/403 occurs before any side effect: %s', async (status) => {
    const dir = join(tmpdir(), `qti-to-track-no-partial-auth-${process.pid}-${Date.now()}-${status}`);
    await mkdir(dir, { recursive: true });
    let requestCount = 0;
    const server = createMockTrackServer((_request, response) => {
      requestCount += 1;
      response.statusCode = status;
      response.statusMessage = status === 401 ? 'Unauthorized' : 'Forbidden';
      response.end(response.statusMessage);
    });
    const port = await listenMockTrackServer(server);

    try {
      const error = await runPublish([
        '--base-url',
        `http://127.0.0.1:${port}`,
        '--appspace',
        'test-appspace',
        '--cookie',
        'sid=test',
        '--no-track-map',
        '--no-material',
        '--yes',
      ]).then(
        () => undefined,
        (publishError: { code?: number; stderr?: string }) => publishError,
      );

      expect(error).toBeDefined();
      expect(error?.code).toBe(3);
      expect(error?.code).not.toBe(3221226505);
      expect(error?.stderr).toContain(String(status));
      expect(error?.stderr).not.toContain('Automatic authentication retry is unsafe');
      expect(requestCount).toBe(1);
    } finally {
      await closeMockTrackServer(server);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not call process.exit from the CLI async actions', async () => {
    const source = await readFile(resolve(repoRoot, 'src/cli/index.ts'), 'utf8');

    expect(source).not.toMatch(/process\.exit\(/u);
  });
});

function createMockTrackServer(
  handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void,
): Server {
  return createServer(handler);
}

async function listenMockTrackServer(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Mock Track server did not expose a TCP address');
  }
  return address.port;
}

async function closeMockTrackServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

async function writeTrackMapTarget(target: {
  baseUrl: string;
  appspace: string;
}): Promise<string> {
  const dir = join(
    tmpdir(),
    `qti-to-track-map-target-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  const trackMapPath = join(dir, 'track-map.yaml');
  await writeFile(
    trackMapPath,
    `version: 1\ntarget:\n  base_url: ${target.baseUrl}\n  appspace: ${target.appspace}\n`,
    'utf8',
  );
  return trackMapPath;
}

async function writeTwoImageQtiFixture(dir: string): Promise<string> {
  const qtiDir = join(dir, 'qti');
  await cp(fixtureDir, qtiDir, { recursive: true });
  await mkdir(join(qtiDir, 'assets'), { recursive: true });
  await writeFile(join(qtiDir, 'assets', 'one.png'), pngHeader(2, 3));
  await writeFile(join(qtiDir, 'assets', 'two.png'), pngHeader(4, 5));
  const descriptiveItemPath = join(qtiDir, 'items', 'descriptive-item.qti.xml');
  const descriptiveItem = await readFile(descriptiveItemPath, 'utf8');
  await writeFile(
    descriptiveItemPath,
    descriptiveItem.replace(
      '<img src="assets/diagram.png" alt="Cell diagram" />',
      '<img src="assets/one.png" alt="First image" /><img src="assets/two.png" alt="Second image" />',
    ),
    'utf8',
  );
  return qtiDir;
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
