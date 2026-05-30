import { describe, it, expect, vi } from 'vitest';
import { publishToTrack, toTrackMaterialPayload } from '../../src/publish/publisher.js';
import type { TrackApiClient, TrackMaterialPayload, TrackQuestionPayload } from '@metyatech/track-tcm-api-client';
import type { TrackMaterialDraft } from '../../src/types.js';

describe('publishToTrack', () => {
  const mockMaterialDraft: TrackMaterialDraft = {
    title: 'Test Material',
    style: 1,
    status: 2,
    language: 'ja',
    basicTimeMinutes: 10,
    difficulty: 1,
    questionKeys: ['Q1'],
    materialTypes: ['others'],
    availableApps: ['training']
  };

  const mockMaterialPayload: TrackMaterialPayload = {
    title: 'Test Material',
    style: 1,
    status: 2,
    language: 'ja',
    basicTimeMinutes: 10,
    difficulty: 1,
    questionIds: [101],
    materialTypes: ['others'],
    availableApps: ['training']
  };

  const mockQuestionPayloads: TrackQuestionPayload[] = [
    {
      title: 'Q1',
      questionKind: 1,
      status: 2,
      content: 'Hello',
      howToSolve: '',
      quizCategories: [99],
      availableApps: ['training']
    }
  ];

  it('creates new items when not dry-run and no duplicates exist', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([]),
      createQuestion: vi.fn().mockResolvedValue({ id: 101, title: 'Q1' }),
      findMaterialsByTitle: vi.fn().mockResolvedValue([]),
      createMaterial: vi.fn().mockResolvedValue({ id: 201, title: 'Test Material' }),
      createRelease: vi.fn().mockResolvedValue({ id: 'rel-123' }),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: false,
    });
    
    expect(result.trackQuestionIds).toEqual([101]);
    expect(result.trackMaterialId).toBe(201);
    expect(result.trackReleaseId).toBe('rel-123');

    expect(mockClient.createQuestion).toHaveBeenCalledWith(mockQuestionPayloads[0]);
    expect(mockClient.createMaterial).toHaveBeenCalledWith({
      ...mockMaterialPayload,
      questionIds: [101]
    });
    expect(mockClient.createRelease).toHaveBeenCalled();
  });

  it('fails when duplicate question exists and adopt-existing is false', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([{ id: 101, title: 'Q1' }]),
    } as unknown as TrackApiClient;

    await expect(publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: false,
    }))
      .rejects.toThrow(/Duplicate question found/);
  });

  it('adopts existing items when adopt-existing is true', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([{ id: 101, title: 'Q1' }]),
      updateQuestion: vi.fn().mockResolvedValue({ id: 101, title: 'Q1' }),
      findMaterialsByTitle: vi.fn().mockResolvedValue([{ id: 201, title: 'Test Material' }]),
      updateMaterial: vi.fn().mockResolvedValue({ id: 201, title: 'Test Material' }),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: true,
    });

    expect(result.trackQuestionIds).toEqual([101]);
    expect(result.trackMaterialId).toBe(201);
    expect(result.trackReleaseId).toBeUndefined(); // Adopting doesn't create release

    expect(mockClient.updateQuestion).toHaveBeenCalledWith(101, mockQuestionPayloads[0]);
    expect(mockClient.updateMaterial).toHaveBeenCalledWith(1, 201, {
      ...mockMaterialPayload,
      questionIds: [101]
    });
  });

  it('returns dummy IDs in dry run', async () => {
    const mockClient = {} as unknown as TrackApiClient;

    const result = await publishToTrack(undefined, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: true,
      adoptExistingByTitle: false,
    });

    expect(result.trackQuestionIds).toEqual([0]);
    expect(result.trackMaterialId).toBe(0);
    expect(result.trackReleaseId).toBeUndefined();
  });

  it('skips material and release when requested', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([]),
      createQuestion: vi.fn().mockResolvedValue({ id: 101, title: 'Q1' }),
      createMaterial: vi.fn(),
      createRelease: vi.fn(),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: false,
      skipMaterial: true,
    });

    expect(result.trackQuestionIds).toEqual([101]);
    expect(result.trackMaterialId).toBeUndefined();
    expect(result.materialAction).toBe('skipped');
    expect(mockClient.createMaterial).not.toHaveBeenCalled();
    expect(mockClient.createRelease).not.toHaveBeenCalled();
  });

  it('converts draft material to API payload without any casts', () => {
    expect(toTrackMaterialPayload(mockMaterialDraft, [11, 12])).toEqual({
      ...mockMaterialPayload,
      questionIds: [11, 12],
    });
  });
});
