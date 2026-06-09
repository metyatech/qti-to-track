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
    recreateMissing?: boolean;
    /**
     * Track question IDs resolved from the track-map, aligned positionally with
     * `questionsPayloads`. When an entry is a number, that question is updated by
     * ID (identity-based) and is never matched or overwritten by title.
     */
    mappedQuestionIds?: (number | undefined)[];
    /** Track material ID resolved from the track-map for identity-based update. */
    mappedMaterialId?: number;
}
export declare function toTrackMaterialPayload(materialDraft: TrackMaterialDraft, questionIds: number[]): TrackMaterialPayload;
export declare function publishToTrack(client: TrackApiClient | undefined, materialDraft: TrackMaterialDraft, questionsPayloads: TrackQuestionPayload[], options: PublishOptions): Promise<PublishResult>;
