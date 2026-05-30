export type TrackQuestionType = 'choice' | 'text-entry' | 'extended-text';

export interface TrackMaterialDraft {
  title: string;
  style: number;
  status: number;
  language: string;
  basicTimeMinutes: number;
  difficulty: number;
  questionKeys: string[];
  materialTypes: string[];
  availableApps: string[];
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

export interface ParsedBlank {
  responseIdentifier: string;
  answer: string;
  kind: 'exact' | 'regex';
}

export interface ParsedQtiItem {
  identifier: string;
  title: string;
  interactionType: TrackQuestionType;
  prompt: string;
  timeLimitSeconds?: number;
  choices: ParsedQtiChoice[];
  correctResponses: string[];
  blanks: ParsedBlank[];
  rubric: string[];
  feedback: string[];
}

export interface ParsedQtiPackage {
  assessment: ParsedAssessment;
  items: ParsedQtiItem[];
  itemsByIdentifier: Record<string, ParsedQtiItem>;
}
