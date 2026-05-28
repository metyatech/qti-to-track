#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { loadQtiPackage } from '../fs/qti-loader.js';
import { toTrackPayloads } from '../generator/track-generator.js';

const program = new Command();

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

await program.parseAsync(process.argv);
