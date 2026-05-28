import { TrackApiClient, TrackQuestionPayload, TrackMaterialPayload, TrackReleasePayload } from '@metyatech/track-tcm-api-client';

export interface PublishResult {
  trackQuestionIds: number[];
  trackMaterialId: number;
  trackReleaseId?: string;
}

export async function publishToTrack(
  client: TrackApiClient,
  materialPayload: TrackMaterialPayload,
  questionsPayloads: TrackQuestionPayload[],
  dryRun: boolean,
  adoptExistingByTitle: boolean
): Promise<PublishResult> {
  const publishedQuestionIds: number[] = [];

  for (const questionPayload of questionsPayloads) {
    if (dryRun) {
      console.log(`[DRY-RUN] Would publish question: ${questionPayload.title}`);
      publishedQuestionIds.push(0); // Dummy ID
      continue;
    }

    let existingId: number | undefined = undefined;

    if (adoptExistingByTitle) {
      const existingQuestions = await client.findQuestionsByTitle(questionPayload.title);
      const exactMatch = existingQuestions.find(q => q.title === questionPayload.title);
      if (exactMatch) {
        console.log(`[PUBLISH] Adopting existing question: ${questionPayload.title} (ID: ${exactMatch.id})`);
        existingId = exactMatch.id;
      }
    } else {
      const existingQuestions = await client.findQuestionsByTitle(questionPayload.title);
      const exactMatch = existingQuestions.find(q => q.title === questionPayload.title);
      if (exactMatch) {
         throw new Error(`Duplicate question found: "${questionPayload.title}". Use --adopt-existing-by-title to update.`);
      }
    }

    if (existingId !== undefined) {
       await client.updateQuestion(existingId, questionPayload);
       publishedQuestionIds.push(existingId);
    } else {
       console.log(`[PUBLISH] Creating new question: ${questionPayload.title}`);
       const created = await client.createQuestion(questionPayload);
       publishedQuestionIds.push(created.id);
    }
  }

  // Material
  let publishedMaterialId = 0;
  // Replace string IDs in materialPayload with real track IDs
  const payloadWithRealQuestionIds = {
    ...materialPayload,
    questionIds: publishedQuestionIds
  };

  if (dryRun) {
    console.log(`[DRY-RUN] Would publish material: ${materialPayload.title}`);
    return {
      trackQuestionIds: publishedQuestionIds,
      trackMaterialId: 0
    };
  }

  let existingMaterialId: number | undefined = undefined;
  
  if (adoptExistingByTitle) {
    const existingMaterials = await client.findMaterialsByTitle(materialPayload.title);
    const exactMatch = existingMaterials.find(m => m.title === materialPayload.title);
    if (exactMatch) {
      console.log(`[PUBLISH] Adopting existing material: ${materialPayload.title} (ID: ${exactMatch.id})`);
      existingMaterialId = exactMatch.id;
    }
  } else {
    const existingMaterials = await client.findMaterialsByTitle(materialPayload.title);
    const exactMatch = existingMaterials.find(m => m.title === materialPayload.title);
    if (exactMatch) {
       throw new Error(`Duplicate material found: "${materialPayload.title}". Use --adopt-existing-by-title to update.`);
    }
  }

  if (existingMaterialId !== undefined) {
    await client.updateMaterial(1, existingMaterialId, payloadWithRealQuestionIds);
    publishedMaterialId = existingMaterialId;
    return {
       trackQuestionIds: publishedQuestionIds,
       trackMaterialId: publishedMaterialId
    };
  } else {
    console.log(`[PUBLISH] Creating new material: ${materialPayload.title}`);
    const created = await client.createMaterial(payloadWithRealQuestionIds);
    publishedMaterialId = created.id;

    console.log(`[PUBLISH] Releasing material: ${materialPayload.title}`);
    const releasePayload: TrackReleasePayload = {
      materialStyle: 1,
      materialId: publishedMaterialId,
      questionIds: publishedQuestionIds,
      releaseNote: 'Initial assessment release',
      skipReview: true
    };
    
    const release = await client.createRelease(releasePayload);

    return {
      trackQuestionIds: publishedQuestionIds,
      trackMaterialId: publishedMaterialId,
      trackReleaseId: release.id
    };
  }
}
