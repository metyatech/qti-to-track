import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSession } from '../../src/cli/session.js';

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
});
