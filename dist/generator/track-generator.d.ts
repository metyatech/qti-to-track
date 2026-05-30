import type { ParsedQtiPackage, TrackMaterialDraft } from '../types.js';
import type { TrackQuestionPayload } from '@metyatech/track-tcm-api-client';
export declare function toTrackPayloads(parsed: ParsedQtiPackage, options?: {
    materialType?: string;
    materialTitle?: string;
}): {
    materialDraft: TrackMaterialDraft;
    questions: TrackQuestionPayload[];
};
