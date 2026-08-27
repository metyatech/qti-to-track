import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  return await execFileAsync(process.execPath, [cliPath, 'publish', '--qti-dir', fixtureDir, '--json', ...args], {
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
      expect(error?.code).toBe(3);
      expect(error?.stderr).toContain('401');
      expect(error?.stderr).toContain('Failed to save partial track-map');
      expect(createCount).toBe(2);
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
