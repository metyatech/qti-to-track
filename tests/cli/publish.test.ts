import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

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
});

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
