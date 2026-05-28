export interface TrackMapTarget {
    base_url: string;
    appspace: string;
}
export interface TrackMapQuestionEntry {
    track_question_id: number;
    title: string;
    source_hash: string;
    updated_at: string;
}
export interface TrackMapMaterialEntry {
    track_material_id: number;
    title: string;
    question_keys: string[];
    updated_at: string;
    release_id?: string;
}
export interface TrackMap {
    version: 1;
    target?: TrackMapTarget;
    questions?: Record<string, TrackMapQuestionEntry>;
    materials?: Record<string, TrackMapMaterialEntry>;
}
export declare function loadTrackMap(filePath: string): Promise<TrackMap>;
export declare function saveTrackMap(filePath: string, trackMap: TrackMap): Promise<void>;
export declare function hashTrackSource(source: string): string;
