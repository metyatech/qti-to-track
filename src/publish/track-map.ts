import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import yaml from 'yaml';
import type { TrackMaterialPayload, TrackQuestionPayload } from '@metyatech/track-tcm-api-client';
import type { TrackMaterialDraft } from '../types.js';
import type { PublishResult } from './publisher.js';

export interface TrackMapTarget {
  base_url: string;
  appspace: string;
}

export interface TrackMapQuestionEntry {
  track_question_id: number;
  title: string;
  source_hash: string;
  updated_at: string;
}

export interface TrackMapMaterialEntry {
  track_material_id: number;
  title: string;
  question_keys: string[];
  source_hash?: string;
  updated_at: string;
  release_id?: string;
}

export interface TrackMap {
  version: 1;
  target?: TrackMapTarget;
  questions?: Record<string, TrackMapQuestionEntry>;
  materials?: Record<string, TrackMapMaterialEntry>;
}

export async function loadTrackMap(filePath: string): Promise<TrackMap> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return { version: 1 };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(content);
  } catch (error) {
    throw invalidTrackMap(filePath, `could not parse YAML: ${errorMessage(error)}`);
  }

  validateTrackMap(parsed, filePath);
  return parsed;
}

export async function saveTrackMap(filePath: string, trackMap: TrackMap): Promise<void> {
  const content = yaml.stringify(trackMap, {
    sortMapEntries: (a: any, b: any) => {
      // Keep target at top, then materials, then questions
      const order = ['version', 'target', 'materials', 'questions'];
      const indexA = order.indexOf(a.key?.value ?? a.key);
      const indexB = order.indexOf(b.key?.value ?? b.key);
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return String(a.key?.value ?? a.key).localeCompare(String(b.key?.value ?? b.key));
    }
  });
  
  const directory = dirname(filePath);
  const tmpPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
    await rename(tmpPath, filePath);
  } catch (error) {
    try {
      await rm(tmpPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to save track-map and clean up temporary file "${tmpPath}"`);
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function validateTrackMap(value: unknown, filePath: string): asserts value is TrackMap {
  if (!isRecord(value)) {
    throw invalidTrackMap(filePath, 'expected a YAML mapping');
  }
  if (value.version !== 1) {
    throw invalidTrackMap(filePath, 'version must be 1');
  }

  if (value.target !== undefined) {
    if (!isRecord(value.target)) {
      throw invalidTrackMap(filePath, 'target must be a mapping');
    }
    requireString(value.target.base_url, 'target.base_url', filePath);
    requireString(value.target.appspace, 'target.appspace', filePath);
  }

  if (value.questions !== undefined) {
    validateEntries(value.questions, 'questions', filePath, (entry, key) => {
      requireId(entry.track_question_id, `questions.${key}.track_question_id`, filePath);
      requireString(entry.title, `questions.${key}.title`, filePath);
      requireString(entry.source_hash, `questions.${key}.source_hash`, filePath);
      requireString(entry.updated_at, `questions.${key}.updated_at`, filePath);
    });
  }

  if (value.materials !== undefined) {
    validateEntries(value.materials, 'materials', filePath, (entry, key) => {
      requireId(entry.track_material_id, `materials.${key}.track_material_id`, filePath);
      requireString(entry.title, `materials.${key}.title`, filePath);
      if (!Array.isArray(entry.question_keys) || !entry.question_keys.every(isNonEmptyString)) {
        throw invalidTrackMap(filePath, `materials.${key}.question_keys must be an array of non-empty strings`);
      }
      requireString(entry.updated_at, `materials.${key}.updated_at`, filePath);
      if (entry.source_hash !== undefined) {
        requireString(entry.source_hash, `materials.${key}.source_hash`, filePath);
      }
      if (entry.release_id !== undefined) {
        requireString(entry.release_id, `materials.${key}.release_id`, filePath);
      }
    });
  }
}

function validateEntries(
  value: unknown,
  section: string,
  filePath: string,
  validateEntry: (entry: Record<string, unknown>, key: string) => void,
): void {
  if (!isRecord(value)) {
    throw invalidTrackMap(filePath, `${section} must be a mapping`);
  }

  for (const [key, candidate] of Object.entries(value)) {
    if (!isNonEmptyString(key) || !isRecord(candidate)) {
      throw invalidTrackMap(filePath, `${section} entries must have non-empty keys and mapping values`);
    }
    validateEntry(candidate, key);
  }
}

function requireId(value: unknown, field: string, filePath: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidTrackMap(filePath, `${field} must be a positive safe integer`);
  }
}

function requireString(value: unknown, field: string, filePath: string): void {
  if (!isNonEmptyString(value)) {
    throw invalidTrackMap(filePath, `${field} must be a non-empty string`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidTrackMap(filePath: string, reason: string): Error {
  return new Error(`Invalid track-map at "${filePath}": ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hashTrackSource(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortForStableJson(nested)]),
  );
}

export function hashTrackPayload(payload: unknown): string {
  return hashTrackSource(stableJsonStringify(payload));
}

export function updateTrackMapForPublish(options: {
  trackMap: TrackMap;
  target: TrackMapTarget;
  baseKey: string;
  questionKeys: string[];
  materialKey: string;
  legacyMaterialKey?: string;
  questionPayloads: TrackQuestionPayload[];
  materialDraft: TrackMaterialDraft;
  materialPayload?: TrackMaterialPayload;
  result: PublishResult;
  updatedAt?: string;
}): TrackMap {
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const next: TrackMap = {
    ...options.trackMap,
    target: options.trackMap.target ?? options.target,
    questions: { ...(options.trackMap.questions ?? {}) },
    materials: options.trackMap.materials ? { ...options.trackMap.materials } : undefined,
  };

  options.questionPayloads.forEach((questionPayload, index) => {
    const trackQuestionId = options.result.trackQuestionIds[index];
    if (trackQuestionId === undefined) return;

    const questionKey = `${options.baseKey}/${options.questionKeys[index] ?? questionPayload.title}`;
    next.questions![questionKey] = {
      track_question_id: trackQuestionId,
      title: questionPayload.title,
      source_hash: hashTrackPayload(questionPayload),
      updated_at: updatedAt,
    };
  });

  if (
    options.result.materialAction !== 'skipped' &&
    options.result.trackMaterialId !== undefined &&
    options.materialPayload
  ) {
    next.materials = { ...(next.materials ?? {}) };
    const materialKey = `${options.baseKey}/${options.materialKey}`;
    const legacyMaterialKey = options.legacyMaterialKey === undefined
      ? undefined
      : `${options.baseKey}/${options.legacyMaterialKey}`;
    const previousReleaseId =
      options.trackMap.materials?.[materialKey]?.release_id ??
      (legacyMaterialKey === undefined ? undefined : options.trackMap.materials?.[legacyMaterialKey]?.release_id);
    next.materials[materialKey] = {
      track_material_id: options.result.trackMaterialId,
      title: options.materialDraft.title,
      question_keys: options.questionKeys.map((questionKey) => `${options.baseKey}/${questionKey}`),
      source_hash: hashTrackPayload(options.materialPayload),
      updated_at: updatedAt,
      release_id: options.result.trackReleaseId ?? previousReleaseId,
    };
    if (legacyMaterialKey !== undefined && legacyMaterialKey !== materialKey) {
      delete next.materials[legacyMaterialKey];
    }
  }

  if (Object.keys(next.questions ?? {}).length === 0) {
    delete next.questions;
  }

  return next;
}
