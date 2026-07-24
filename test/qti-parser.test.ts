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

  it('preserves QTI inline line breaks while normalizing ordinary XML whitespace', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-BR" title="Inline Line Breaks">
        <qti-response-declaration identifier="RESPONSE" cardinality="single" base-type="identifier">
          <qti-correct-response>
            <qti-value>CHOICE_1</qti-value>
          </qti-correct-response>
        </qti-response-declaration>
        <qti-item-body>
          <qti-p>本文1<qti-br/>本文2
            soft line</qti-p>
          <qti-choice-interaction response-identifier="RESPONSE" max-choices="1">
            <qti-simple-choice identifier="CHOICE_1">選択肢1<qti-br/>選択肢2</qti-simple-choice>
          </qti-choice-interaction>
        </qti-item-body>
        <qti-assessment-item:rubricBlock xmlns:qti-assessment-item="http://www.imsglobal.org/xsd/imsqti_v2p1" view="scorer"><qti-p>基準1<qti-br/>基準2</qti-p></qti-assessment-item:rubricBlock>
        <qti-modal-feedback identifier="EXPLANATION" outcome-identifier="FEEDBACK" show-hide="show">
          <qti-content-body>
            <qti-p>解説1<qti-br/>解説2</qti-p>
          </qti-content-body>
        </qti-modal-feedback>
      </qti-assessment-item>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.prompt).toBe('本文1<br>本文2 soft line');
    expect(parsed.choices).toEqual([{ identifier: 'CHOICE_1', text: '選択肢1<br>選択肢2' }]);
    expect(parsed.feedback).toEqual(['解説1<br>解説2']);
    expect(parsed.scorerRubric).toEqual(['基準1<br>基準2']);
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

  it('preserves QTI and HTML anchors as Markdown links', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-LINKS" title="Demo Links">
        <qti-item-body>
          <qti-p>前の文章 <qti-a href="https://example.com/demo/">完成見本を開く</qti-a> 後の文章</qti-p>
          <qti-p><a href="https://example.com/docs/">通常のリンク</a></qti-p>
          <qti-p><qti-a href="https://example.com/rich/">リンク内の<qti-strong>強調</qti-strong>と<qti-code>code</qti-code></qti-a></qti-p>
          <qti-p><qti-a>hrefなし</qti-a></qti-p>
          <qti-p><qti-a href="https://course-exam-demos.vercel.app/f21f43d1df7547c4/">完成見本を開く</qti-a></qti-p>
          <qti-extended-text-interaction response-identifier="RESPONSE" />
        </qti-item-body>
      </qti-assessment-item>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.prompt).toBe([
      '前の文章 [完成見本を開く](https://example.com/demo/) 後の文章',
      '',
      '[通常のリンク](https://example.com/docs/)',
      '',
      '[リンク内の**強調**と`code`](https://example.com/rich/)',
      '',
      'hrefなし',
      '',
      '[完成見本を開く](https://course-exam-demos.vercel.app/f21f43d1df7547c4/)',
    ].join('\n'));
  });

  it('preserves Markdown structure for headings, rich inline content, lists, rules, and tables', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-MARKDOWN" title="Markdown Structure">
        <qti-item-body>
          <qti-h3>小見出し</qti-h3>
          <qti-p><qti-strong>太字</qti-strong>、<qti-em>斜体</qti-em>、<qti-del>取り消し線</qti-del>、<qti-code>コード</qti-code>、<qti-a href="https://example.com">リンク</qti-a></qti-p>
          <qti-blockquote><qti-p>引用</qti-p></qti-blockquote>
          <qti-ul><qti-li><qti-p>箇条書き</qti-p></qti-li></qti-ul>
          <qti-ol><qti-li><qti-p>番号付きリスト</qti-p></qti-li></qti-ol>
          <qti-hr />
          <qti-table>
            <qti-thead>
              <qti-tr>
                <qti-th style="text-align: left;">左</qti-th>
                <qti-th style="text-align: center;">中央</qti-th>
                <qti-th style="text-align: right;">右</qti-th>
              </qti-tr>
            </qti-thead>
            <qti-tbody>
              <qti-tr><qti-td>A</qti-td><qti-td>B</qti-td><qti-td>C</qti-td></qti-tr>
              <qti-tr><qti-td><qti-code>code</qti-code></qti-td><qti-td><qti-strong>太字</qti-strong></qti-td><qti-td><qti-a href="https://example.com">リンク</qti-a></qti-td></qti-tr>
            </qti-tbody>
          </qti-table>
          <qti-extended-text-interaction response-identifier="RESPONSE" />
        </qti-item-body>
      </qti-assessment-item>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.prompt).toBe([
      '### 小見出し',
      '',
      '**太字**、*斜体*、~~取り消し線~~、`コード`、[リンク](https://example.com)',
      '',
      '> 引用',
      '',
      '- 箇条書き',
      '',
      '1. 番号付きリスト',
      '',
      '---',
      '',
      '| 左 | 中央 | 右 |',
      '| :--- | :---: | ---: |',
      '| A | B | C |',
      '| `code` | **太字** | [リンク](https://example.com) |',
    ].join('\n'));
  });

  it('preserves all Markdown heading levels', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-HEADINGS" title="Headings">
        <qti-item-body>
          <qti-h1>見出し1</qti-h1>
          <qti-h2>見出し2</qti-h2>
          <qti-h3>見出し3</qti-h3>
          <qti-h4>見出し4</qti-h4>
          <qti-h5>見出し5</qti-h5>
          <qti-h6>見出し6</qti-h6>
          <qti-extended-text-interaction response-identifier="RESPONSE" />
        </qti-item-body>
      </qti-assessment-item>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.prompt).toBe([
      '# 見出し1',
      '',
      '## 見出し2',
      '',
      '### 見出し3',
      '',
      '#### 見出し4',
      '',
      '##### 見出し5',
      '',
      '###### 見出し6',
    ].join('\n'));
  });

  it('escapes table delimiters, preserves cell line breaks, empty cells, and default alignment', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-TABLE-SAFETY" title="Table Safety">
        <qti-item-body>
          <qti-table>
            <qti-thead>
              <qti-tr><qti-th>区切り</qti-th><qti-th>改行</qti-th><qti-th>空</qti-th><qti-th>装飾</qti-th></qti-tr>
            </qti-thead>
            <qti-tbody>
              <qti-tr><qti-td>A | B</qti-td><qti-td>1行目<qti-br />2行目</qti-td><qti-td></qti-td><qti-td><qti-em>斜体</qti-em></qti-td></qti-tr>
            </qti-tbody>
          </qti-table>
          <qti-extended-text-interaction response-identifier="RESPONSE" />
        </qti-item-body>
      </qti-assessment-item>
    `;

    const parsed = parseAssessmentItemXml(itemXml);

    expect(parsed.prompt).toBe([
      '| 区切り | 改行 | 空 | 装飾 |',
      '| --- | --- | --- | --- |',
      '| A \\| B | 1行目<br>2行目 |  | *斜体* |',
    ].join('\n'));
  });

  it('rejects table spans that Markdown cannot safely preserve', () => {
    const itemXml = `
      <qti-assessment-item identifier="ITEM-TABLE-SPAN" title="Table Span">
        <qti-item-body>
          <qti-table>
            <qti-thead><qti-tr><qti-th colspan="2">結合見出し</qti-th></qti-tr></qti-thead>
            <qti-tbody><qti-tr><qti-td>A</qti-td><qti-td>B</qti-td></qti-tr></qti-tbody>
          </qti-table>
          <qti-extended-text-interaction response-identifier="RESPONSE" />
        </qti-item-body>
      </qti-assessment-item>
    `;

    expect(() => parseAssessmentItemXml(itemXml)).toThrow(
      'Cannot safely convert QTI table cell with colspan="2" to Markdown.',
    );
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
