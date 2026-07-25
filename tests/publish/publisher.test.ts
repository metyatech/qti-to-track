import { describe, it, expect, vi } from 'vitest';
import { publishToTrack, toTrackMaterialPayload, PartialPublishError } from '../../src/publish/publisher.js';
import { TrackApiError, type TrackApiClient, type TrackMaterialPayload, type TrackQuestionPayload } from '@metyatech/track-tcm-api-client';
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

  function missingTrackApiError(url: string): TrackApiError {
    return new TrackApiError({
      method: 'PUT',
      url,
      status: 404,
      statusText: 'Not Found',
      responseBody: '<h1>Not Found</h1>',
      apiMessage: 'Not Found',
    });
  }

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
    expect(mockClient.createRelease).toHaveBeenCalledWith({
      materialStyle: 1,
      materialId: 201,
      questionIds: [101],
      releaseNote: 'Initial assessment release',
      skipReview: true,
    });
  });

  it('creates a new question on a plain real publish and never overwrites an unrelated same-title question', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([{ id: 999, title: 'Q1' }]),
      createQuestion: vi.fn().mockResolvedValue({ id: 102, title: 'Q1' }),
      updateQuestion: vi.fn(),
      findMaterialsByTitle: vi.fn().mockResolvedValue([{ id: 888, title: 'Test Material' }]),
      createMaterial: vi.fn().mockResolvedValue({ id: 202, title: 'Test Material' }),
      createRelease: vi.fn().mockResolvedValue({ id: 'rel-x' }),
      updateMaterial: vi.fn(),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: false,
    });

    expect(result.trackQuestionIds).toEqual([102]);
    expect(mockClient.createQuestion).toHaveBeenCalledWith(mockQuestionPayloads[0]);
    expect(mockClient.updateQuestion).not.toHaveBeenCalled();
    expect(mockClient.updateMaterial).not.toHaveBeenCalled();
    // A plain publish must not perform any title-based lookup.
    expect(mockClient.findQuestionsByTitle).not.toHaveBeenCalled();
    expect(mockClient.findMaterialsByTitle).not.toHaveBeenCalled();
  });

  it('updates a mapped question and material by ID without any title lookup', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn(),
      findMaterialsByTitle: vi.fn(),
      updateQuestion: vi.fn().mockResolvedValue({ id: 101, title: 'Q1' }),
      updateMaterial: vi.fn().mockResolvedValue({ id: 201, title: 'Test Material' }),
      createQuestion: vi.fn(),
      createMaterial: vi.fn(),
      createRelease: vi.fn().mockResolvedValue({ id: 'rel-updated' }),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: false,
      mappedQuestionIds: [101],
      mappedMaterialId: 201,
    });

    expect(result.trackQuestionIds).toEqual([101]);
    expect(result.trackMaterialId).toBe(201);
    expect(result.trackReleaseId).toBe('rel-updated');
    expect(result.materialAction).toBe('updated');
    expect(mockClient.updateQuestion).toHaveBeenCalledWith(101, mockQuestionPayloads[0]);
    expect(mockClient.updateMaterial).toHaveBeenCalledWith(1, 201, {
      ...mockMaterialPayload,
      questionIds: [101],
    });
    expect(mockClient.findQuestionsByTitle).not.toHaveBeenCalled();
    expect(mockClient.findMaterialsByTitle).not.toHaveBeenCalled();
    expect(mockClient.createQuestion).not.toHaveBeenCalled();
    expect(mockClient.createMaterial).not.toHaveBeenCalled();
    expect(mockClient.createRelease).toHaveBeenCalledWith({
      materialStyle: 1,
      materialId: 201,
      questionIds: [101],
      releaseNote: 'Updated assessment release',
      skipReview: true,
    });
  });

  it('reports mapped-ID updates during dry run without touching Track', async () => {
    const result = await publishToTrack(undefined, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: true,
      adoptExistingByTitle: false,
      mappedQuestionIds: [101],
      mappedMaterialId: 201,
    });

    expect(result.trackQuestionIds).toEqual([101]);
    expect(result.trackMaterialId).toBe(201);
    expect(result.materialAction).toBe('dry-run');
  });

  it('fails when a mapped question ID is missing and recreateMissing is false', async () => {
    const mockClient = {
      updateQuestion: vi.fn().mockRejectedValue(
        missingTrackApiError('https://tracks.dev/api/questions/101'),
      ),
      createQuestion: vi.fn(),
    } as unknown as TrackApiClient;

    await expect(publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: false,
      mappedQuestionIds: [101],
    }))
      .rejects.toThrow(/was not found on Track[\s\S]*--recreate-missing/);
    expect(mockClient.createQuestion).not.toHaveBeenCalled();
  });

  it('recreates a missing mapped question when recreateMissing is true', async () => {
    const mockClient = {
      updateQuestion: vi.fn().mockRejectedValue(
        missingTrackApiError('https://tracks.dev/api/questions/101'),
      ),
      createQuestion: vi.fn().mockResolvedValue({ id: 303, title: 'Q1' }),
      updateMaterial: vi.fn().mockResolvedValue({ id: 201, title: 'Test Material' }),
      createRelease: vi.fn().mockResolvedValue({ id: 'rel-recreated-question' }),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: false,
      recreateMissing: true,
      mappedQuestionIds: [101],
      mappedMaterialId: 201,
    });

    expect(result.trackQuestionIds).toEqual([303]);
    expect(mockClient.createQuestion).toHaveBeenCalledWith(mockQuestionPayloads[0]);
    expect(mockClient.updateMaterial).toHaveBeenCalledWith(1, 201, {
      ...mockMaterialPayload,
      questionIds: [303],
    });
    expect(mockClient.createRelease).toHaveBeenCalledWith({
      materialStyle: 1,
      materialId: 201,
      questionIds: [303],
      releaseNote: 'Updated assessment release',
      skipReview: true,
    });
  });

  it('rethrows non-404 errors when updating a mapped question', async () => {
    const mockClient = {
      updateQuestion: vi.fn().mockRejectedValue(
        new Error('Track API PUT https://tracks.dev/api/questions/101 failed: 500 Server Error'),
      ),
      createQuestion: vi.fn(),
    } as unknown as TrackApiClient;

    await expect(publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: false,
      recreateMissing: true,
      mappedQuestionIds: [101],
    }))
      .rejects.toThrow(/failed: 500/);
    expect(mockClient.createQuestion).not.toHaveBeenCalled();
  });

  it('adopts existing items when adopt-existing is true', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([{ id: 101, title: 'Q1' }]),
      updateQuestion: vi.fn().mockResolvedValue({ id: 101, title: 'Q1' }),
      findMaterialsByTitle: vi.fn().mockResolvedValue([{ id: 201, title: 'Test Material' }]),
      updateMaterial: vi.fn().mockResolvedValue({ id: 201, title: 'Test Material' }),
      createRelease: vi.fn().mockResolvedValue({ id: 'rel-adopted' }),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: false,
      adoptExistingByTitle: true,
    });

    expect(result.trackQuestionIds).toEqual([101]);
    expect(result.trackMaterialId).toBe(201);
    expect(result.trackReleaseId).toBe('rel-adopted');

    expect(mockClient.updateQuestion).toHaveBeenCalledWith(101, mockQuestionPayloads[0]);
    expect(mockClient.updateMaterial).toHaveBeenCalledWith(1, 201, {
      ...mockMaterialPayload,
      questionIds: [101]
    });
    expect(mockClient.createRelease).toHaveBeenCalledWith({
      materialStyle: 1,
      materialId: 201,
      questionIds: [101],
      releaseNote: 'Updated assessment release',
      skipReview: true,
    });
  });

  it('returns dummy IDs in dry run without touching Track when no lookup option is enabled', async () => {
    const result = await publishToTrack(undefined, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: true,
      adoptExistingByTitle: false,
    });

    expect(result.trackQuestionIds).toEqual([0]);
    expect(result.trackMaterialId).toBe(0);
    expect(result.trackReleaseId).toBeUndefined();
  });

  it('checks question and material duplicates during dry run when checkExisting is true', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([]),
      findMaterialsByTitle: vi.fn().mockResolvedValue([]),
      createQuestion: vi.fn(),
      createMaterial: vi.fn(),
      createRelease: vi.fn(),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: true,
      adoptExistingByTitle: false,
      checkExisting: true,
    });

    expect(result.trackQuestionIds).toEqual([0]);
    expect(result.trackMaterialId).toBe(0);
    expect(mockClient.findQuestionsByTitle).toHaveBeenCalledWith('Q1');
    expect(mockClient.findMaterialsByTitle).toHaveBeenCalledWith('Test Material');
    expect(mockClient.createQuestion).not.toHaveBeenCalled();
    expect(mockClient.createMaterial).not.toHaveBeenCalled();
    expect(mockClient.createRelease).not.toHaveBeenCalled();
  });

  it('fails closed when checkExisting finds a duplicate question during dry run', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([{ id: 101, title: 'Q1' }]),
    } as unknown as TrackApiClient;

    await expect(publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: true,
      adoptExistingByTitle: false,
      checkExisting: true,
    }))
      .rejects.toThrow(/Duplicate question found/);
  });

  it('fails closed when checkExisting finds a duplicate material during dry run', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([]),
      findMaterialsByTitle: vi.fn().mockResolvedValue([{ id: 201, title: 'Test Material' }]),
    } as unknown as TrackApiClient;

    await expect(publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: true,
      adoptExistingByTitle: false,
      checkExisting: true,
    }))
      .rejects.toThrow(/Duplicate material found/);
  });

  it('does not check material duplicates when --no-material skips material', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([]),
      findMaterialsByTitle: vi.fn(),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: true,
      adoptExistingByTitle: false,
      checkExisting: true,
      skipMaterial: true,
    });

    expect(result.materialAction).toBe('skipped');
    expect(mockClient.findQuestionsByTitle).toHaveBeenCalledWith('Q1');
    expect(mockClient.findMaterialsByTitle).not.toHaveBeenCalled();
  });

  it('keeps adopt-existing separate from dry-run duplicate checking', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([{ id: 101, title: 'Q1' }]),
      findMaterialsByTitle: vi.fn().mockResolvedValue([{ id: 201, title: 'Test Material' }]),
      updateQuestion: vi.fn(),
      updateMaterial: vi.fn(),
    } as unknown as TrackApiClient;

    const result = await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
      dryRun: true,
      adoptExistingByTitle: true,
      checkExisting: false,
    });

    expect(result.trackQuestionIds).toEqual([101]);
    expect(result.trackMaterialId).toBe(201);
    expect(result.materialAction).toBe('dry-run');
    expect(mockClient.updateQuestion).not.toHaveBeenCalled();
    expect(mockClient.updateMaterial).not.toHaveBeenCalled();
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

  it('throws PartialPublishError when a later question fails, returning earlier successes', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([]),
      createQuestion: vi.fn()
        .mockResolvedValueOnce({ id: 101, title: 'Q1' })
        .mockRejectedValueOnce(new Error('Network error on Q2')),
    } as unknown as TrackApiClient;

    const twoQuestions = [
      mockQuestionPayloads[0]!,
      { ...mockQuestionPayloads[0]!, title: 'Q2' }
    ];

    try {
      await publishToTrack(mockClient, mockMaterialDraft, twoQuestions, {
        dryRun: false,
        adoptExistingByTitle: false,
      });
      expect.fail('Should have thrown PartialPublishError');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PartialPublishError);
      expect(e.originalError.message).toBe('Network error on Q2');
      expect(e.partialResult.trackQuestionIds).toEqual([101]);
      expect(e.partialResult.materialAction).toBe('skipped');
    }
  });

  it('throws PartialPublishError when material creation fails after questions succeed', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([]),
      createQuestion: vi.fn().mockResolvedValue({ id: 101, title: 'Q1' }),
      createMaterial: vi.fn().mockRejectedValue(new Error('Material API error')),
    } as unknown as TrackApiClient;

    try {
      await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
        dryRun: false,
        adoptExistingByTitle: false,
      });
      expect.fail('Should have thrown PartialPublishError');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PartialPublishError);
      expect(e.originalError.message).toBe('Material API error');
      expect(e.partialResult.trackQuestionIds).toEqual([101]);
      expect(e.partialResult.materialAction).toBe('skipped');
      expect(e.partialResult.trackMaterialId).toBeUndefined();
    }
  });

  it('throws PartialPublishError when material release fails after material creation succeeds', async () => {
    const mockClient = {
      findQuestionsByTitle: vi.fn().mockResolvedValue([]),
      createQuestion: vi.fn().mockResolvedValue({ id: 101, title: 'Q1' }),
      createMaterial: vi.fn().mockResolvedValue({ id: 201, title: 'Test Material' }),
      createRelease: vi.fn().mockRejectedValue(new Error('Release API error')),
    } as unknown as TrackApiClient;

    try {
      await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
        dryRun: false,
        adoptExistingByTitle: false,
      });
      expect.fail('Should have thrown PartialPublishError');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PartialPublishError);
      expect(e.originalError.message).toBe('Release API error');
      expect(e.partialResult.trackQuestionIds).toEqual([101]);
      expect(e.partialResult.materialAction).toBe('created');
      expect(e.partialResult.trackMaterialId).toBe(201);
    }
  });

  it('preserves updated material IDs when release creation fails', async () => {
    const mockClient = {
      updateQuestion: vi.fn().mockResolvedValue({ id: 101, title: 'Q1' }),
      updateMaterial: vi.fn().mockResolvedValue({ id: 201, title: 'Test Material' }),
      createRelease: vi.fn().mockRejectedValue(new Error('Updated release API error')),
    } as unknown as TrackApiClient;

    try {
      await publishToTrack(mockClient, mockMaterialDraft, mockQuestionPayloads, {
        dryRun: false,
        adoptExistingByTitle: false,
        mappedQuestionIds: [101],
        mappedMaterialId: 201,
      });
      expect.fail('Should have thrown PartialPublishError');
    } catch (e: any) {
      expect(e).toBeInstanceOf(PartialPublishError);
      expect(e.originalError.message).toBe('Updated release API error');
      expect(e.partialResult).toEqual({
        trackQuestionIds: [101],
        trackMaterialId: 201,
        materialAction: 'updated',
      });
    }
  });
});
