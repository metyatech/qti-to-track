import type { ParsedQtiPackage, TrackMaterialPayload, TrackQuestionPayload } from '../types.js';
export declare function toTrackPayloads(parsed: ParsedQtiPackage): {
    material: TrackMaterialPayload;
    questions: TrackQuestionPayload[];
};
