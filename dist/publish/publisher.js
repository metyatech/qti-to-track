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
async function findExactQuestionByTitle(client, title) {
    const existingQuestions = await client.findQuestionsByTitle(title);
    return existingQuestions.find((question) => question.title === title);
}
async function findExactMaterialByTitle(client, title) {
    const existingMaterials = await client.findMaterialsByTitle(title);
    return existingMaterials.find((material) => material.title === title);
}
export async function publishToTrack(client, materialDraft, questionsPayloads, options) {
    const { dryRun, adoptExistingByTitle, checkExisting = false, skipMaterial = false, recreateMissing = false, } = options;
    const mappedQuestionIds = options.mappedQuestionIds ?? [];
    const publishedQuestionIds = [];
    for (let index = 0; index < questionsPayloads.length; index += 1) {
        const questionPayload = questionsPayloads[index];
        const mappedId = mappedQuestionIds[index];
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
            const resolvedId = await updateOrRecreateQuestion(trackClient, mappedId, questionPayload, recreateMissing);
            publishedQuestionIds.push(resolvedId);
            continue;
        }
        // Unmapped path (first publish of this question): only look up by title when
        // explicitly requested. A plain publish creates a new question and never
        // overwrites an unrelated same-title question.
        let existingId = undefined;
        if (adoptExistingByTitle || checkExisting) {
            const lookupClient = requireClient(client, adoptExistingByTitle ? 'adopt existing Track content' : 'check existing Track content');
            const exactMatch = await findExactQuestionByTitle(lookupClient, questionPayload.title);
            if (exactMatch) {
                if (adoptExistingByTitle) {
                    console.log(`[PUBLISH] Adopting existing question by title: ${questionPayload.title} (ID: ${exactMatch.id})`);
                    existingId = exactMatch.id;
                }
                else {
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
    const mappedMaterialId = options.mappedMaterialId;
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
        return await updateOrRecreateMaterial(trackClient, mappedMaterialId, materialPayload, publishedQuestionIds, recreateMissing);
    }
    // Unmapped material path.
    let existingMaterialId = undefined;
    if (adoptExistingByTitle || checkExisting) {
        const lookupClient = requireClient(client, adoptExistingByTitle ? 'adopt existing Track content' : 'check existing Track content');
        const exactMatch = await findExactMaterialByTitle(lookupClient, materialPayload.title);
        if (exactMatch) {
            if (adoptExistingByTitle) {
                console.log(`[PUBLISH] Adopting existing material by title: ${materialPayload.title} (ID: ${exactMatch.id})`);
                existingMaterialId = exactMatch.id;
            }
            else {
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
}
/**
 * Detects a Track "not found" (HTTP 404) failure. The Track API client throws a
 * plain Error with the status embedded in the message (e.g.
 * `Track API PUT .../questions/123 failed: 404 ...`); it exposes no structured
 * status. This is the only available signal because the client has no
 * get-by-id / existence method. Tracked follow-up: add a typed status to
 * @metyatech/track-tcm-api-client and match on that instead of the message.
 */
function isTrackNotFoundError(error) {
    return error instanceof Error && /failed:\s*404\b/.test(error.message);
}
async function updateOrRecreateQuestion(client, mappedId, questionPayload, recreateMissing) {
    try {
        await client.updateQuestion(mappedId, questionPayload);
        return mappedId;
    }
    catch (error) {
        if (!isTrackNotFoundError(error)) {
            throw error;
        }
        if (!recreateMissing) {
            throw new Error(`Mapped Track question ID ${String(mappedId)} ("${questionPayload.title}") was not found on Track. It may have been deleted. Re-run with --recreate-missing to recreate it, or fix the track-map mapping.`);
        }
        console.log(`[PUBLISH] Mapped question ID ${String(mappedId)} not found on Track; recreating: ${questionPayload.title}`);
        const created = await client.createQuestion(questionPayload);
        return created.id;
    }
}
async function updateOrRecreateMaterial(client, mappedId, materialPayload, questionIds, recreateMissing) {
    try {
        await client.updateMaterial(1, mappedId, materialPayload);
        return {
            trackQuestionIds: questionIds,
            trackMaterialId: mappedId,
            materialAction: 'updated',
        };
    }
    catch (error) {
        if (!isTrackNotFoundError(error)) {
            throw error;
        }
        if (!recreateMissing) {
            throw new Error(`Mapped Track material ID ${String(mappedId)} ("${materialPayload.title}") was not found on Track. It may have been deleted. Re-run with --recreate-missing to recreate it, or fix the track-map mapping.`);
        }
        console.log(`[PUBLISH] Mapped material ID ${String(mappedId)} not found on Track; recreating: ${materialPayload.title}`);
        return await createMaterialAndRelease(client, materialPayload, questionIds);
    }
}
async function createMaterialAndRelease(client, materialPayload, questionIds) {
    console.log(`[PUBLISH] Creating new material: ${materialPayload.title}`);
    const created = await client.createMaterial(materialPayload);
    const publishedMaterialId = created.id;
    console.log(`[PUBLISH] Releasing material: ${materialPayload.title}`);
    const releasePayload = {
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
}
