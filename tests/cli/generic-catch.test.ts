import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { mockPublishToTrack, mockUploadImagesAndReplaceUrls } = vi.hoisted(() => ({
  mockPublishToTrack: vi.fn(),
  mockUploadImagesAndReplaceUrls: vi.fn(),
}));

vi.mock('../../src/publish/publisher.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/publish/publisher.js')>(
    '../../src/publish/publisher.js',
  );
  return { ...actual, publishToTrack: mockPublishToTrack };
});

vi.mock('../../src/generator/image-uploader.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/generator/image-uploader.js')>(
    '../../src/generator/image-uploader.js',
  );
  return { ...actual, uploadImagesAndReplaceUrls: mockUploadImagesAndReplaceUrls };
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = resolve(repoRoot, 'test/fixtures/canonical-qti');

interface ImageRetryState {
  uploadedImageCount: number;
  hasRemoteProgress: boolean;
  retryStatePersisted: boolean;
}

describe('publish CLI generic auth catch', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([401, 403])('returns ordinary failure for unsafe image progress: %s', async (status) => {
    const result = await runGenericCatch(
      { kind: 'track', status },
      {
        uploadedImageCount: 1,
        hasRemoteProgress: true,
        retryStatePersisted: false,
      },
      `unsafe-${status}`,
    );

    expect(result.exitCode).toBe(1);
    expect(result.exitCode).not.toBe(3);
    expect(result.stderr).toContain('Automatic authentication retry is unsafe because image upload progress could not be persisted.');
    expect(mockPublishToTrack).toHaveBeenCalledTimes(1);
    expect(mockUploadImagesAndReplaceUrls).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('returns the auth exit code for persisted image progress: %s', async (status) => {
    const result = await runGenericCatch(
      { kind: 'track', status },
      {
        uploadedImageCount: 1,
        hasRemoteProgress: true,
        retryStatePersisted: true,
      },
      `safe-persisted-${status}`,
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).not.toContain('Automatic authentication retry is unsafe');
  });

  it('returns the auth exit code when image progress has no remote side effect', async () => {
    const result = await runGenericCatch(
      { kind: 'track', status: 401 },
      {
        uploadedImageCount: 0,
        hasRemoteProgress: false,
        retryStatePersisted: true,
      },
      'safe-empty',
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).not.toContain('Automatic authentication retry is unsafe');
  });

  it('returns ordinary failure for a generic non-auth error', async () => {
    const result = await runGenericCatch(
      { kind: 'ordinary' },
      {
        uploadedImageCount: 1,
        hasRemoteProgress: true,
        retryStatePersisted: false,
      },
      'ordinary',
    );

    expect(result.exitCode).toBe(1);
    expect(result.exitCode).not.toBe(3);
    expect(result.stderr).not.toContain('Automatic authentication retry is unsafe');
  });
});

async function runGenericCatch(
  errorSpec: { kind: 'track'; status: number } | { kind: 'ordinary' },
  imageRetryState: ImageRetryState,
  _invocationId: string,
): Promise<{ exitCode: number | string | undefined; stderr: string }> {
  vi.resetModules();
  const error =
    errorSpec.kind === 'track'
      ? new (await import('@metyatech/track-tcm-api-client')).TrackApiError({
          method: 'POST',
          url: 'https://tracks.dev/api/questions',
          status: errorSpec.status,
          statusText: errorSpec.status === 401 ? 'Unauthorized' : errorSpec.status === 403 ? 'Forbidden' : 'Error',
          responseBody: errorSpec.status === 401 ? 'Unauthorized' : errorSpec.status === 403 ? 'Forbidden' : 'Error',
          apiMessage: errorSpec.status === 401 ? 'Unauthorized' : errorSpec.status === 403 ? 'Forbidden' : 'Error',
        })
      : new Error('Internal Server Error');

  mockUploadImagesAndReplaceUrls.mockImplementationOnce(
    async <T>(questions: T[], _qtiDir: string, _apiClient: unknown, options: { progress?: ImageRetryState }) => {
      if (options.progress !== undefined) {
        Object.assign(options.progress, imageRetryState);
      }
      return questions;
    },
  );
  mockPublishToTrack.mockImplementationOnce(async () => {
    throw error;
  });

  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const stderr: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });

  process.argv = [
    process.execPath,
    'qti-to-track',
    'publish',
    '--qti-dir',
    fixtureDir,
    '--appspace',
    'test-appspace',
    '--cookie',
    'sid=test',
    '--no-track-map',
    '--no-material',
    '--upload-images',
    '--yes',
    '--json',
  ];
  process.exitCode = 0;

  try {
    await import('../../src/cli/index.js?generic-catch');
    return { exitCode: process.exitCode, stderr: stderr.join('\n') };
  } finally {
    errorSpy.mockRestore();
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
  }
}
