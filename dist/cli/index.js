#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { loadQtiPackage } from '../fs/qti-loader.js';
import { toTrackPayloads } from '../generator/track-generator.js';
import { loadTrackMap, saveTrackMap, updateTrackMapForPublish } from '../publish/track-map.js';
import { publishToTrack, toTrackMaterialPayload } from '../publish/publisher.js';
import { loadSession } from './session.js';
const program = new Command();
const DEFAULT_BASE_URL = 'https://tracks.dev';
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
    .option('--material-type <type>', 'Track material type (default: others)', 'others')
    .option('--appspace <appspace>', 'Track appspace ID (required for --upload-images)')
    .option('--authorization <token>', 'Track authorization header (optional)')
    .option('--cookie <cookie>', 'Track cookie header (optional)')
    .option('--base-url <url>', 'Track base URL', 'https://tracks.dev')
    .action(async (options) => {
    const parsedQti = await loadQtiPackage(options.qtiDir);
    let payload = toTrackPayloads(parsedQti, { materialType: options.materialType });
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
    .option('--appspace <id>', 'Track appspace ID')
    .option('--base-url <url>', 'Track base URL')
    .option('--authorization <token>', 'Track authorization header')
    .option('--cookie <cookie>', 'Track cookie header')
    .option('--session <path>', 'weekly-quiz-workbench saved Track session file')
    .option('--track-map <path>', 'path to track-map.yaml file')
    .option('--no-track-map', 'disable all track-map read/write')
    .option('--material-title <title>', 'override QTI assessment title for Track material')
    .option('--material-type <type>', 'Track material type (default: others)', 'others')
    .option('--no-material', 'publish questions only; skip material and release creation')
    .option('--yes', 'actually execute the publish (otherwise performs a dry-run)', false)
    .option('--json', 'print JSON output of the result', false)
    .option('--adopt-existing-by-title', 'update existing questions/materials with matching titles', false)
    .option('--check-existing', 'perform duplicate checks during dry-run; requires Track credentials', false)
    .option('--upload-images', 'upload local images to Track API and replace paths with remote URLs', false)
    .action(async (options) => {
    try {
        const hasTrackMapArg = process.argv.some((arg) => arg === '--track-map' || arg.startsWith('--track-map='));
        if (hasTrackMapArg && process.argv.includes('--no-track-map')) {
            throw new Error('--track-map and --no-track-map cannot be used together');
        }
        const trackMapPath = typeof options.trackMap === 'string' ? options.trackMap : undefined;
        const trackMapDisabled = options.trackMap === false;
        const isDryRun = !options.yes;
        if (isDryRun && !options.json) {
            console.log('[DRY-RUN] Executing publish in dry-run mode. No changes will be made.');
        }
        // 1. Resolve credentials
        const session = await loadSession(options.session);
        const appspace = options.appspace ?? process.env.TRACK_TCM_APPSPACE ?? session.appspace;
        const baseUrl = options.baseUrl ?? process.env.TRACK_TCM_BASE_URL ?? session.baseUrl ?? DEFAULT_BASE_URL;
        const cookie = options.cookie ?? process.env.TRACK_TCM_COOKIE ?? session.cookie;
        const authorization = options.authorization ?? process.env.TRACK_TCM_AUTHORIZATION ?? session.authorization;
        const needsTrackClient = !isDryRun ||
            options.uploadImages ||
            options.adoptExistingByTitle ||
            options.checkExisting;
        if (needsTrackClient && !appspace) {
            throw new Error('Track appspace is required. Use --appspace, TRACK_TCM_APPSPACE, or --session.');
        }
        if (needsTrackClient && !cookie && !authorization) {
            throw new Error('Track credentials are required. Use --cookie/--authorization, TRACK_TCM_COOKIE/TRACK_TCM_AUTHORIZATION, or --session.');
        }
        const { createTrackApiClient } = await import('@metyatech/track-tcm-api-client');
        const apiClient = needsTrackClient
            ? createTrackApiClient({
                appspace: appspace,
                authorization,
                cookie,
                baseUrl,
            })
            : undefined;
        // 2. Parse QTI and generate payload
        const parsedQti = await loadQtiPackage(options.qtiDir);
        let payload = toTrackPayloads(parsedQti, {
            materialTitle: options.materialTitle,
            materialType: options.materialType,
        });
        // 3. Upload images if requested
        if (options.uploadImages) {
            if (!options.json)
                console.log(`Uploading images...`);
            const { uploadImagesAndReplaceUrls } = await import('../generator/image-uploader.js');
            payload.questions = await uploadImagesAndReplaceUrls(payload.questions, options.qtiDir, apiClient);
        }
        // 4. Load track-map
        let trackMap = { version: 1 };
        const useTrackMap = !trackMapDisabled && Boolean(trackMapPath);
        if (useTrackMap) {
            trackMap = await loadTrackMap(trackMapPath);
        }
        // 5. Publish
        const publishResult = await publishToTrack(apiClient, payload.materialDraft, payload.questions, {
            dryRun: isDryRun,
            adoptExistingByTitle: options.adoptExistingByTitle,
            checkExisting: options.checkExisting,
            skipMaterial: options.material === false,
        });
        // 6. Update track-map
        if (!isDryRun && useTrackMap) {
            const materialPayload = options.material === false || publishResult.trackMaterialId === undefined
                ? undefined
                : toTrackMaterialPayload(payload.materialDraft, publishResult.trackQuestionIds);
            const updatedTrackMap = updateTrackMapForPublish({
                trackMap,
                target: { base_url: baseUrl, appspace: appspace },
                baseKey: 'qti',
                questionKeys: parsedQti.items.map((item) => item.identifier),
                questionPayloads: payload.questions,
                materialDraft: payload.materialDraft,
                materialPayload,
                result: publishResult,
            });
            await saveTrackMap(trackMapPath, updatedTrackMap);
            if (!options.json) {
                console.log(`Updated track-map at ${trackMapPath}`);
            }
        }
        if (options.json) {
            console.log(JSON.stringify({ dryRun: isDryRun, result: publishResult }, null, 2));
        }
        else {
            console.log(`\nPublish complete!`);
            console.log(`Material: ${publishResult.materialAction}${publishResult.trackMaterialId !== undefined ? ` (${publishResult.trackMaterialId})` : ''}`);
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
