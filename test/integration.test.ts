import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQtiPackage, toTrackPayloads } from '../src/index.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(testDir, 'fixtures/markdown-to-qti');

describe('integration: markdown-to-qti fixtures', () => {
  it('loads markdown-to-qti fixture package from directory', async () => {
    const parsed = await loadQtiPackage(fixtureDir);

    expect(parsed.assessment.identifier).toBe('md2qti-sample-test');
    expect(parsed.items).toHaveLength(3);
    expect(parsed.itemsByIdentifier['choice-item']?.interactionType).toBe('choice');
    expect(parsed.itemsByIdentifier['cloze-item']?.interactionType).toBe('text-entry');
    expect(parsed.itemsByIdentifier['descriptive-item']?.interactionType).toBe('extended-text');
  });

  it('converts parsed package to Track payload format', async () => {
    const parsed = await loadQtiPackage(fixtureDir);
    const payload = toTrackPayloads(parsed);

    expect(payload.material.title).toBe('Markdown to QTI Sample Test');
    expect(payload.material.questionIds).toEqual(['choice-item', 'cloze-item', 'descriptive-item']);

    const choiceQuestion = payload.questions.find((question) => question.title === 'Choice Item');
    expect(choiceQuestion?.questionKind).toBe(1);
    expect(choiceQuestion?.choices).toEqual([
      { content: '1', correct: false },
      { content: '2', correct: true },
      { content: '3', correct: false },
    ]);

    const clozeQuestion = payload.questions.find((question) => question.title === 'Cloze Item');
    expect(clozeQuestion?.questionKind).toBe(2);
    expect(clozeQuestion?.blanks).toEqual([
      { answer: 'Tokyo', kind: 'exact', caseSensitive: false },
      { answer: 'reiwa', kind: 'regex', caseSensitive: false },
    ]);

    const descriptiveQuestion = payload.questions.find((question) => question.title === 'Descriptive Item');
    expect(descriptiveQuestion?.questionKind).toBe(4);
    expect(descriptiveQuestion?.choices).toBeUndefined();
    expect(descriptiveQuestion?.blanks).toBeUndefined();
  });

  it('rounds material basicTimeMinutes up from summed item time limits', async () => {
    const parsed = await loadQtiPackage(fixtureDir);
    const payload = toTrackPayloads(parsed);

    // 65 + 59 + 6 = 130 seconds => ceil(130 / 60) = 3 minutes.
    expect(payload.material.basicTimeMinutes).toBe(3);
  });
});
