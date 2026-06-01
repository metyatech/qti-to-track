const DEFAULT_ITEM_TIME_LIMIT_SECONDS = 60;
function isPositiveFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function toQuestionKind(item) {
    if (item.interactionType === 'choice') {
        return 1;
    }
    if (item.interactionType === 'text-entry') {
        return 2;
    }
    return 3;
}
function toTrackBlankPayload(blank) {
    return {
        answer: blank.answer,
        kind: blank.kind,
        caseSensitive: false,
    };
}
function toTrackChoicePayload(choice, correctResponses) {
    return {
        content: choice.text,
        correct: correctResponses.has(choice.identifier),
    };
}
function toPlaceholder(blank) {
    if (blank.answer.length === 0) {
        return '${}';
    }
    return blank.kind === 'regex' ? `\${/${blank.answer}/}` : `\${${blank.answer}}`;
}
function ensureClozePlaceholders(content, blanks) {
    if (blanks.length === 0) {
        return content;
    }
    if (/\$\{[^}]*\}/.test(content)) {
        return content;
    }
    const placeholders = blanks.map(toPlaceholder).join(' ');
    return content.length > 0 ? `${content}\n${placeholders}` : placeholders;
}
function formatMaxScore(maxScore) {
    return Number.isInteger(maxScore) ? String(maxScore) : String(maxScore);
}
function buildScoringFooter(item) {
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
function appendScoringFooter(content, item) {
    const footer = buildScoringFooter(item);
    if (footer === undefined) {
        return content;
    }
    return [content.trimEnd(), '---', footer].filter((value) => value.length > 0).join('\n\n');
}
function estimateItemTimeLimitSeconds(item) {
    if (isPositiveFiniteNumber(item.timeLimitSeconds)) {
        return item.timeLimitSeconds;
    }
    return DEFAULT_ITEM_TIME_LIMIT_SECONDS;
}
function estimateMaterialTimeLimitSeconds(parsed) {
    if (isPositiveFiniteNumber(parsed.assessment.timeLimitSeconds)) {
        return parsed.assessment.timeLimitSeconds;
    }
    return parsed.items.reduce((sum, item) => sum + estimateItemTimeLimitSeconds(item), 0);
}
function toQuestionPayload(item) {
    const content = appendScoringFooter(item.interactionType === 'text-entry'
        ? ensureClozePlaceholders(item.prompt, item.blanks)
        : item.prompt, item);
    const basePayload = {
        title: item.title,
        questionKind: toQuestionKind(item),
        status: 2,
        content,
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
            blanks: item.blanks.map(toTrackBlankPayload),
        };
    }
    return basePayload;
}
export function toTrackPayloads(parsed, options = {}) {
    const questions = parsed.items.map(toQuestionPayload);
    const totalSeconds = estimateMaterialTimeLimitSeconds(parsed);
    const materialDraft = {
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
