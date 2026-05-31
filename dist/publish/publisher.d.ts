import { TrackApiClient, TrackQuestionPayload, TrackMaterialPayload } from '@metyatech/track-tcm-api-client';
import type { TrackMaterialDraft } from '../types.js';
export interface PublishResult {
    trackQuestionIds: number[];
    trackMaterialId?: number;
    trackReleaseId?: string;
    materialAction: 'created' | 'updated' | 'skipped' | 'dry-run';
}
export interface PublishOptions {
    dryRun: boolean;
    adoptExistingByTitle: boolean;
    checkExisting?: boolean;
    skipMaterial?: boolean;
}
export declare function toTrackMaterialPayload(materialDraft: TrackMaterialDraft, questionIds: number[]): TrackMaterialPayload;
export declare function publishToTrack(client: TrackApiClient | undefined, materialDraft: TrackMaterialDraft, questionsPayloads: TrackQuestionPayload[], options: PublishOptions): Promise<PublishResult>;
