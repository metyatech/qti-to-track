import { TrackApiClient, TrackQuestionPayload, TrackMaterialPayload, TrackReleasePayload } from '@metyatech/track-tcm-api-client';
import type { TrackMaterialDraft } from '../types.js';

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
  const { dryRun, adoptExistingByTitle, checkExisting = false, skipMaterial = false } = options;
  const publishedQuestionIds: number[] = [];
  const shouldLookupExisting = adoptExistingByTitle || checkExisting || !dryRun;
  const lookupClient = shouldLookupExisting
    ? requireClient(client, adoptExistingByTitle ? 'adopt existing Track content' : 'check existing Track content')
    : undefined;

  for (const questionPayload of questionsPayloads) {
    let existingId: number | undefined = undefined;

    if (shouldLookupExisting) {
      const exactMatch = await findExactQuestionByTitle(lookupClient!, questionPayload.title);
      if (exactMatch) {
        if (adoptExistingByTitle) {
          console.log(`[PUBLISH] Adopting existing question: ${questionPayload.title} (ID: ${exactMatch.id})`);
          existingId = exactMatch.id;
        } else {
          throw new Error(`Duplicate question found: "${questionPayload.title}". Use --adopt-existing-by-title to update.`);
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
  }

  if (skipMaterial) {
    return {
      trackQuestionIds: publishedQuestionIds,
      materialAction: 'skipped',
    };
  }

  // Material
  const materialPayload = toTrackMaterialPayload(materialDraft, publishedQuestionIds);

  let existingMaterialId: number | undefined = undefined;
  if (shouldLookupExisting) {
    const exactMatch = await findExactMaterialByTitle(lookupClient!, materialPayload.title);
    if (exactMatch) {
      if (adoptExistingByTitle) {
        console.log(`[PUBLISH] Adopting existing material: ${materialPayload.title} (ID: ${exactMatch.id})`);
        existingMaterialId = exactMatch.id;
      } else {
        throw new Error(`Duplicate material found: "${materialPayload.title}". Use --adopt-existing-by-title to update.`);
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
  } else {
    console.log(`[PUBLISH] Creating new material: ${materialPayload.title}`);
    const created = await trackClient.createMaterial(materialPayload);
    const publishedMaterialId = created.id;

    console.log(`[PUBLISH] Releasing material: ${materialPayload.title}`);
    const releasePayload: TrackReleasePayload = {
      materialStyle: 1,
      materialId: publishedMaterialId,
      questionIds: publishedQuestionIds,
      releaseNote: 'Initial assessment release',
      skipReview: true
    };
    
    const release = await trackClient.createRelease(releasePayload);

    return {
      trackQuestionIds: publishedQuestionIds,
      trackMaterialId: publishedMaterialId,
      trackReleaseId: release.id,
      materialAction: 'created',
    };
  }
}
