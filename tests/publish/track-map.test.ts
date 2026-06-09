import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadTrackMap, saveTrackMap, hashTrackSource, TrackMap, stableJsonStringify, updateTrackMapForPublish } from '../../src/publish/track-map.js';
import { rm, stat, writeFile } from 'node:fs/promises';

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

  it('stable stringifies API payloads independent of object key insertion order', () => {
    expect(stableJsonStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableJsonStringify({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it('updates questions and material entries from API payload hashes', () => {
    const updated = updateTrackMapForPublish({
      trackMap: { version: 1 },
      target: { base_url: 'https://tracks.dev', appspace: 'app' },
      baseKey: 'qti',
      questionKeys: ['q1'],
      materialKey: 'assessment-id',
      questionPayloads: [
        {
          title: 'Q1',
          questionKind: 1,
          status: 2,
          content: 'Pick',
          howToSolve: '',
          quizCategories: [99],
          availableApps: ['training'],
        },
      ],
      materialDraft: {
        title: 'Material',
        style: 1,
        status: 2,
        language: 'ja',
        basicTimeMinutes: 1,
        difficulty: 1,
        questionKeys: ['q1'],
        materialTypes: ['others'],
        availableApps: ['training'],
      },
      materialPayload: {
        title: 'Material',
        style: 1,
        status: 2,
        language: 'ja',
        basicTimeMinutes: 1,
        difficulty: 1,
        questionIds: [101],
        materialTypes: ['others'],
        availableApps: ['training'],
      },
      result: {
        trackQuestionIds: [101],
        trackMaterialId: 201,
        materialAction: 'created',
        trackReleaseId: 'rel-1',
      },
      updatedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(updated.questions?.['qti/q1']?.track_question_id).toBe(101);
    expect(updated.questions?.['qti/q1']?.source_hash).toMatch(/^sha256:/);
    expect(updated.materials?.['qti/assessment-id']).toMatchObject({
      track_material_id: 201,
      title: 'Material',
      source_hash: expect.stringMatching(/^sha256:/),
      release_id: 'rel-1',
    });
  });

  it('preserves an existing release ID when updating a material without a new release', () => {
    const updated = updateTrackMapForPublish({
      trackMap: {
        version: 1,
        materials: {
          'qti/Material': {
            track_material_id: 201,
            title: 'Material',
            question_keys: ['qti/q1'],
            source_hash: 'sha256:old',
            updated_at: '2026-05-29T00:00:00.000Z',
            release_id: 'rel-existing',
          },
        },
      },
      target: { base_url: 'https://tracks.dev', appspace: 'app' },
      baseKey: 'qti',
      questionKeys: ['q1'],
      materialKey: 'assessment-id',
      legacyMaterialKey: 'Material',
      questionPayloads: [
        {
          title: 'Q1',
          questionKind: 1,
          status: 2,
          content: 'Pick',
          howToSolve: '',
          quizCategories: [99],
          availableApps: ['training'],
        },
      ],
      materialDraft: {
        title: 'Material',
        style: 1,
        status: 2,
        language: 'ja',
        basicTimeMinutes: 1,
        difficulty: 1,
        questionKeys: ['q1'],
        materialTypes: ['others'],
        availableApps: ['training'],
      },
      materialPayload: {
        title: 'Material',
        style: 1,
        status: 2,
        language: 'ja',
        basicTimeMinutes: 1,
        difficulty: 1,
        questionIds: [101],
        materialTypes: ['others'],
        availableApps: ['training'],
      },
      result: {
        trackQuestionIds: [101],
        trackMaterialId: 201,
        materialAction: 'updated',
      },
      updatedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(updated.materials?.['qti/assessment-id']?.release_id).toBe('rel-existing');
    expect(updated.materials?.['qti/Material']).toBeUndefined();
  });

  it('keeps updating the same material when the display title changes', () => {
    const updated = updateTrackMapForPublish({
      trackMap: {
        version: 1,
        materials: {
          'qti/assessment-id': {
            track_material_id: 201,
            title: 'Old Title',
            question_keys: ['qti/q1'],
            source_hash: 'sha256:old',
            updated_at: '2026-05-29T00:00:00.000Z',
            release_id: 'rel-existing',
          },
        },
      },
      target: { base_url: 'https://tracks.dev', appspace: 'app' },
      baseKey: 'qti',
      questionKeys: ['q1'],
      materialKey: 'assessment-id',
      legacyMaterialKey: 'New Title',
      questionPayloads: [
        {
          title: 'Q1',
          questionKind: 1,
          status: 2,
          content: 'Pick',
          howToSolve: '',
          quizCategories: [99],
          availableApps: ['training'],
        },
      ],
      materialDraft: {
        title: 'New Title',
        style: 1,
        status: 2,
        language: 'ja',
        basicTimeMinutes: 1,
        difficulty: 1,
        questionKeys: ['q1'],
        materialTypes: ['others'],
        availableApps: ['training'],
      },
      materialPayload: {
        title: 'New Title',
        style: 1,
        status: 2,
        language: 'ja',
        basicTimeMinutes: 1,
        difficulty: 1,
        questionIds: [101],
        materialTypes: ['others'],
        availableApps: ['training'],
      },
      result: {
        trackQuestionIds: [101],
        trackMaterialId: 201,
        materialAction: 'updated',
      },
      updatedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(updated.materials?.['qti/assessment-id']).toMatchObject({
      track_material_id: 201,
      title: 'New Title',
      release_id: 'rel-existing',
    });
  });

  it('omits material entry when material is skipped', () => {
    const updated = updateTrackMapForPublish({
      trackMap: { version: 1 },
      target: { base_url: 'https://tracks.dev', appspace: 'app' },
      baseKey: 'qti',
      questionKeys: ['q1'],
      materialKey: 'assessment-id',
      questionPayloads: [
        {
          title: 'Q1',
          questionKind: 1,
          status: 2,
          content: 'Pick',
          howToSolve: '',
          quizCategories: [99],
          availableApps: ['training'],
        },
      ],
      materialDraft: {
        title: 'Material',
        style: 1,
        status: 2,
        language: 'ja',
        basicTimeMinutes: 1,
        difficulty: 1,
        questionKeys: ['q1'],
        materialTypes: ['others'],
        availableApps: ['training'],
      },
      result: {
        trackQuestionIds: [101],
        materialAction: 'skipped',
      },
      updatedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(updated.questions?.['qti/q1']).toBeDefined();
    expect(updated.materials).toBeUndefined();
  });

  it('can leave track-map completely untouched when disabled by caller', async () => {
    const content = 'version: 1\n';
    await writeFile(TEST_FILE, content, 'utf8');

    const before = await stat(TEST_FILE);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await stat(TEST_FILE);

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
