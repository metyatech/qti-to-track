import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'yaml';

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
