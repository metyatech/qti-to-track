import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadTrackMap, saveTrackMap, hashTrackSource, TrackMap } from '../../src/publish/track-map.js';
import { rm, writeFile } from 'node:fs/promises';

describe('track-map', () => {
  const TEST_FILE = 'tests/publish/test-track-map.yaml';

  afterEach(async () => {
    try {
      await rm(TEST_FILE);
    } catch (e) {}
  });

  it('loads empty defaults when file does not exist', async () => {
    const map = await loadTrackMap('tests/publish/nonexistent.yaml');
    expect(map).toEqual({ version: 1 });
  });

  it('saves and loads track map', async () => {
    const map: TrackMap = {
      version: 1,
      target: {
        base_url: 'https://tracks.dev',
        appspace: 'app'
      },
      questions: {
        'q1': {
          track_question_id: 100,
          title: 'Q1',
          source_hash: 'sha256:abc',
          updated_at: '2026-05-28T00:00:00.000Z'
        }
      }
    };

    await saveTrackMap(TEST_FILE, map);
    const loaded = await loadTrackMap(TEST_FILE);
    
    expect(loaded).toEqual(map);
  });

  it('hashes correctly', () => {
    const source = JSON.stringify({ a: 1 });
    const hash = hashTrackSource(source);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
