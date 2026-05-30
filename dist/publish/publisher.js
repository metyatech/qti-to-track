export function toTrackMaterialPayload(materialDraft, questionIds) {
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
function requireClient(client, action) {
    if (!client) {
        throw new Error(`Track credentials are required to ${action}.`);
    }
    return client;
}
export async function publishToTrack(client, materialDraft, questionsPayloads, options) {
    const { dryRun, adoptExistingByTitle, skipMaterial = false } = options;
    const publishedQuestionIds = [];
    for (const questionPayload of questionsPayloads) {
        if (dryRun) {
            console.log(`[DRY-RUN] Would publish question: ${questionPayload.title}`);
            publishedQuestionIds.push(0); // Dummy ID
            continue;
        }
        const trackClient = requireClient(client, 'publish questions');
        let existingId = undefined;
        if (adoptExistingByTitle) {
            const existingQuestions = await trackClient.findQuestionsByTitle(questionPayload.title);
            const exactMatch = existingQuestions.find(q => q.title === questionPayload.title);
            if (exactMatch) {
                console.log(`[PUBLISH] Adopting existing question: ${questionPayload.title} (ID: ${exactMatch.id})`);
                existingId = exactMatch.id;
            }
        }
        else {
            const existingQuestions = await trackClient.findQuestionsByTitle(questionPayload.title);
            const exactMatch = existingQuestions.find(q => q.title === questionPayload.title);
            if (exactMatch) {
                throw new Error(`Duplicate question found: "${questionPayload.title}". Use --adopt-existing-by-title to update.`);
            }
        }
        if (existingId !== undefined) {
            await trackClient.updateQuestion(existingId, questionPayload);
            publishedQuestionIds.push(existingId);
        }
        else {
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
    if (dryRun) {
        console.log(`[DRY-RUN] Would publish material: ${materialPayload.title}`);
        return {
            trackQuestionIds: publishedQuestionIds,
            trackMaterialId: 0,
            materialAction: 'dry-run',
        };
    }
    const trackClient = requireClient(client, 'publish material');
    let existingMaterialId = undefined;
    if (adoptExistingByTitle) {
        const existingMaterials = await trackClient.findMaterialsByTitle(materialPayload.title);
        const exactMatch = existingMaterials.find(m => m.title === materialPayload.title);
        if (exactMatch) {
            console.log(`[PUBLISH] Adopting existing material: ${materialPayload.title} (ID: ${exactMatch.id})`);
            existingMaterialId = exactMatch.id;
        }
    }
    else {
        const existingMaterials = await trackClient.findMaterialsByTitle(materialPayload.title);
        const exactMatch = existingMaterials.find(m => m.title === materialPayload.title);
        if (exactMatch) {
            throw new Error(`Duplicate material found: "${materialPayload.title}". Use --adopt-existing-by-title to update.`);
        }
    }
    if (existingMaterialId !== undefined) {
        await trackClient.updateMaterial(1, existingMaterialId, materialPayload);
        return {
            trackQuestionIds: publishedQuestionIds,
            trackMaterialId: existingMaterialId,
            materialAction: 'updated',
        };
    }
    else {
        console.log(`[PUBLISH] Creating new material: ${materialPayload.title}`);
        const created = await trackClient.createMaterial(materialPayload);
        const publishedMaterialId = created.id;
        console.log(`[PUBLISH] Releasing material: ${materialPayload.title}`);
        const releasePayload = {
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
