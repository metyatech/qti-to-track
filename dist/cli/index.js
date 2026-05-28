#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { loadQtiPackage } from '../fs/qti-loader.js';
import { toTrackPayloads } from '../generator/track-generator.js';
import { loadTrackMap, saveTrackMap, hashTrackSource } from '../publish/track-map.js';
import { publishToTrack } from '../publish/publisher.js';
const program = new Command();
program
    .name('qti-to-track')
    .description('Convert QTI XML package to Track JSON payloads');
program
    .command('inspect')
    .description('Inspect parsed QTI package')
    .requiredOption('--qti-dir <dir>', 'directory path that contains QTI XML files')
    .option('--json', 'print JSON output', false)
    .action(async (options) => {
    const parsedQti = await loadQtiPackage(options.qtiDir);
    if (options.json) {
        console.log(JSON.stringify(parsedQti, null, 2));
        return;
    }
    console.dir(parsedQti, { depth: null });
});
program
    .command('payload')
    .description('Generate Track payload JSON file')
    .requiredOption('--qti-dir <dir>', 'directory path that contains QTI XML files')
    .requiredOption('--output <file>', 'output JSON file path')
    .option('--upload-images', 'upload local images to Track API and replace paths with remote URLs', false)
    .option('--appspace <appspace>', 'Track appspace ID (required for --upload-images)')
    .option('--authorization <token>', 'Track authorization header (optional)')
    .option('--cookie <cookie>', 'Track cookie header (optional)')
    .option('--base-url <url>', 'Track base URL', 'https://tracks.dev')
    .action(async (options) => {
    const parsedQti = await loadQtiPackage(options.qtiDir);
    let payload = toTrackPayloads(parsedQti);
    if (options.uploadImages) {
        if (!options.appspace || (!options.authorization && !options.cookie)) {
            console.error('Error: --appspace and either --authorization or --cookie are required when using --upload-images');
            process.exit(1);
        }
        const { createTrackApiClient } = await import('@metyatech/track-tcm-api-client');
        const { uploadImagesAndReplaceUrls } = await import('../generator/image-uploader.js');
        const apiClient = createTrackApiClient({
            appspace: options.appspace,
            authorization: options.authorization,
            cookie: options.cookie,
            baseUrl: options.baseUrl,
        });
        payload.questions = await uploadImagesAndReplaceUrls(payload.questions, options.qtiDir, apiClient);
    }
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
});
program
    .command('publish')
    .description('Publish QTI package directly to Track LMS')
    .requiredOption('--qti-dir <dir>', 'directory path that contains QTI XML files')
    .requiredOption('--appspace <id>', 'Track appspace ID')
    .option('--base-url <url>', 'Track base URL', 'https://tracks.dev')
    .option('--track-map <path>', 'path to track-map.yaml file')
    .option('--yes', 'actually execute the publish (otherwise performs a dry-run)', false)
    .option('--json', 'print JSON output of the result', false)
    .option('--adopt-existing-by-title', 'update existing questions/materials with matching titles', false)
    .option('--upload-images', 'upload local images to Track API and replace paths with remote URLs', false)
    .action(async (options) => {
    try {
        const isDryRun = !options.yes;
        if (isDryRun && !options.json) {
            console.log('[DRY-RUN] Executing publish in dry-run mode. No changes will be made.');
        }
        // 1. Resolve credentials
        const cookie = process.env.TRACK_TCM_COOKIE;
        const authorization = process.env.TRACK_TCM_AUTHORIZATION;
        if (!cookie && !authorization) {
            console.error('Error: TRACK_TCM_COOKIE or TRACK_TCM_AUTHORIZATION environment variable is required');
            process.exit(1);
        }
        const { createTrackApiClient } = await import('@metyatech/track-tcm-api-client');
        const apiClient = createTrackApiClient({
            appspace: options.appspace,
            authorization,
            cookie,
            baseUrl: options.baseUrl,
        });
        // 2. Parse QTI and generate payload
        const parsedQti = await loadQtiPackage(options.qtiDir);
        let payload = toTrackPayloads(parsedQti);
        // 3. Upload images if requested
        if (options.uploadImages) {
            if (!options.json)
                console.log(`Uploading images...`);
            const { uploadImagesAndReplaceUrls } = await import('../generator/image-uploader.js');
            payload.questions = await uploadImagesAndReplaceUrls(payload.questions, options.qtiDir, apiClient);
        }
        // 4. Load track-map
        let trackMap = { version: 1 };
        if (options.trackMap) {
            trackMap = await loadTrackMap(options.trackMap);
        }
        // 5. Publish
        const publishResult = await publishToTrack(apiClient, payload.material, // Cast because questionIds are string[] in toTrackPayloads but numbers are required for the client
        payload.questions, isDryRun, options.adoptExistingByTitle);
        // 6. Update track-map
        if (!isDryRun && options.trackMap) {
            if (!trackMap.target) {
                trackMap.target = { base_url: options.baseUrl, appspace: options.appspace };
            }
            if (!trackMap.questions)
                trackMap.questions = {};
            if (!trackMap.materials)
                trackMap.materials = {};
            const timestamp = new Date().toISOString();
            const baseKey = 'qti';
            // Update questions
            parsedQti.items.forEach((item, index) => {
                const qPayload = payload.questions[index];
                const hash = hashTrackSource(JSON.stringify(qPayload));
                const questionKey = `${baseKey}/${item.identifier}`;
                trackMap.questions[questionKey] = {
                    track_question_id: publishResult.trackQuestionIds[index],
                    title: qPayload.title,
                    source_hash: hash,
                    updated_at: timestamp
                };
            });
            // Update material
            const mPayload = payload.material;
            const hash = hashTrackSource(JSON.stringify(mPayload));
            const materialKey = `${baseKey}/${parsedQti.assessment.identifier}`;
            trackMap.materials[materialKey] = {
                track_material_id: publishResult.trackMaterialId,
                title: mPayload.title,
                question_keys: parsedQti.items.map((item) => `${baseKey}/${item.identifier}`),
                updated_at: timestamp,
                release_id: publishResult.trackReleaseId
            };
            await saveTrackMap(options.trackMap, trackMap);
            if (!options.json) {
                console.log(`Updated track-map at ${options.trackMap}`);
            }
        }
        if (options.json) {
            console.log(JSON.stringify({ dryRun: isDryRun, result: publishResult }, null, 2));
        }
        else {
            console.log(`\nPublish complete!`);
            console.log(`Material ID: ${publishResult.trackMaterialId}`);
            console.log(`Question IDs: ${publishResult.trackQuestionIds.join(', ')}`);
            if (publishResult.trackReleaseId) {
                console.log(`Release ID: ${publishResult.trackReleaseId}`);
            }
        }
    }
    catch (e) {
        console.error(`Error during publish: ${e.message}`);
        process.exit(1);
    }
});
await program.parseAsync(process.argv);
