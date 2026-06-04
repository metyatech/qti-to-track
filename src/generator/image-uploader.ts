import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TrackChoicePayload, TrackQuestionPayload } from '@metyatech/track-tcm-api-client';

interface TrackApiClientUpload {
  uploadImage(file: Blob, filename: string): Promise<string>;
}

const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;

async function replaceImagesInText(
  text: string | undefined,
  qtiDir: string,
  apiClient: TrackApiClientUpload,
  uploadCache: Map<string, string>
): Promise<string> {
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
      const buffer = await readFile(localPath);
      const blob = new Blob([buffer]);
      const filename = src.split(/[/\\]/).pop() || 'image.png';
      try {
        remoteUrl = await apiClient.uploadImage(blob, filename);
      } catch (error) {
        throw new Error(
          `Failed to upload image ${localPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      uploadCache.set(localPath, remoteUrl);
    }

    if (remoteUrl) {
      result = result.replace(fullMatch, `![${alt}](${remoteUrl})`);
    }
  }

  return result;
}

export async function uploadImagesAndReplaceUrls(
  questions: TrackQuestionPayload[],
  qtiDir: string,
  apiClient: TrackApiClientUpload
): Promise<TrackQuestionPayload[]> {
  const uploadCache = new Map<string, string>();
  const newQuestions: TrackQuestionPayload[] = [];

  for (const q of questions) {
    const newQ: TrackQuestionPayload = { ...q };
    
    newQ.content = await replaceImagesInText(q.content, qtiDir, apiClient, uploadCache);
    newQ.howToSolve = await replaceImagesInText(q.howToSolve, qtiDir, apiClient, uploadCache);
    
    if (q.choices) {
      newQ.choices = await Promise.all(
        q.choices.map(async (choice) => {
          const newChoice: TrackChoicePayload = { ...choice };
          newChoice.content = await replaceImagesInText(choice.content, qtiDir, apiClient, uploadCache);
          return newChoice;
        })
      );
    }
    
    newQuestions.push(newQ);
  }

  return newQuestions;
}
