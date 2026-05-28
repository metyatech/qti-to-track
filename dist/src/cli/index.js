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
    .action(async (options) => {
    const parsedQti = await loadQtiPackage(options.qtiDir);
    const payload = toTrackPayloads(parsedQti);
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
});
await program.parseAsync(process.argv);
