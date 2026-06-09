#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { loadQtiPackage } from '../fs/qti-loader.js';
import { toTrackPayloads } from '../generator/track-generator.js';
import {
  loadTrackMap,
  saveTrackMap,
  type TrackMap,
  type TrackMapTarget,
  updateTrackMapForPublish,
} from '../publish/track-map.js';
import { publishToTrack, toTrackMaterialPayload, PartialPublishError, type PublishResult } from '../publish/publisher.js';
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
  .action(async (options: { qtiDir: string; json: boolean }) => {
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
  .option('--recreate-missing', 'recreate Track questions/materials whose mapped track-map ID no longer exists on Track', false)
  .option('--upload-images', 'upload local images to Track API and replace paths with remote URLs', false)
  .action(async (options) => {
    let persistTrackMap: ((result: PublishResult) => Promise<void>) | undefined;
    try {
      const hasTrackMapArg = process.argv.some((arg) => arg === '--track-map' || arg.startsWith('--track-map='));
      if (hasTrackMapArg && process.argv.includes('--no-track-map')) {
        throw new Error('--track-map and --no-track-map cannot be used together');
      }
      const trackMapPath = typeof options.trackMap === 'string' ? options.trackMap : undefined;
      const trackMapDisabled = options.trackMap === false;
      let trackMap: TrackMap = { version: 1 };
      const useTrackMap = !trackMapDisabled && Boolean(trackMapPath);
      if (useTrackMap) {
        trackMap = await loadTrackMap(trackMapPath!);
      }
      validateTrackMapTargetConflicts(options, trackMap.target);

      const isDryRun = !options.yes;
      if (isDryRun && !options.json) {
        console.log('[DRY-RUN] Executing publish in dry-run mode. No changes will be made.');
      }

      // 1. Resolve credentials
      const session = await loadSession(options.session);
      validateTrackMapSessionConflicts(session, trackMap.target);
      const appspace =
        options.appspace ??
        process.env.TRACK_TCM_APPSPACE ??
        session.appspace ??
        trackMap.target?.appspace;
      const baseUrl =
        options.baseUrl ??
        process.env.TRACK_TCM_BASE_URL ??
        session.baseUrl ??
        trackMap.target?.base_url ??
        DEFAULT_BASE_URL;
      const cookie = options.cookie ?? process.env.TRACK_TCM_COOKIE ?? session.cookie;
      const authorization = options.authorization ?? process.env.TRACK_TCM_AUTHORIZATION ?? session.authorization;
      const needsTrackClient =
        !isDryRun ||
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
            appspace: appspace!,
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
        if (!options.json) console.log(`Uploading images...`);
        const { uploadImagesAndReplaceUrls } = await import('../generator/image-uploader.js');
        payload.questions = await uploadImagesAndReplaceUrls(payload.questions, options.qtiDir, apiClient!);
      }

      // Resolve identity-based update targets from the track-map. Questions are
      // keyed by their stable QTI identifier (qti/<identifier>), so re-publishing
      // updates the same Track record by ID regardless of its title.
      const mappedQuestionIds = useTrackMap
        ? parsedQti.items.map((item) => trackMap.questions?.[`qti/${item.identifier}`]?.track_question_id)
        : undefined;
      const materialKey = parsedQti.assessment.identifier;
      const legacyMaterialKey = payload.materialDraft.title;
      const mappedMaterialId = useTrackMap
        ? trackMap.materials?.[`qti/${materialKey}`]?.track_material_id ??
          trackMap.materials?.[`qti/${legacyMaterialKey}`]?.track_material_id
        : undefined;

      // 5. Publish
      const publishResult = await publishToTrack(
        apiClient,
        payload.materialDraft,
        payload.questions,
        {
          dryRun: isDryRun,
          adoptExistingByTitle: options.adoptExistingByTitle,
          checkExisting: options.checkExisting,
          skipMaterial: options.material === false,
          recreateMissing: options.recreateMissing,
          mappedQuestionIds,
          mappedMaterialId,
        },
      );

      persistTrackMap = async (publishResult: PublishResult) => {
        if (!isDryRun && useTrackMap) {
          const materialPayload =
            options.material === false || publishResult.trackMaterialId === undefined
              ? undefined
              : toTrackMaterialPayload(payload.materialDraft, publishResult.trackQuestionIds);
          const updatedTrackMap = updateTrackMapForPublish({
            trackMap,
            target: { base_url: baseUrl, appspace: appspace! },
            baseKey: 'qti',
            questionKeys: parsedQti.items.map((item) => item.identifier),
            materialKey,
            legacyMaterialKey,
            questionPayloads: payload.questions,
            materialDraft: payload.materialDraft,
            materialPayload,
            result: publishResult,
          });

          await saveTrackMap(trackMapPath!, updatedTrackMap);
          if (!options.json) {
            console.log(`Updated track-map at ${trackMapPath}`);
          }
        }
      };

      // 6. Update track-map
      await persistTrackMap(publishResult);

      if (options.json) {
        console.log(JSON.stringify({ dryRun: isDryRun, result: publishResult }, null, 2));
      } else {
        console.log(`\nPublish complete!`);
        console.log(`Material: ${publishResult.materialAction}${publishResult.trackMaterialId !== undefined ? ` (${publishResult.trackMaterialId})` : ''}`);
        console.log(`Question IDs: ${publishResult.trackQuestionIds.join(', ')}`);
        if (publishResult.trackReleaseId) {
          console.log(`Release ID: ${publishResult.trackReleaseId}`);
        }
      }
    } catch (e: any) {
      if (e instanceof PartialPublishError) {
        console.error(`\nError during publish: ${e.originalError instanceof Error ? e.originalError.message : String(e.originalError)}`);
        console.error(`Attempting to save partial publish progress to track-map...`);
        try {
          // This ensures whatever was successfully published isn't orphaned
          if (persistTrackMap) {
            await persistTrackMap(e.partialResult);
          }
        } catch (saveError: any) {
          console.error(`Failed to save partial track-map: ${saveError.message}`);
        }
        process.exit(1);
      }
      console.error(`Error during publish: ${e.message}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);

function validateTrackMapTargetConflicts(
  options: {
    appspace?: string;
    baseUrl?: string;
  },
  target: TrackMapTarget | undefined,
): void {
  if (target === undefined) return;
  assertTargetMatch(
    options.baseUrl,
    '--base-url',
    target.base_url,
    'Track map target base_url',
    normalizeBaseUrl,
  );
  assertTargetMatch(
    options.appspace,
    '--appspace',
    target.appspace,
    'Track map target appspace',
  );
  assertTargetMatch(
    process.env.TRACK_TCM_BASE_URL,
    'TRACK_TCM_BASE_URL',
    target.base_url,
    'Track map target base_url',
    normalizeBaseUrl,
  );
  assertTargetMatch(
    process.env.TRACK_TCM_APPSPACE,
    'TRACK_TCM_APPSPACE',
    target.appspace,
    'Track map target appspace',
  );
}

function validateTrackMapSessionConflicts(
  session: { baseUrl?: string; appspace?: string },
  target: TrackMapTarget | undefined,
): void {
  if (target === undefined) return;
  assertTargetMatch(
    session.baseUrl,
    'Track session baseUrl',
    target.base_url,
    'Track map target base_url',
    normalizeBaseUrl,
  );
  assertTargetMatch(
    session.appspace,
    'Track session appspace',
    target.appspace,
    'Track map target appspace',
  );
}

function assertTargetMatch(
  value: string | undefined,
  valueLabel: string,
  targetValue: string,
  targetLabel: string,
  normalize: (candidate: string) => string = identity,
): void {
  if (value === undefined) return;
  if (normalize(value) !== normalize(targetValue)) {
    throw new Error(
      `${valueLabel} ${value} conflicts with ${targetLabel} ${targetValue}`,
    );
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, '');
}

function identity(value: string): string {
  return value;
}
