import { describe, expect, it } from 'vitest';
import {
  parseAssessmentItemXml,
  parseAssessmentXml,
  parseQtiPackageFromXml,
} from '../src/parser/qti-parser.js';
import { parseXml } from '../src/parser/xml-parser.js';

describe('xml-parser', () => {
  it('removes namespace prefixes from parsed nodes', () => {
    const parsed = parseXml(`
      <qti-assessment-item:assessmentItem xmlns:qti-assessment-item="http://www.imsglobal.org/xsd/imsqti_v2p1">
        <qti-assessment-item:itemBody>
          <qti-assessment-item:p>Hello</qti-assessment-item:p>
        </qti-assessment-item:itemBody>
      </qti-assessment-item:assessmentItem>
    `);

    expect(parsed.assessmentItem).toBeDefined();
  });
});

describe('qti-parser', () => {
  it('parses assessment-test with item references', () => {
    const assessmentXml = `
      <assessment-test:assessmentTest xmlns:assessment-test="http://www.imsglobal.org/xsd/imsqti_v2p1" identifier="A-1" title="Unit Test">
        <assessment-test:testPart identifier="TP-1">
          <assessment-test:assessmentSection identifier="SEC-1">
            <assessment-test:assessmentItemRef identifier="ITEM-1" href="items/item1.xml" />
            <assessment-test:assessmentItemRef identifier="ITEM-2" href="items/item2.xml" />
            <assessment-test:timeLimits maxTime="PT2M10S" />
          </assessment-test:assessmentSection>
        </assessment-test:testPart>
      </assessment-test:assessmentTest>
    `;

    const parsed = parseAssessmentXml(assessmentXml);
    expect(parsed.identifier).toBe('A-1');
    expect(parsed.title).toBe('Unit Test');
    expect(parsed.timeLimitSeconds).toBe(130);
    expect(parsed.itemRefs).toEqual([
      { identifier: 'ITEM-1', href: 'items/item1.xml' },
      { identifier: 'ITEM-2', href: 'items/item2.xml' },
    ]);
  });

  it('parses choice item including prompt, choices, answers, rubric and feedback', () => {
    const itemXml = `
      <qti-assessment-item:assessmentItem xmlns:qti-assessment-item="http://www.imsglobal.org/xsd/imsqti_v2p1" identifier="ITEM-1" title="Capital City">
        <qti-assessment-item:responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier">
          <qti-assessment-item:correctResponse>
            <qti-assessment-item:value>CHOICE_B</qti-assessment-item:value>
          </qti-assessment-item:correctResponse>
        </qti-assessment-item:responseDeclaration>
        <qti-assessment-item:itemBody>
          <qti-assessment-item:p>Select the capital of France.</qti-assessment-item:p>
          <qti-assessment-item:choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">
            <qti-assessment-item:simpleChoice identifier="CHOICE_A">Berlin</qti-assessment-item:simpleChoice>
            <qti-assessment-item:simpleChoice identifier="CHOICE_B">Paris</qti-assessment-item:simpleChoice>
          </qti-assessment-item:choiceInteraction>
        </qti-assessment-item:itemBody>
        <qti-assessment-item:rubricBlock view="scorer">Geography basics</qti-assessment-item:rubricBlock>
        <qti-assessment-item:modalFeedback identifier="FB-1" outcomeIdentifier="FEEDBACK" showHide="show">Correct: Paris</qti-assessment-item:modalFeedback>
      </qti-assessment-item:assessmentItem>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.identifier).toBe('ITEM-1');
    expect(parsed.title).toBe('Capital City');
    expect(parsed.interactionType).toBe('choice');
    expect(parsed.prompt).toBe('Select the capital of France.');
    expect(parsed.choices).toEqual([
      { identifier: 'CHOICE_A', text: 'Berlin' },
      { identifier: 'CHOICE_B', text: 'Paris' },
    ]);
    expect(parsed.correctResponses).toEqual(['CHOICE_B']);
    expect(parsed.rubric).toEqual(['Geography basics']);
    expect(parsed.feedback).toEqual(['Correct: Paris']);
  });

  it('parses text-entry and extended-text interaction types', () => {
    const textEntryXml = `
      <assessmentItem identifier="ITEM-TE" title="Fill Blank">
        <responseDeclaration identifier="RESPONSE" cardinality="single" baseType="string">
          <correctResponse><value>oxygen</value></correctResponse>
        </responseDeclaration>
        <itemBody>
          <p>Type the word.</p>
          <textEntryInteraction responseIdentifier="RESPONSE" expectedLength="6" />
        </itemBody>
      </assessmentItem>
    `;

    const extendedTextXml = `
      <assessmentItem identifier="ITEM-ET" title="Explain">
        <itemBody>
          <p>Explain your reasoning.</p>
          <extendedTextInteraction responseIdentifier="RESPONSE" expectedLines="4" />
        </itemBody>
      </assessmentItem>
    `;

    const textEntry = parseAssessmentItemXml(textEntryXml);
    const extendedText = parseAssessmentItemXml(extendedTextXml);

    expect(textEntry.interactionType).toBe('text-entry');
    expect(textEntry.correctResponses).toEqual(['oxygen']);
    expect(extendedText.interactionType).toBe('extended-text');
  });

  it('parses package from assessment and item map', () => {
    const assessmentXml = `
      <assessmentTest identifier="A-2">
        <testPart identifier="TP-1">
          <assessmentSection identifier="SEC-1">
            <assessmentItemRef identifier="ITEM-1" href="item1.xml" />
            <assessmentItemRef identifier="ITEM-2" href="item2.xml" />
          </assessmentSection>
        </testPart>
      </assessmentTest>
    `;

    const item1Xml = `
      <assessmentItem identifier="ITEM-1" title="Q1">
        <itemBody>
          <p>Pick one.</p>
          <choiceInteraction responseIdentifier="RESPONSE">
            <simpleChoice identifier="A">A</simpleChoice>
          </choiceInteraction>
        </itemBody>
      </assessmentItem>
    `;

    const parsedPackage = parseQtiPackageFromXml({
      assessmentXml,
      itemXmlByIdentifier: {
        'ITEM-1': item1Xml,
      },
    });

    expect(parsedPackage.assessment.identifier).toBe('A-2');
    expect(parsedPackage.items).toHaveLength(1);
    expect(parsedPackage.itemsByIdentifier['ITEM-1']?.title).toBe('Q1');
    expect(parsedPackage.itemsByIdentifier['ITEM-2']).toBeUndefined();
  });
});
