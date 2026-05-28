const DEFAULT_ITEM_TIME_LIMIT_SECONDS = 60;
function toQuestionKind(item) {
    if (item.interactionType === 'choice') {
        return 1;
    }
    if (item.interactionType === 'text-entry') {
        return 2;
    }
    return 4;
}
function isRegexAnswer(value) {
    return value.length >= 2 && value.startsWith('/') && value.endsWith('/');
}
function toTrackBlankPayload(answer) {
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
function toTrackChoicePayload(choice, correctResponses) {
    return {
        content: choice.text,
        correct: correctResponses.has(choice.identifier),
    };
}
function toPlaceholder(answer) {
    return answer.length > 0 ? `\${${answer}}` : '${}';
}
function ensureClozePlaceholders(content, correctResponses) {
    if (correctResponses.length === 0) {
        return content;
    }
    if (/\$\{[^}]*\}/.test(content)) {
        return content;
    }
    const placeholders = correctResponses.map(toPlaceholder).join(' ');
    return content.length > 0 ? `${content}\n${placeholders}` : placeholders;
}
function estimateItemTimeLimitSeconds(item) {
    if (typeof item.timeLimitSeconds === 'number' && Number.isFinite(item.timeLimitSeconds) && item.timeLimitSeconds > 0) {
        return item.timeLimitSeconds;
    }
    return DEFAULT_ITEM_TIME_LIMIT_SECONDS;
}
function toQuestionPayload(item) {
    const basePayload = {
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
export function toTrackPayloads(parsed) {
    const questions = parsed.items.map(toQuestionPayload);
    const totalSeconds = parsed.items.reduce((sum, item) => sum + estimateItemTimeLimitSeconds(item), 0);
    const material = {
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
