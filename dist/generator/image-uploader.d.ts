import type { TrackQuestionPayload } from '@metyatech/track-tcm-api-client';
interface TrackApiClientUpload {
    uploadImage(file: Blob, filename: string): Promise<string>;
}
export declare function uploadImagesAndReplaceUrls(questions: TrackQuestionPayload[], qtiDir: string, apiClient: TrackApiClientUpload): Promise<TrackQuestionPayload[]>;
export {};
