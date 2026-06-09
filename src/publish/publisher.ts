import {
  TrackApiError,
  type TrackApiClient,
  type TrackQuestionPayload,
  type TrackMaterialPayload,
  type TrackReleasePayload,
} from '@metyatech/track-tcm-api-client';
import type { TrackMaterialDraft } from '../types.js';

export class PartialPublishError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly partialResult: PublishResult,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = 'PartialPublishError';
  }
}

export interface PublishResult {
  trackQuestionIds: number[];
  trackMaterialId?: number;
  trackReleaseId?: string;
  materialAction: 'created' | 'updated' | 'skipped' | 'dry-run';
}

export interface PublishOptions {
  dryRun: boolean;
  adoptExistingByTitle: boolean;
  checkExisting?: boolean;
  skipMaterial?: boolean;
  recreateMissing?: boolean;
  /**
   * Track question IDs resolved from the track-map, aligned positionally with
   * `questionsPayloads`. When an entry is a number, that question is updated by
   * ID (identity-based) and is never matched or overwritten by title.
   */
  mappedQuestionIds?: (number | undefined)[];
  /** Track material ID resolved from the track-map for identity-based update. */
  mappedMaterialId?: number;
}

export function toTrackMaterialPayload(
  materialDraft: TrackMaterialDraft,
  questionIds: number[],
): TrackMaterialPayload {
  return {
    title: materialDraft.title,
    style: materialDraft.style,
    status: materialDraft.status,
    language: materialDraft.language,
    basicTimeMinutes: materialDraft.basicTimeMinutes,
    difficulty: materialDraft.difficulty,
    questionIds,
    materialTypes: materialDraft.materialTypes,
    availableApps: materialDraft.availableApps,
  };
}

function requireClient(client: TrackApiClient | undefined, action: string): TrackApiClient {
  if (!client) {
    throw new Error(`Track credentials are required to ${action}.`);
  }

  return client;
}

async function findExactQuestionByTitle(
  client: TrackApiClient,
  title: string,
): Promise<{ id: number; title: string } | undefined> {
  const existingQuestions = await client.findQuestionsByTitle(title);
  return existingQuestions.find((question) => question.title === title);
}

async function findExactMaterialByTitle(
  client: TrackApiClient,
  title: string,
): Promise<{ id: number; title: string } | undefined> {
  const existingMaterials = await client.findMaterialsByTitle(title);
  return existingMaterials.find((material) => material.title === title);
}

export async function publishToTrack(
  client: TrackApiClient | undefined,
  materialDraft: TrackMaterialDraft,
  questionsPayloads: TrackQuestionPayload[],
  options: PublishOptions,
): Promise<PublishResult> {
  const {
    dryRun,
    adoptExistingByTitle,
    checkExisting = false,
    skipMaterial = false,
    recreateMissing = false,
  } = options;
  const mappedQuestionIds = options.mappedQuestionIds ?? [];
  const publishedQuestionIds: number[] = [];

  for (let index = 0; index < questionsPayloads.length; index += 1) {
    const questionPayload = questionsPayloads[index]!;
    const mappedId = mappedQuestionIds[index];

    try {
      // Identity-based path: the track-map already maps this question to a Track
    // question ID. Update by ID and never match or overwrite by title. This is
    // what prevents a same-title question from a different exam being clobbered.
    if (mappedId !== undefined) {
      if (dryRun) {
        console.log(`[DRY-RUN] Would update question by mapped ID: ${questionPayload.title} (ID: ${mappedId})`);
        publishedQuestionIds.push(mappedId);
        continue;
      }
      const trackClient = requireClient(client, 'publish questions');
      const resolvedId = await updateOrRecreateQuestion(
        trackClient,
        mappedId,
        questionPayload,
        recreateMissing,
      );
      publishedQuestionIds.push(resolvedId);
      continue;
    }

    // Unmapped path (first publish of this question): only look up by title when
    // explicitly requested. A plain publish creates a new question and never
    // overwrites an unrelated same-title question.
    let existingId: number | undefined = undefined;
    if (adoptExistingByTitle || checkExisting) {
      const lookupClient = requireClient(
        client,
        adoptExistingByTitle ? 'adopt existing Track content' : 'check existing Track content',
      );
      const exactMatch = await findExactQuestionByTitle(lookupClient, questionPayload.title);
      if (exactMatch) {
        if (adoptExistingByTitle) {
          console.log(`[PUBLISH] Adopting existing question by title: ${questionPayload.title} (ID: ${exactMatch.id})`);
          existingId = exactMatch.id;
        } else {
          throw new Error(`Duplicate question found: "${questionPayload.title}". Use --adopt-existing-by-title to update it, or rename the question.`);
        }
      }
    }

    if (dryRun) {
      console.log(`[DRY-RUN] Would publish question: ${questionPayload.title}`);
      publishedQuestionIds.push(existingId ?? 0);
      continue;
    }

    const trackClient = requireClient(client, 'publish questions');
    if (existingId !== undefined) {
      await trackClient.updateQuestion(existingId, questionPayload);
      publishedQuestionIds.push(existingId);
    } else {
      console.log(`[PUBLISH] Creating new question: ${questionPayload.title}`);
      const created = await trackClient.createQuestion(questionPayload);
      publishedQuestionIds.push(created.id);
    }
    } catch (error) {
      if (error instanceof PartialPublishError) throw error;
      throw new PartialPublishError(error, {
        trackQuestionIds: publishedQuestionIds,
        materialAction: 'skipped',
      });
    }
  }

  if (skipMaterial) {
    return {
      trackQuestionIds: publishedQuestionIds,
      materialAction: 'skipped',
    };
  }

  // Material
  const materialPayload = toTrackMaterialPayload(materialDraft, publishedQuestionIds);
  const mappedMaterialId = options.mappedMaterialId;

  try {
  // Identity-based material path.
  if (mappedMaterialId !== undefined) {
    if (dryRun) {
      console.log(`[DRY-RUN] Would update material by mapped ID: ${materialPayload.title} (ID: ${mappedMaterialId})`);
      return {
        trackQuestionIds: publishedQuestionIds,
        trackMaterialId: mappedMaterialId,
        materialAction: 'dry-run',
      };
    }
    const trackClient = requireClient(client, 'publish material');
    return await updateOrRecreateMaterial(
      trackClient,
      mappedMaterialId,
      materialPayload,
      publishedQuestionIds,
      recreateMissing,
    );
  }

  // Unmapped material path.
  let existingMaterialId: number | undefined = undefined;
  if (adoptExistingByTitle || checkExisting) {
    const lookupClient = requireClient(
      client,
      adoptExistingByTitle ? 'adopt existing Track content' : 'check existing Track content',
    );
    const exactMatch = await findExactMaterialByTitle(lookupClient, materialPayload.title);
    if (exactMatch) {
      if (adoptExistingByTitle) {
        console.log(`[PUBLISH] Adopting existing material by title: ${materialPayload.title} (ID: ${exactMatch.id})`);
        existingMaterialId = exactMatch.id;
      } else {
        throw new Error(`Duplicate material found: "${materialPayload.title}". Use --adopt-existing-by-title to update it, or rename the material.`);
      }
    }
  }

  if (dryRun) {
    console.log(`[DRY-RUN] Would publish material: ${materialPayload.title}`);
    return {
      trackQuestionIds: publishedQuestionIds,
      trackMaterialId: existingMaterialId ?? 0,
      materialAction: 'dry-run',
    };
  }

  const trackClient = requireClient(client, 'publish material');
  if (existingMaterialId !== undefined) {
    await trackClient.updateMaterial(1, existingMaterialId, materialPayload);
    return {
      trackQuestionIds: publishedQuestionIds,
      trackMaterialId: existingMaterialId,
      materialAction: 'updated',
    };
  }
  return await createMaterialAndRelease(trackClient, materialPayload, publishedQuestionIds);
  } catch (error) {
    if (error instanceof PartialPublishError) throw error;
    throw new PartialPublishError(error, {
      trackQuestionIds: publishedQuestionIds,
      materialAction: 'skipped',
    });
  }
}

function isTrackNotFoundError(error: unknown): boolean {
  return error instanceof TrackApiError && error.status === 404;
}

async function updateOrRecreateQuestion(
  client: TrackApiClient,
  mappedId: number,
  questionPayload: TrackQuestionPayload,
  recreateMissing: boolean,
): Promise<number> {
  try {
    await client.updateQuestion(mappedId, questionPayload);
    return mappedId;
  } catch (error) {
    if (!isTrackNotFoundError(error)) {
      throw error;
    }
    if (!recreateMissing) {
      throw new Error(
        `Mapped Track question ID ${String(mappedId)} ("${questionPayload.title}") was not found on Track. It may have been deleted. Re-run with --recreate-missing to recreate it, or fix the track-map mapping.`,
      );
    }
    console.log(`[PUBLISH] Mapped question ID ${String(mappedId)} not found on Track; recreating: ${questionPayload.title}`);
    const created = await client.createQuestion(questionPayload);
    return created.id;
  }
}

async function updateOrRecreateMaterial(
  client: TrackApiClient,
  mappedId: number,
  materialPayload: TrackMaterialPayload,
  questionIds: number[],
  recreateMissing: boolean,
): Promise<PublishResult> {
  try {
    await client.updateMaterial(1, mappedId, materialPayload);
    return {
      trackQuestionIds: questionIds,
      trackMaterialId: mappedId,
      materialAction: 'updated',
    };
  } catch (error) {
    if (!isTrackNotFoundError(error)) {
      throw error;
    }
    if (!recreateMissing) {
      throw new Error(
        `Mapped Track material ID ${String(mappedId)} ("${materialPayload.title}") was not found on Track. It may have been deleted. Re-run with --recreate-missing to recreate it, or fix the track-map mapping.`,
      );
    }
    console.log(`[PUBLISH] Mapped material ID ${String(mappedId)} not found on Track; recreating: ${materialPayload.title}`);
    return await createMaterialAndRelease(client, materialPayload, questionIds);
  }
}

async function createMaterialAndRelease(
  client: TrackApiClient,
  materialPayload: TrackMaterialPayload,
  questionIds: number[],
): Promise<PublishResult> {
  console.log(`[PUBLISH] Creating new material: ${materialPayload.title}`);
  const created = await client.createMaterial(materialPayload);
  const publishedMaterialId = created.id;

  console.log(`[PUBLISH] Releasing material: ${materialPayload.title}`);
  try {
    const releasePayload: TrackReleasePayload = {
      materialStyle: 1,
      materialId: publishedMaterialId,
      questionIds,
      releaseNote: 'Initial assessment release',
      skipReview: true,
    };

    const release = await client.createRelease(releasePayload);

    return {
      trackQuestionIds: questionIds,
      trackMaterialId: publishedMaterialId,
      trackReleaseId: release.id,
      materialAction: 'created',
    };
  } catch (error) {
    throw new PartialPublishError(error, {
      trackQuestionIds: questionIds,
      trackMaterialId: publishedMaterialId,
      materialAction: 'created',
    });
  }
}
