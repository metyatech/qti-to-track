import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
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
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = yaml.parse(content);
    if (parsed && parsed.version === 1) {
      return parsed as TrackMap;
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  return { version: 1 };
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
  
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
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
    const questionKey = `${options.baseKey}/${options.questionKeys[index] ?? questionPayload.title}`;
    next.questions![questionKey] = {
      track_question_id: options.result.trackQuestionIds[index] ?? 0,
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
    const materialKey = `${options.baseKey}/${options.materialDraft.title}`;
    next.materials[materialKey] = {
      track_material_id: options.result.trackMaterialId,
      title: options.materialDraft.title,
      question_keys: options.questionKeys.map((questionKey) => `${options.baseKey}/${questionKey}`),
      source_hash: hashTrackPayload(options.materialPayload),
      updated_at: updatedAt,
      release_id: options.result.trackReleaseId,
    };
  }

  if (Object.keys(next.questions ?? {}).length === 0) {
    delete next.questions;
  }

  return next;
}
