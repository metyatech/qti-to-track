import { readFile } from 'node:fs/promises';
import yaml from 'yaml';

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
  if (!filePath) {
    return {};
  }

  const content = await readFile(filePath, 'utf8');
  const parsed = yaml.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Track session file: ${filePath}`);
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
