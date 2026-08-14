import { describe, expect, it } from 'vitest';
import {
  parseAssessmentItemXml,
  parseAssessmentXml,
  parseQtiPackageFromXml,
} from '../src/parser/qti-parser.js';
import { parseXml } from '../src/parser/xml-parser.js';

describe('xml-parser', () => {
  it('normalizes QTI namespace prefixes for structural nodes', () => {
    const parsed = parseXml(`
      <qti-assessment-item:assessmentItem xmlns:qti-assessment-item="http://www.imsglobal.org/xsd/imsqti_v2p1">
        <qti-assessment-item:itemBody><p>Hello</p></qti-assessment-item:itemBody>
      </qti-assessment-item:assessmentItem>
    `);

    expect(parsed.assessmentItem).toBeDefined();
  });
});

describe('qti-parser', () => {
  it('parses assessment-test references and time limits', () => {
    const parsed = parseAssessmentXml(`
      <assessment-test:assessmentTest xmlns:assessment-test="http://www.imsglobal.org/xsd/imsqti_v2p1" identifier="A-1" title="Unit Test">
        <assessment-test:testPart identifier="TP-1">
          <assessment-test:assessmentSection identifier="SEC-1">
            <assessment-test:assessmentItemRef identifier="ITEM-1" href="items/item1.xml" />
            <assessment-test:assessmentItemRef identifier="ITEM-2" href="items/item2.xml" />
            <assessment-test:timeLimits maxTime="PT2M10S" />
          </assessment-test:assessmentSection>
        </assessment-test:testPart>
      </assessment-test:assessmentTest>
    `);

    expect(parsed.identifier).toBe('A-1');
    expect(parsed.title).toBe('Unit Test');
    expect(parsed.timeLimitSeconds).toBe(130);
    expect(parsed.itemRefs).toEqual([
      { identifier: 'ITEM-1', href: 'items/item1.xml' },
      { identifier: 'ITEM-2', href: 'items/item2.xml' },
    ]);
  });

  it('serializes ordered presentation HTML, attributes, headings, and links without Markdown conversion', () => {
    const parsed = parseAssessmentItemXml(`
      <qti-assessment-item identifier="ITEM-RICH" title="Rich HTML">
        <qti-item-body>
          <h3 id="heading" class="section" data-kind="prompt">Heading</h3>
          <p id="prompt" class="lead" data-kind="question">Hello <span style="color: red;" class="accent" title="label">world</span> <a href="https://example.com" aria-label="example">link</a>.</p>
          <p>![diagram](assets/diagram.png)</p>
          <qti-extended-text-interaction response-identifier="RESPONSE" />
        </qti-item-body>
      </qti-assessment-item>
    `);

    expect(parsed.prompt).toBe(
      '<h3 id="heading" class="section" data-kind="prompt">Heading</h3>\n          <p id="prompt" class="lead" data-kind="question">Hello <span style="color: red;" class="accent" title="label">world</span> <a href="https://example.com" aria-label="example">link</a>.</p>\n          <p>![diagram](assets/diagram.png)</p>',
    );
    expect(parsed.prompt).not.toContain('### Heading');
    expect(parsed.prompt).not.toContain('<img');
  });

  it('preserves pre/code whitespace and nested markup while placing text-entry placeholders structurally', () => {
    const parsed = parseAssessmentItemXml(`
      <qti-assessment-item identifier="ITEM-CODE" title="Code Cloze">
        <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="string">
          <qti-correct-response><qti-value>answer</qti-value></qti-correct-response>
        </qti-response-declaration>
        <qti-item-body><pre><code>  foo <span style="color:red" class="token">A</span> <textEntryInteraction responseIdentifier="RESPONSE"/> bar\n</code></pre></qti-item-body>
      </qti-assessment-item>
    `);

    expect(parsed.prompt).toBe(
      '<pre><code>  foo <span style="color:red" class="token">A</span> ${answer} bar\n</code></pre>',
    );
    expect(parsed.blanks).toEqual([
      { responseIdentifier: 'RESPONSE', answer: 'answer', kind: 'exact' },
    ]);
  });

  it('keeps rich HTML in choices and feedback', () => {
    const parsed = parseAssessmentItemXml(`
      <qti-assessment-item identifier="ITEM-CHOICE" title="Rich Choice">
        <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
          <qti-correct-response><qti-value>CHOICE_B</qti-value></qti-correct-response>
        </qti-response-declaration>
        <qti-item-body><p>Choose one.</p><qti-choice-interaction response-identifier="RESPONSE">
          <qti-simple-choice identifier="CHOICE_A"><p class="choice"><strong>A</strong> <img src="assets/a.png" alt="A" style="width: 2em;" /></p></qti-simple-choice>
          <qti-simple-choice identifier="CHOICE_B"><p data-choice="b"><span style="font-weight:bold">B</span></p></qti-simple-choice>
        </qti-choice-interaction></qti-item-body>
        <qti-modal-feedback identifier="EXPLANATION" outcome-identifier="FEEDBACK" show-hide="show"><qti-content-body><p class="explanation">Correct <em>answer</em>.</p></qti-content-body></qti-modal-feedback>
      </qti-assessment-item>
    `);

    expect(parsed.choices).toEqual([
      {
        identifier: 'CHOICE_A',
        text: '<p class="choice"><strong>A</strong> <img src="assets/a.png" alt="A" style="width: 2em;" /></p>',
      },
      {
        identifier: 'CHOICE_B',
        text: '<p data-choice="b"><span style="font-weight:bold">B</span></p>',
      },
    ]);
    expect(parsed.feedback).toEqual(['<p class="explanation">Correct <em>answer</em>.</p>']);
  });

  it('extracts scorer rubric separately and preserves HTML headings', () => {
    const parsed = parseAssessmentItemXml(`
      <qti-assessment-item identifier="ITEM-RUBRIC" title="Rubric">
        <qti-outcome-declaration identifier="MAXSCORE" cardinality="single" base-type="float"><qti-default-value><qti-value>3</qti-value></qti-default-value></qti-outcome-declaration>
        <qti-item-body><h1>見出し1</h1><h2>見出し2</h2><qti-rubric-block view="candidate"><p>Candidate note</p></qti-rubric-block><qti-rubric-block view="scorer"><p>[2] Strong answer</p><p>[1] Complete answer</p></qti-rubric-block><qti-extended-text-interaction response-identifier="RESPONSE" /></qti-item-body>
      </qti-assessment-item>
    `);

    expect(parsed.prompt).toBe('<h1>見出し1</h1><h2>見出し2</h2>');
    expect(parsed.rubric).toEqual([
      '<p>Candidate note</p>',
      '<p>[2] Strong answer</p><p>[1] Complete answer</p>',
    ]);
    expect(parsed.scorerRubric).toEqual(['[2] Strong answer', '[1] Complete answer']);
    expect(parsed.maxScore).toBe(3);
  });

  it('preserves regex text-entry declarations and returns the correct Track interaction type', () => {
    const parsed = parseAssessmentItemXml(`
      <qti-assessment-item identifier="ITEM-REGEX" title="Regex Blank">
        <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="string" interpretation="regex"><qti-correct-response><qti-value>/transform|all/</qti-value></qti-correct-response></qti-response-declaration>
        <qti-item-body><p>Match <qti-text-entry-interaction response-identifier="RESPONSE" />.</p></qti-item-body>
      </qti-assessment-item>
    `);

    expect(parsed.interactionType).toBe('text-entry');
    expect(parsed.prompt).toBe('<p>Match ${/transform|all/}.</p>');
    expect(parsed.blanks).toEqual([
      { responseIdentifier: 'RESPONSE', answer: 'transform|all', kind: 'regex' },
    ]);
  });

  it('parses a package while preserving assessment item order', () => {
    const parsedPackage = parseQtiPackageFromXml({
      assessmentXml: '<assessmentTest identifier="A-2"><testPart><assessmentSection><assessmentItemRef identifier="ITEM-1" href="item1.xml" /><assessmentItemRef identifier="ITEM-2" href="item2.xml" /></assessmentSection></testPart></assessmentTest>',
      itemXmlByIdentifier: {
        'ITEM-1': '<assessmentItem identifier="ITEM-1" title="Q1"><itemBody><p>Pick one.</p><choiceInteraction responseIdentifier="RESPONSE"><simpleChoice identifier="A">A</simpleChoice></choiceInteraction></itemBody></assessmentItem>',
      },
    });

    expect(parsedPackage.assessment.identifier).toBe('A-2');
    expect(parsedPackage.items.map((item) => item.identifier)).toEqual(['ITEM-1']);
    expect(parsedPackage.itemsByIdentifier['ITEM-2']).toBeUndefined();
  });
});
