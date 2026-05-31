import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSession } from '../../src/cli/session.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadSession', () => {
  it('reads weekly-quiz-workbench track-login cookieHeader sessions', async () => {
    const dir = join(tmpdir(), `qti-to-track-session-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const sessionPath = join(dir, 'track-session.json');
    await writeFile(
      sessionPath,
      JSON.stringify({
        baseUrl: 'https://track.example.test',
        appspace: 'weekly-space',
        cookieHeader: 'sid=from-cookie-header',
        savedAt: '2026-05-31T00:00:00.000Z',
      }),
      'utf8',
    );

    await expect(loadSession(sessionPath)).resolves.toMatchObject({
      baseUrl: 'https://track.example.test',
      appspace: 'weekly-space',
      cookie: 'sid=from-cookie-header',
    });
  });

  it('prefers cookieHeader over legacy and nested cookie fields', async () => {
    const dir = join(tmpdir(), `qti-to-track-session-priority-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const sessionPath = join(dir, 'track-session.yaml');
    await writeFile(
      sessionPath,
      [
        'baseUrl: https://track.example.test',
        'appspace: weekly-space',
        'cookieHeader: sid=from-cookie-header',
        'cookie: sid=legacy',
        'credentials:',
        '  cookie: sid=nested',
      ].join('\n'),
      'utf8',
    );

    await expect(loadSession(sessionPath)).resolves.toMatchObject({
      cookie: 'sid=from-cookie-header',
    });
  });

  it('loads the weekly-quiz-workbench default session when no session path is supplied', async () => {
    const configRoot = join(
      tmpdir(),
      `qti-to-track-default-session-${process.pid}-${Date.now()}`,
    );
    vi.stubEnv('LOCALAPPDATA', configRoot);
    vi.stubEnv('APPDATA', configRoot);
    vi.stubEnv('XDG_CONFIG_HOME', configRoot);
    const sessionPath = join(
      configRoot,
      'weekly-quiz-workbench',
      'track-session.json',
    );
    await mkdir(join(configRoot, 'weekly-quiz-workbench'), {
      recursive: true,
    });
    await writeFile(
      sessionPath,
      JSON.stringify({
        baseUrl: 'https://track.example.test',
        appspace: 'default-weekly-space',
        cookieHeader: 'sid=default-cookie-header',
        savedAt: '2026-05-31T00:00:00.000Z',
      }),
      'utf8',
    );

    await expect(loadSession(undefined)).resolves.toMatchObject({
      baseUrl: 'https://track.example.test',
      appspace: 'default-weekly-space',
      cookie: 'sid=default-cookie-header',
    });
  });
});
