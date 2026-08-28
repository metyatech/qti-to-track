import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQtiPackage, parseQtiPackageFromXml, toTrackPayloads } from '../src/index.js';
import { toTrackMaterialPayload } from '../src/publish/publisher.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(testDir, 'fixtures/canonical-qti');
const movieTicketRichContentFixture = resolve(testDir, 'fixtures/movie-ticket-rich-content.qti.xml');

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

describe('integration: canonical QTI fixtures', () => {
  it('loads canonical QTI fixture package from directory', async () => {
    const parsed = await loadQtiPackage(fixtureDir);

    expect(parsed.assessment.identifier).toBe('canonical-qti-sample-test');
    expect(parsed.items).toHaveLength(3);
    expect(parsed.itemsByIdentifier['choice-item']?.interactionType).toBe('choice');
    expect(parsed.itemsByIdentifier['cloze-item']?.interactionType).toBe('text-entry');
    expect(parsed.itemsByIdentifier['descriptive-item']?.interactionType).toBe('extended-text');
  });

  it('converts parsed package to Track payload format', async () => {
    const parsed = await loadQtiPackage(fixtureDir);
    const payload = toTrackPayloads(parsed);

    expect(payload.materialDraft.title).toBe('Canonical QTI Sample Test');
    expect(payload.materialDraft.questionKeys).toEqual(['choice-item', 'cloze-item', 'descriptive-item']);
    expect(payload.materialDraft.materialTypes).toEqual(['others']);

    const choiceQuestion = payload.questions.find((question) => question.title === 'Choice Item');
    expect(choiceQuestion?.questionKind).toBe(1);
    expect(choiceQuestion?.choices).toEqual([
      { content: '<span class="choice-number" data-choice="one">1</span>', correct: false },
      { content: '<span style="font-weight: bold;" class="choice-number" data-choice="two">2</span>', correct: true },
      { content: '<span class="choice-number" data-choice="three">3</span>', correct: false },
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
    expect(descriptiveQuestion?.content).toContain('<p>Explain the diagram below. <img src="assets/diagram.png" alt="Cell diagram" /></p>');
    expect(descriptiveQuestion?.content).toContain('<hr />');
    expect(descriptiveQuestion?.content).toContain('<details>');
    expect(descriptiveQuestion?.content).toContain('<summary><strong>採点基準（最大点: 3点）</strong></summary>');
    expect(descriptiveQuestion?.content).toContain('<p>[2点] Mentions nucleus</p>');
    expect(descriptiveQuestion?.content).toContain('<p>[1点] Mentions cell</p>');
    expect(descriptiveQuestion?.content).not.toContain('---');
    expect(descriptiveQuestion?.howToSolve).toBe('<p class="explanation">It is a <em>plant</em> cell.</p>');
  });

  it('escapes scorer rubric text inside the HTML scoring footer', () => {
    const parsed = parseQtiPackageFromXml({
      assessmentXml: '<assessmentTest identifier="footer-assessment"><testPart><assessmentSection><assessmentItemRef identifier="footer-question" href="footer-question.xml" /></assessmentSection></testPart></assessmentTest>',
      itemXmlByIdentifier: {
        'footer-question': '<assessmentItem identifier="footer-question" title="Footer"><outcomeDeclaration identifier="MAXSCORE" cardinality="single" baseType="float"><defaultValue><value>1</value></defaultValue></outcomeDeclaration><itemBody><p>Question</p><extendedTextInteraction responseIdentifier="RESPONSE" /><rubricBlock view="scorer"><p>[1] Use &lt;tag&gt; &amp; safe text</p></rubricBlock></itemBody></assessmentItem>',
      },
    });

    const content = toTrackPayloads(parsed).questions[0]?.content;
    expect(content).toContain('<hr />');
    expect(content).toContain('<details>');
    expect(content).toContain('<p>[1点] Use &lt;tag&gt; &amp; safe text</p>');
    expect(content).not.toContain('<p>[1点] Use <tag>');
  });

  it('preserves QTI inline line breaks in Track question payloads', () => {
    const assessmentXml = `
      <assessmentTest identifier="inline-br-assessment" title="Inline Line Breaks">
        <testPart identifier="test-part">
          <assessmentSection identifier="section">
            <assessmentItemRef identifier="inline-br-question" href="inline-br-question.qti.xml" />
          </assessmentSection>
        </testPart>
      </assessmentTest>
    `;
    const itemXml = `
      <assessmentItem identifier="inline-br-question" title="Inline Line Breaks">
        <responseDeclaration identifier="RESPONSE" cardinality="single" base-type="identifier">
          <correctResponse>
            <value>CHOICE_1</value>
          </correctResponse>
        </responseDeclaration>
        <itemBody>
          <p>本文1<br/>本文2</p>
          <choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">
            <simpleChoice identifier="CHOICE_1">選択肢1<br/>選択肢2</simpleChoice>
          </choiceInteraction>
        </itemBody>
        <modalFeedback identifier="EXPLANATION" outcomeIdentifier="FEEDBACK" showHide="show">
          <contentBody>
            <p>解説1<br/>解説2</p>
          </contentBody>
        </modalFeedback>
      </assessmentItem>
    `;

    const parsed = parseQtiPackageFromXml({
      assessmentXml,
      itemXmlByIdentifier: { 'inline-br-question': itemXml },
    });
    const question = toTrackPayloads(parsed).questions[0];

    expect(question?.content).toContain('<p>本文1<br />本文2</p>');
    expect(question?.choices).toEqual([{ content: '選択肢1<br />選択肢2', correct: true }]);
    expect(question?.howToSolve).toContain('<p>解説1<br />解説2</p>');
  });

  it('keeps exam demo URLs in generated Track question payloads', () => {
    const demoUrl = 'https://course-exam-demos.vercel.app/f21f43d1df7547c4/';
    const assessmentXml = `
      <assessment-test identifier="demo-assessment" title="Demo Assessment">
        <qti-test-part identifier="test-part">
          <assessment-section identifier="section">
            <assessment-item-ref identifier="demo-question" href="demo-question.qti.xml" />
          </qti-assessment-section>
        </qti-test-part>
      </qti-assessment-test>
    `;
    const itemXml = `
      <qti-assessment-item identifier="demo-question" title="Demo Question">
        <qti-item-body>
          <p><a href="${demoUrl}">完成見本を開く</a></p>
          <qti-extended-text-interaction response-identifier="RESPONSE" />
        </qti-item-body>
      </qti-assessment-item>
    `;

    const parsed = parseQtiPackageFromXml({
      assessmentXml,
      itemXmlByIdentifier: { 'demo-question': itemXml },
    });
    const payload = toTrackPayloads(parsed);

    const expectedDemoLink = `<a href="${demoUrl}" target="_blank" rel="noopener noreferrer">完成見本を開く</a>`;
    expect(parsed.items[0]?.prompt).toBe(`<p>${expectedDemoLink}</p>`);
    expect(payload.questions[0]?.content).toBe(`<p>${expectedDemoLink}</p>`);
  });

  it('keeps movie ticket prompt structure as canonical HTML', async () => {
    const itemXml = await readFile(movieTicketRichContentFixture, 'utf8');
    const assessmentXml = `
      <assessment-test identifier="movie-ticket-assessment" title="Movie Ticket Assessment">
        <qti-test-part identifier="test-part">
          <assessment-section identifier="section">
            <assessment-item-ref identifier="movie-ticket-calculator" href="movie-ticket-calculator.qti.xml" />
          </qti-assessment-section>
        </qti-test-part>
      </qti-assessment-test>
    `;

    const parsed = parseQtiPackageFromXml({
      assessmentXml,
      itemXmlByIdentifier: { 'movie-ticket-calculator': itemXml },
    });
    const payload = toTrackPayloads(parsed);
    const prompt = parsed.items[0]?.prompt ?? '';

    expect(payload.questions[0]?.content).toContain('<h3>完成見本</h3>');
    expect(payload.questions[0]?.content).toContain('<h3>完成させる機能</h3>');
    expect(payload.questions[0]?.content).toContain('<h3>料金</h3>');
    expect(payload.questions[0]?.content).toContain('<h3>動作確認の例</h3>');
    expect(payload.questions[0]?.content).not.toContain('### 完成見本');
    expect(prompt).toContain('<table>');
    expect(prompt).toContain('<th style="text-align: right;">料金</th>');
    expect(prompt).toContain('<code>result-box action</code>');
    expect(payload.questions[0]?.content).not.toContain('### 完成見本');
    expect(payload.questions[0]?.content).not.toContain('| 項目 | 料金 |');
  });

  it('preserves headings, code text, and rich feedback as HTML', () => {
    const assessmentXml = `
      <assessment-test identifier="heading-assessment" title="Heading Assessment">
        <qti-test-part identifier="test-part">
          <assessment-section identifier="section">
            <assessment-item-ref identifier="heading-question" href="heading-question.qti.xml" />
          </qti-assessment-section>
        </qti-test-part>
      </qti-assessment-test>
    `;
    const itemXml = `
      <qti-assessment-item identifier="heading-question" title="Heading Question">
        <qti-item-body>
          <h1>見出し1</h1>
          <h2>見出し2</h2>
          <h3>見出し3</h3>
          <h4>見出し4</h4>
          <h5>見出し5</h5>
          <h6>見出し6</h6>
          <pre><code>### コード内の見出し記号</code></pre>
          <qti-extended-text-interaction response-identifier="RESPONSE" />
        </qti-item-body>
        <qti-modal-feedback identifier="EXPLANATION" outcome-identifier="FEEDBACK" show-hide="show">
          <h3>解説見出し</h3>
          <table>
            <thead><tr><th>項目</th><th>値</th></tr></thead>
            <tbody><tr><td>A</td><td>B</td></tr></tbody>
          </table>
        </qti-modal-feedback>
      </qti-assessment-item>
    `;

    const parsed = parseQtiPackageFromXml({
      assessmentXml,
      itemXmlByIdentifier: { 'heading-question': itemXml },
    });
    const question = toTrackPayloads(parsed).questions[0];

    expect(parsed.items[0]?.prompt).toContain('<h3>見出し3</h3>');
    expect(question?.content).toContain('<h1>見出し1</h1>');
    expect(question?.content).toContain('<h2>見出し2</h2>');
    expect(question?.content).toContain('<h3>見出し3</h3>');
    expect(question?.content).toContain('<h4>見出し4</h4>');
    expect(question?.content).toContain('<h5>見出し5</h5>');
    expect(question?.content).toContain('<h6>見出し6</h6>');
    expect(question?.content).toContain('<pre><code>### コード内の見出し記号</code></pre>');
    expect(question?.howToSolve).toContain('<h3>解説見出し</h3>');
    expect(question?.howToSolve).toContain('<table>');
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
