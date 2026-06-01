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
        <qti-assessment-item:outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float" />
        <qti-assessment-item:outcomeDeclaration identifier="MAXSCORE" cardinality="single" baseType="float">
          <qti-assessment-item:defaultValue>
            <qti-assessment-item:value>3.5</qti-assessment-item:value>
          </qti-assessment-item:defaultValue>
        </qti-assessment-item:outcomeDeclaration>
        <qti-assessment-item:itemBody>
          <qti-assessment-item:p>Select the capital of France.</qti-assessment-item:p>
          <qti-assessment-item:choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">
            <qti-assessment-item:simpleChoice identifier="CHOICE_A">Berlin</qti-assessment-item:simpleChoice>
            <qti-assessment-item:simpleChoice identifier="CHOICE_B">Paris</qti-assessment-item:simpleChoice>
          </qti-assessment-item:choiceInteraction>
        </qti-assessment-item:itemBody>
        <qti-assessment-item:rubricBlock view="candidate">Read the question carefully</qti-assessment-item:rubricBlock>
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
    expect(parsed.rubric).toEqual(['Read the question carefully', 'Geography basics']);
    expect(parsed.scorerRubric).toEqual(['Geography basics']);
    expect(parsed.maxScore).toBe(3.5);
    expect(parsed.feedback).toEqual(['Correct: Paris']);
  });

  it('preserves QTI rich content as Markdown for Track payload fields', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-RICH" title="DOM Error">
        <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
          <qti-correct-response>
            <qti-value>CHOICE_2</qti-value>
          </qti-correct-response>
        </qti-response-declaration>
        <qti-item-body>
          <qti-p>次のHTMLとJavaScriptを実行したところ、コンソールにエラーが表示されました。</qti-p>
          <qti-p>HTML:</qti-p>
          <qti-pre><qti-code>&lt;p id=&quot;result&quot;&gt;変更前&lt;/p&gt;
</qti-code></qti-pre>
          <qti-p>JavaScript:</qti-p>
          <qti-pre><qti-code>const result = document.querySelector(&quot;#output&quot;);
result.textContent = &quot;変更後&quot;;
</qti-code></qti-pre>
          <qti-p>表示されたエラー:</qti-p>
          <qti-pre><qti-code>Uncaught TypeError: Cannot set properties of null (setting &apos;textContent&apos;)
</qti-code></qti-pre>
          <qti-p><qti-strong>💡 本試験では</qti-strong>: HTMLのid名、JavaScriptで指定するセレクタ名、変数名が変わります。</qti-p>
          <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
            <qti-simple-choice identifier="CHOICE_1"><qti-code>textContent</qti-code> はJavaScriptでは使えないため</qti-simple-choice>
            <qti-simple-choice identifier="CHOICE_2"><qti-code>#output</qti-code> に一致するHTML要素が見つからず、<qti-code>result</qti-code> が <qti-code>null</qti-code> になっているため</qti-simple-choice>
          </qti-choice-interaction>
        </qti-item-body>
        <qti-modal-feedback identifier="EXPLANATION" outcome-identifier="FEEDBACK" show-hide="show">
          <qti-content-body>
            <qti-p>解答:</qti-p>
            <qti-pre><qti-code>#output に一致するHTML要素が見つからず、result が null になっているため
</qti-code></qti-pre>
            <qti-p><qti-code>document.querySelector(&quot;#output&quot;)</qti-code> は、<qti-code>id=&quot;output&quot;</qti-code> の要素を探します。</qti-p>
          </qti-content-body>
        </qti-modal-feedback>
      </qti-assessment-item>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.prompt).toBe(
      [
        '次のHTMLとJavaScriptを実行したところ、コンソールにエラーが表示されました。',
        '',
        'HTML:',
        '',
        '```',
        '<p id="result">変更前</p>',
        '```',
        '',
        'JavaScript:',
        '',
        '```',
        'const result = document.querySelector("#output");',
        'result.textContent = "変更後";',
        '```',
        '',
        '表示されたエラー:',
        '',
        '```',
        "Uncaught TypeError: Cannot set properties of null (setting 'textContent')",
        '```',
        '',
        '**💡 本試験では**: HTMLのid名、JavaScriptで指定するセレクタ名、変数名が変わります。',
      ].join('\n'),
    );
    expect(parsed.choices).toEqual([
      { identifier: 'CHOICE_1', text: '`textContent` はJavaScriptでは使えないため' },
      {
        identifier: 'CHOICE_2',
        text: '`#output` に一致するHTML要素が見つからず、`result` が `null` になっているため',
      },
    ]);
    expect(parsed.feedback).toEqual([
      [
        '解答:',
        '',
        '```',
        '#output に一致するHTML要素が見つからず、result が null になっているため',
        '```',
        '',
        '`document.querySelector("#output")` は、`id="output"` の要素を探します。',
      ].join('\n'),
    ]);
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
    expect(textEntry.blanks).toEqual([
      { responseIdentifier: 'RESPONSE', answer: 'oxygen', kind: 'exact' },
    ]);
    expect(extendedText.interactionType).toBe('extended-text');
  });

  it('preserves regex text-entry declarations from interpretation', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-REGEX" title="Regex Blank">
        <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="string" interpretation="regex">
          <qti-correct-response><qti-value>transform|all</qti-value></qti-correct-response>
        </qti-response-declaration>
        <qti-item-body>
          <qti-p>Match <qti-text-entry-interaction response-identifier="RESPONSE" expected-length="13" />.</qti-p>
        </qti-item-body>
      </qti-assessment-item>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.blanks).toEqual([
      { responseIdentifier: 'RESPONSE', answer: 'transform|all', kind: 'regex' },
    ]);
    expect(parsed.prompt).toBe('Match ${/transform|all/}.');
  });

  it('preserves text-entry placeholders inside code blocks', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-CODE-CLOZE" title="Code Cloze">
        <qti-response-declaration identifier="RESPONSE_1" cardinality="single" base-type="string">
          <qti-correct-response><qti-value>C</qti-value></qti-correct-response>
        </qti-response-declaration>
        <qti-response-declaration identifier="RESPONSE_2" cardinality="single" base-type="string">
          <qti-correct-response><qti-value>A</qti-value></qti-correct-response>
        </qti-response-declaration>
        <qti-response-declaration identifier="RESPONSE_3" cardinality="single" base-type="string">
          <qti-correct-response><qti-value>D</qti-value></qti-correct-response>
        </qti-response-declaration>
        <qti-item-body>
          <qti-p>次の語群から選び、空欄を埋めなさい。</qti-p>
          <qti-pre><qti-code>Create Widget は </qti-code><qti-text-entry-interaction response-identifier="RESPONSE_1"/><qti-code> である。
Add to Viewport は </qti-code><qti-text-entry-interaction response-identifier="RESPONSE_2"/><qti-code> である。
Event Graph は </qti-code><qti-text-entry-interaction response-identifier="RESPONSE_3"/><qti-code> である。
</qti-code></qti-pre>
        </qti-item-body>
      </qti-assessment-item>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.prompt).toBe(
      [
        '次の語群から選び、空欄を埋めなさい。',
        '',
        '```',
        'Create Widget は ${C} である。',
        'Add to Viewport は ${A} である。',
        'Event Graph は ${D} である。',
        '```',
      ].join('\n'),
    );
    expect(parsed.blanks).toEqual([
      { responseIdentifier: 'RESPONSE_1', answer: 'C', kind: 'exact' },
      { responseIdentifier: 'RESPONSE_2', answer: 'A', kind: 'exact' },
      { responseIdentifier: 'RESPONSE_3', answer: 'D', kind: 'exact' },
    ]);
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
