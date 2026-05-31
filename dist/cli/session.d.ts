export interface TrackSession {
    baseUrl?: string;
    appspace?: string;
    cookie?: string;
    authorization?: string;
}
export declare function loadSession(filePath: string | undefined): Promise<TrackSession>;
