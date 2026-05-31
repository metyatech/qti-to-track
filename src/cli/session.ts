import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'yaml';

const WORKBENCH_CONFIG_DIR_NAME = 'weekly-quiz-workbench';
const WORKBENCH_SESSION_FILE_NAME = 'track-session.json';

export interface TrackSession {
  baseUrl?: string;
  appspace?: string;
  cookie?: string;
  authorization?: string;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function readNestedString(record: Record<string, unknown>, path: string[]): string | undefined {
  let value: unknown = record;
  for (const segment of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    value = (value as Record<string, unknown>)[segment];
  }

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function loadSession(filePath: string | undefined): Promise<TrackSession> {
  const resolvedPath = filePath ?? getDefaultWorkbenchSessionPath();

  let content: string;
  try {
    content = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (filePath === undefined && isNodeErrorCode(error, 'ENOENT')) {
      return {};
    }
    throw error;
  }
  const parsed = yaml.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Track session file: ${resolvedPath}`);
  }

  const record = parsed as Record<string, unknown>;
  return {
    baseUrl: pickString(
      record.baseUrl,
      record.base_url,
      readNestedString(record, ['target', 'base_url']),
      readNestedString(record, ['target', 'baseUrl']),
    ),
    appspace: pickString(
      record.appspace,
      readNestedString(record, ['target', 'appspace']),
      readNestedString(record, ['track', 'appspace']),
    ),
    cookie: pickString(
      record.cookieHeader,
      record.cookie,
      readNestedString(record, ['credentials', 'cookie']),
      readNestedString(record, ['auth', 'cookie']),
      readNestedString(record, ['track', 'cookie']),
    ),
    authorization: pickString(
      record.authorization,
      readNestedString(record, ['credentials', 'authorization']),
      readNestedString(record, ['auth', 'authorization']),
      readNestedString(record, ['track', 'authorization']),
    ),
  };
}

export function getDefaultWorkbenchSessionPath(): string {
  const configRoot =
    process.env.LOCALAPPDATA ??
    process.env.APPDATA ??
    process.env.XDG_CONFIG_HOME ??
    join(homedir(), '.config');
  return join(
    configRoot,
    WORKBENCH_CONFIG_DIR_NAME,
    WORKBENCH_SESSION_FILE_NAME,
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
