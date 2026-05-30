import type {
  ParsedChoice,
  ParsedQtiItem,
  ParsedQtiPackage,
  TrackBlankPayload,
  TrackChoicePayload,
  TrackMaterialPayload,
  TrackQuestionPayload,
} from '../types.js';

const DEFAULT_ITEM_TIME_LIMIT_SECONDS = 60;

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toQuestionKind(item: ParsedQtiItem): 1 | 2 | 3 | 4 {
  if (item.interactionType === 'choice') {
    return 1;
  }

  if (item.interactionType === 'text-entry') {
    return 2;
  }

  return 4;
}

function isRegexAnswer(value: string): boolean {
  return value.length >= 2 && value.startsWith('/') && value.endsWith('/');
}

function toTrackBlankPayload(answer: string): TrackBlankPayload {
  if (isRegexAnswer(answer)) {
    return {
      answer: answer.slice(1, -1),
      kind: 'regex',
      caseSensitive: false,
    };
  }

  return {
    answer,
    kind: 'exact',
    caseSensitive: false,
  };
}

function toTrackChoicePayload(choice: ParsedChoice, correctResponses: Set<string>): TrackChoicePayload {
  return {
    content: choice.text,
    correct: correctResponses.has(choice.identifier),
  };
}

function toPlaceholder(answer: string): string {
  return answer.length > 0 ? `\${${answer}}` : '${}';
}

function ensureClozePlaceholders(content: string, correctResponses: string[]): string {
  if (correctResponses.length === 0) {
    return content;
  }

  if (/\$\{[^}]*\}/.test(content)) {
    return content;
  }

  const placeholders = correctResponses.map(toPlaceholder).join(' ');
  return content.length > 0 ? `${content}\n${placeholders}` : placeholders;
}

function estimateItemTimeLimitSeconds(item: ParsedQtiItem): number {
  if (isPositiveFiniteNumber(item.timeLimitSeconds)) {
    return item.timeLimitSeconds;
  }

  return DEFAULT_ITEM_TIME_LIMIT_SECONDS;
}

function estimateMaterialTimeLimitSeconds(parsed: ParsedQtiPackage): number {
  if (isPositiveFiniteNumber(parsed.assessment.timeLimitSeconds)) {
    return parsed.assessment.timeLimitSeconds;
  }

  return parsed.items.reduce((sum, item) => sum + estimateItemTimeLimitSeconds(item), 0);
}

function toQuestionPayload(item: ParsedQtiItem): TrackQuestionPayload {
  const basePayload: TrackQuestionPayload = {
    title: item.title,
    questionKind: toQuestionKind(item),
    status: 2,
    content: item.prompt,
    howToSolve: item.feedback.join('\n').trim(),
    quizCategories: [99],
    availableApps: ['training'],
  };

  if (item.interactionType === 'choice') {
    const correctResponses = new Set(item.correctResponses);
    return {
      ...basePayload,
      choices: item.choices.map((choice) => toTrackChoicePayload(choice, correctResponses)),
    };
  }

  if (item.interactionType === 'text-entry') {
    return {
      ...basePayload,
      content: ensureClozePlaceholders(item.prompt, item.correctResponses),
      blanks: item.correctResponses.map(toTrackBlankPayload),
    };
  }

  return basePayload;
}

export function toTrackPayloads(parsed: ParsedQtiPackage): {
  material: TrackMaterialPayload;
  questions: TrackQuestionPayload[];
} {
  const questions = parsed.items.map(toQuestionPayload);
  const totalSeconds = estimateMaterialTimeLimitSeconds(parsed);

  const material: TrackMaterialPayload = {
    title: parsed.assessment.title ?? parsed.assessment.identifier,
    style: 1,
    status: 2,
    language: 'ja',
    basicTimeMinutes: Math.max(1, Math.ceil(totalSeconds / 60)),
    difficulty: 1,
    questionIds: parsed.items.map((item) => item.identifier),
    materialTypes: [1],
    availableApps: ['training'],
  };

  return {
    material,
    questions,
  };
}
