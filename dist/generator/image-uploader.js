import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;
async function replaceImagesInText(text, qtiDir, apiClient, uploadCache) {
    if (!text) {
        return '';
    }
    let result = text;
    const matches = [...text.matchAll(MARKDOWN_IMAGE_REGEX)];
    for (const match of matches) {
        const fullMatch = match[0];
        const alt = match[1];
        const src = match[2];
        if (!src || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
            continue;
        }
        const localPath = resolve(qtiDir, src);
        let remoteUrl = uploadCache.get(localPath);
        if (!remoteUrl) {
            try {
                const buffer = await readFile(localPath);
                const blob = new Blob([buffer]);
                const filename = src.split(/[/\\]/).pop() || 'image.png';
                remoteUrl = await apiClient.uploadImage(blob, filename);
                uploadCache.set(localPath, remoteUrl);
            }
            catch (error) {
                console.error(`Failed to upload image ${localPath}:`, error instanceof Error ? error.message : String(error));
                continue;
            }
        }
        if (remoteUrl) {
            result = result.replace(fullMatch, `![${alt}](${remoteUrl})`);
        }
    }
    return result;
}
export async function uploadImagesAndReplaceUrls(questions, qtiDir, apiClient) {
    const uploadCache = new Map();
    const newQuestions = [];
    for (const q of questions) {
        const newQ = { ...q };
        newQ.content = await replaceImagesInText(q.content, qtiDir, apiClient, uploadCache);
        newQ.howToSolve = await replaceImagesInText(q.howToSolve, qtiDir, apiClient, uploadCache);
        if (q.choices) {
            newQ.choices = await Promise.all(q.choices.map(async (choice) => {
                const newChoice = { ...choice };
                newChoice.content = await replaceImagesInText(choice.content, qtiDir, apiClient, uploadCache);
                return newChoice;
            }));
        }
        newQuestions.push(newQ);
    }
    return newQuestions;
}
