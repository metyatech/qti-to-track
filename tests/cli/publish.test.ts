import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureDir = resolve(repoRoot, 'test/fixtures/markdown-to-qti');
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
});
