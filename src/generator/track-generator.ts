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

interface MarkdownFence {
  character: '`' | '~';
  length: number;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toQuestionKind(item: ParsedQtiItem): 1 | 2 | 3 {
  if (item.interactionType === 'choice') {
    return 1;
  }

  if (item.interactionType === 'text-entry') {
    return 2;
  }

  return 3;
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

function toTrackSafeRichText(markdown: string): string {
  let fence: MarkdownFence | undefined;

  return markdown
    .split('\n')
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1] as string;
        const character = marker[0] as MarkdownFence['character'];
        if (fence === undefined) {
          fence = { character, length: marker.length };
        } else if (
          character === fence.character
          && marker.length >= fence.length
          && (fenceMatch[2] as string).trim().length === 0
        ) {
          fence = undefined;
        }
        return line;
      }

      if (fence !== undefined) {
        return line;
      }

      const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line);
      if (headingMatch === null) {
        return line;
      }

      const level = (headingMatch[1] as string).length;
      const content = (headingMatch[2] as string).replace(/[ \t]+#+[ \t]*$/u, '').trimEnd();
      return `<h${String(level)}>${content}</h${String(level)}>`;
    })
    .join('\n');
}

function formatMaxScore(maxScore: number): string {
  return Number.isInteger(maxScore) ? String(maxScore) : String(maxScore);
}

function buildScoringFooter(item: ParsedQtiItem): string | undefined {
  const rubric = item.scorerRubric
    .map((line) => line.replace(/\[(\d+)\]/g, '[$1点]'))
    .join('\n\n')
    .trim();
  const maxScore = item.maxScore === undefined ? undefined : formatMaxScore(item.maxScore);
  if (rubric.length === 0 && maxScore === undefined) {
    return undefined;
  }

  const summary = maxScore === undefined
    ? '採点基準'
    : `採点基準（最大点: ${maxScore}点）`;
  const body = rubric.length > 0 ? rubric : `最大点: ${maxScore}点`;

  return [
    '<details>',
    `<summary><strong>${summary}</strong></summary>`,
    '',
    body,
    '',
    '</details>',
  ].join('\n');
}

function appendScoringFooter(content: string, item: ParsedQtiItem): string {
  const footer = buildScoringFooter(item);
  if (footer === undefined) {
    return content;
  }

  return [content.trimEnd(), '---', footer].filter((value) => value.length > 0).join('\n\n');
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
  const content = appendScoringFooter(
    toTrackSafeRichText(
      item.interactionType === 'text-entry'
        ? ensureClozePlaceholders(item.prompt, item.blanks)
        : item.prompt,
    ),
    item,
  );
  const basePayload: TrackQuestionPayload = {
    title: item.title,
    questionKind: toQuestionKind(item),
    status: 2,
    content,
    howToSolve: toTrackSafeRichText(item.feedback.join('\n').trim()),
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
