import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import yaml from 'yaml';
export async function loadTrackMap(filePath) {
    try {
        const content = await readFile(filePath, 'utf8');
        const parsed = yaml.parse(content);
        if (parsed && parsed.version === 1) {
            return parsed;
        }
    }
    catch (e) {
        if (e.code !== 'ENOENT') {
            throw e;
        }
    }
    return { version: 1 };
}
export async function saveTrackMap(filePath, trackMap) {
    const content = yaml.stringify(trackMap, {
        sortMapEntries: (a, b) => {
            // Keep target at top, then materials, then questions
            const order = ['version', 'target', 'materials', 'questions'];
            const indexA = order.indexOf(a.key?.value ?? a.key);
            const indexB = order.indexOf(b.key?.value ?? b.key);
            if (indexA !== -1 && indexB !== -1)
                return indexA - indexB;
            if (indexA !== -1)
                return -1;
            if (indexB !== -1)
                return 1;
            return String(a.key?.value ?? a.key).localeCompare(String(b.key?.value ?? b.key));
        }
    });
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, filePath);
}
export function hashTrackSource(source) {
    return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}
