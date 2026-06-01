import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQtiPackage, parseQtiPackageFromXml, toTrackPayloads } from '../src/index.js';
import { toTrackMaterialPayload } from '../src/publish/publisher.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(testDir, 'fixtures/markdown-to-qti');

function buildChoiceItemXml(identifier: string, maxTime: string): string {
  return `
    <assessmentItem identifier="${identifier}" title="${identifier}">
      <itemBody>
        <p>Pick one.</p>
        <choiceInteraction responseIdentifier="RESPONSE">
          <simpleChoice identifier="A">A</simpleChoice>
        </choiceInteraction>
      </itemBody>
      <timeLimits maxTime="${maxTime}" />
    </assessmentItem>
  `;
}

function buildPayloadMinutes(assessmentXml: string, itemXmlByIdentifier: Record<string, string>): number {
  const parsed = parseQtiPackageFromXml({ assessmentXml, itemXmlByIdentifier });
  return toTrackPayloads(parsed).materialDraft.basicTimeMinutes;
}

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

    expect(payload.materialDraft.title).toBe('Markdown to QTI Sample Test');
    expect(payload.materialDraft.questionKeys).toEqual(['choice-item', 'cloze-item', 'descriptive-item']);
    expect(payload.materialDraft.materialTypes).toEqual(['others']);

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
    expect(descriptiveQuestion?.questionKind).toBe(3);
    expect(descriptiveQuestion?.choices).toBeUndefined();
    expect(descriptiveQuestion?.blanks).toBeUndefined();
    expect(descriptiveQuestion?.content).toBe([
      'Explain the diagram below. ![Cell diagram](assets/diagram.png)',
      '',
      '---',
      '',
      '<details>',
      '<summary><strong>採点基準（最大点: 3点）</strong></summary>',
      '',
      '[2点] Mentions nucleus',
      '',
      '[1点] Mentions cell',
      '',
      '</details>',
    ].join('\n'));
  });

  it('rounds material basicTimeMinutes up from fixture section time limit', async () => {
    const parsed = await loadQtiPackage(fixtureDir);
    const payload = toTrackPayloads(parsed);

    // PT2M10S = 130 seconds => ceil(130 / 60) = 3 minutes.
    expect(payload.materialDraft.basicTimeMinutes).toBe(3);
  });

  it('builds API material payload with numeric question IDs and string material types', async () => {
    const parsed = await loadQtiPackage(fixtureDir);
    const payload = toTrackPayloads(parsed, { materialType: 'js-css-html' });

    const materialPayload = toTrackMaterialPayload(payload.materialDraft, [101, 102, 103]);

    expect(materialPayload.questionIds).toEqual([101, 102, 103]);
    expect(materialPayload.questionIds.every((id) => typeof id === 'number')).toBe(true);
    expect(materialPayload.materialTypes).toEqual(['js-css-html']);
    expect(materialPayload.materialTypes.every((type) => typeof type === 'string')).toBe(true);
  });

  it('rounds material basicTimeMinutes up from package-level PT2M10S', () => {
    const assessmentXml = `
      <assessmentTest identifier="A-PT" title="Package ISO Limit">
        <testPart identifier="TP-1">
          <assessmentSection identifier="SEC-1">
            <assessmentItemRef identifier="ITEM-1" href="item1.xml" />
            <qti-time-limits max-time="PT2M10S" />
          </assessmentSection>
        </testPart>
      </assessmentTest>
    `;

    expect(buildPayloadMinutes(assessmentXml, {
      'ITEM-1': buildChoiceItemXml('ITEM-1', '1'),
    })).toBe(3);
  });

  it('rounds material basicTimeMinutes up from numeric package-level seconds', () => {
    const assessmentXml = `
      <assessmentTest identifier="A-NUM" title="Package Numeric Limit">
        <testPart identifier="TP-1">
          <timeLimits maxTime="130" />
          <assessmentSection identifier="SEC-1">
            <assessmentItemRef identifier="ITEM-1" href="item1.xml" />
          </assessmentSection>
        </testPart>
      </assessmentTest>
    `;

    expect(buildPayloadMinutes(assessmentXml, {
      'ITEM-1': buildChoiceItemXml('ITEM-1', '1'),
    })).toBe(3);
  });

  it('uses package-level time limit instead of summed item time limits', () => {
    const assessmentXml = `
      <assessmentTest identifier="A-OVERRIDE" title="Package Override">
        <testPart identifier="TP-1">
          <assessmentSection identifier="SEC-1">
            <assessmentItemRef identifier="ITEM-1" href="item1.xml" />
            <assessmentItemRef identifier="ITEM-2" href="item2.xml" />
            <qti-time-limits max-time="PT2M10S" />
          </assessmentSection>
        </testPart>
      </assessmentTest>
    `;

    expect(buildPayloadMinutes(assessmentXml, {
      'ITEM-1': buildChoiceItemXml('ITEM-1', '120'),
      'ITEM-2': buildChoiceItemXml('ITEM-2', '120'),
    })).toBe(3);
  });

  it('falls back to summed item time limits when no package-level limit exists', () => {
    const assessmentXml = `
      <assessmentTest identifier="A-FALLBACK" title="Item Fallback">
        <testPart identifier="TP-1">
          <assessmentSection identifier="SEC-1">
            <assessmentItemRef identifier="ITEM-1" href="item1.xml" />
            <assessmentItemRef identifier="ITEM-2" href="item2.xml" />
            <assessmentItemRef identifier="ITEM-3" href="item3.xml" />
          </assessmentSection>
        </testPart>
      </assessmentTest>
    `;

    expect(buildPayloadMinutes(assessmentXml, {
      'ITEM-1': buildChoiceItemXml('ITEM-1', '65'),
      'ITEM-2': buildChoiceItemXml('ITEM-2', '59'),
      'ITEM-3': buildChoiceItemXml('ITEM-3', '6'),
    })).toBe(3);
  });
});
