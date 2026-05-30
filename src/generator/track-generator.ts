import type {
  ParsedChoice,
  ParsedQtiItem,
  ParsedQtiPackage,
  TrackMaterialDraft,
} from '../types.js';
import type {
  TrackBlankPayload,
  TrackChoicePayload,
  TrackQuestionPayload,
} from '@metyatech/track-tcm-api-client';

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

function toTrackBlankPayload(blank: ParsedQtiItem['blanks'][number]): TrackBlankPayload {
  return {
    answer: blank.answer,
    kind: blank.kind,
    caseSensitive: false,
  };
}

function toTrackChoicePayload(choice: ParsedChoice, correctResponses: Set<string>): TrackChoicePayload {
  return {
    content: choice.text,
    correct: correctResponses.has(choice.identifier),
  };
}

function toPlaceholder(blank: ParsedQtiItem['blanks'][number]): string {
  if (blank.answer.length === 0) {
    return '${}';
  }

  return blank.kind === 'regex' ? `\${/${blank.answer}/}` : `\${${blank.answer}}`;
}

function ensureClozePlaceholders(content: string, blanks: ParsedQtiItem['blanks']): string {
  if (blanks.length === 0) {
    return content;
  }

  if (/\$\{[^}]*\}/.test(content)) {
    return content;
  }

  const placeholders = blanks.map(toPlaceholder).join(' ');
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
      content: ensureClozePlaceholders(item.prompt, item.blanks),
      blanks: item.blanks.map(toTrackBlankPayload),
    };
  }

  return basePayload;
}

export function toTrackPayloads(parsed: ParsedQtiPackage, options: { materialType?: string; materialTitle?: string } = {}): {
  materialDraft: TrackMaterialDraft;
  questions: TrackQuestionPayload[];
} {
  const questions = parsed.items.map(toQuestionPayload);
  const totalSeconds = estimateMaterialTimeLimitSeconds(parsed);

  const materialDraft: TrackMaterialDraft = {
    title: options.materialTitle ?? parsed.assessment.title ?? parsed.assessment.identifier,
    style: 1,
    status: 2,
    language: 'ja',
    basicTimeMinutes: Math.max(1, Math.ceil(totalSeconds / 60)),
    difficulty: 1,
    questionKeys: parsed.items.map((item) => item.identifier),
    materialTypes: [options.materialType ?? 'others'],
    availableApps: ['training'],
  };

  return {
    materialDraft,
    questions,
  };
}
