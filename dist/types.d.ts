export type TrackQuestionType = 'choice' | 'text-entry' | 'extended-text';
export interface TrackMaterialPayload {
    title: string;
    style: number;
    status: number;
    language: string;
    basicTimeMinutes: number;
    difficulty: number;
    questionIds: string[];
    materialTypes: number[];
    availableApps: string[];
}
export interface TrackChoicePayload {
    content: string;
    correct: boolean;
}
export interface TrackBlankPayload {
    answer: string;
    kind: 'exact' | 'regex';
    caseSensitive: boolean;
}
export interface TrackQuestionPayload {
    title: string;
    questionKind: 1 | 2 | 3 | 4;
    status: number;
    content: string;
    howToSolve: string;
    quizCategories: number[];
    availableApps: string[];
    choices?: TrackChoicePayload[];
    blanks?: TrackBlankPayload[];
}
export interface ParsedAssessmentItemRef {
    identifier: string;
    href?: string;
}
export interface ParsedAssessment {
    identifier: string;
    title?: string;
    timeLimitSeconds?: number;
    itemRefs: ParsedAssessmentItemRef[];
}
export interface ParsedQtiChoice {
    identifier: string;
    text: string;
}
export type ParsedChoice = ParsedQtiChoice;
export interface ParsedQtiItem {
    identifier: string;
    title: string;
    interactionType: TrackQuestionType;
    prompt: string;
    timeLimitSeconds?: number;
    choices: ParsedQtiChoice[];
    correctResponses: string[];
    rubric: string[];
    feedback: string[];
}
export interface ParsedQtiPackage {
    assessment: ParsedAssessment;
    items: ParsedQtiItem[];
    itemsByIdentifier: Record<string, ParsedQtiItem>;
}
