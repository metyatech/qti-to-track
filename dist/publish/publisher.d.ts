import { TrackApiClient, TrackQuestionPayload, TrackMaterialPayload } from '@metyatech/track-tcm-api-client';
export interface PublishResult {
    trackQuestionIds: number[];
    trackMaterialId: number;
    trackReleaseId?: string;
}
export declare function publishToTrack(client: TrackApiClient, materialPayload: TrackMaterialPayload, questionsPayloads: TrackQuestionPayload[], dryRun: boolean, adoptExistingByTitle: boolean): Promise<PublishResult>;
