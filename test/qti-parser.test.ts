import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import {
  parseAssessmentItemXml,
  parseAssessmentXml,
  parseQtiPackageFromXml,
} from '../src/parser/qti-parser.js';
import { parseXml } from '../src/parser/xml-parser.js';
import { toTrackPayloads } from '../src/generator/track-generator.js';

const RETIRED_PRESENTATION_ALIASES = [
  'qti-p',
  'qti-h1',
  'qti-h2',
  'qti-h3',
  'qti-h4',
  'qti-h5',
  'qti-h6',
  'qti-div',
  'qti-em',
  'qti-strong',
  'qti-del',
  'qti-a',
  'qti-blockquote',
  'qti-ul',
  'qti-ol',
  'qti-li',
  'qti-pre',
  'qti-code',
  'qti-table',
  'qti-thead',
  'qti-tbody',
  'qti-tfoot',
  'qti-tr',
  'qti-th',
  'qti-td',
  'qti-img',
  'qti-br',
  'qti-hr',
] as const;

const VOID_RETIRED_PRESENTATION_ALIASES = new Set(['qti-img', 'qti-br', 'qti-hr']);

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

  it.each(RETIRED_PRESENTATION_ALIASES)('rejects retired presentation alias %s', (alias) => {
    const presentation = VOID_RETIRED_PRESENTATION_ALIASES.has(alias)
      ? `<${alias} />`
      : `<${alias}>retired</${alias}>`;

    expect(() => parseAssessmentItemXml(`
      <qti-assessment-item identifier="RETIRED-${alias}" title="Retired alias">
        <qti-item-body>${presentation}<qti-extended-text-interaction responseIdentifier="RESPONSE" /></qti-item-body>
      </qti-assessment-item>
    `)).toThrow(`Retired QTI presentation element is not supported: ${alias}`);
  });

  it('rejects nested retired qti-pre and qti-code presentation aliases', () => {
    expect(() => parseAssessmentItemXml(`
      <qti-assessment-item identifier="RETIRED-NESTED" title="Retired aliases">
        <qti-item-body><qti-pre><qti-code>body</qti-code></qti-pre><qti-extended-text-interaction responseIdentifier="RESPONSE" /></qti-item-body>
      </qti-assessment-item>
    `)).toThrow('Retired QTI presentation element is not supported: qti-pre');
  });

  it('rejects the retired qti-img presentation alias', () => {
    expect(() => parseAssessmentItemXml(`
      <qti-assessment-item identifier="RETIRED-IMG" title="Retired alias">
        <qti-item-body><qti-img /><qti-extended-text-interaction responseIdentifier="RESPONSE" /></qti-item-body>
      </qti-assessment-item>
    `)).toThrow('Retired QTI presentation element is not supported: qti-img');
  });

  it('accepts canonical bare HTML presentation elements', () => {
    const parsed = parseAssessmentItemXml(`
      <qti-assessment-item identifier="CANONICAL-HTML" title="Canonical HTML">
        <qti-item-body><p>Paragraph</p><pre><code>code</code></pre><img src="image.png" alt="Image" /><br /><hr /><qti-extended-text-interaction responseIdentifier="RESPONSE" /></qti-item-body>
      </qti-assessment-item>
    `);

    expect(parsed.prompt).toBe('<p>Paragraph</p><pre><code>code</code></pre><img src="image.png" alt="Image" /><br /><hr />');
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
      '<pre><code>  foo <span style="color:red" class="token">A</span> ${answer} bar<br /></code></pre>',
    );
    expect(parsed.blanks).toEqual([
      { responseIdentifier: 'RESPONSE', answer: 'answer', kind: 'exact' },
    ]);
  });

  it.each([
    ['hexadecimal references', '&#x3C;html&#x3E;\n&#x3C;body&#x3E;\nfoo &amp; bar\n&#x3C;/body&#x3E;\n&#x3C;/html&#x3E;'],
    ['decimal references', '&#60;html&#62;\n&#60;body&#62;\nfoo &amp; bar\n&#60;/body&#62;\n&#60;/html&#62;'],
    ['named references', '&lt;html&gt;\n&lt;body&gt;\nfoo &amp; bar\n&lt;/body&gt;\n&lt;/html&gt;'],
  ])('decodes %s once before escaping semantic code text for Track HTML', (_label, encodedSource) => {
    const content = toTrackContent('ENTITY', `<qti-assessment-item identifier="ENTITY" title="Entities"><qti-item-body><pre><code>${encodedSource}</code></pre><qti-extended-text-interaction response-identifier="RESPONSE" /></qti-item-body></qti-assessment-item>`);
    const expectedSource = '<html>\n<body>\nfoo & bar\n</body>\n</html>';

    expect(content).toContain('<pre><code>&lt;html&gt;<br />&lt;body&gt;<br />foo &amp; bar<br />&lt;/body&gt;<br />&lt;/html&gt;</code></pre>');
    expect(content).not.toContain('&amp;#x3C;');
    expect(content).not.toContain('&amp;#60;');
    expect(content).not.toContain('&amp;lt;');

    const document = parseTrackHtml(content);
    expect(renderPreformattedText(document.getElementsByTagName('code').item(0))).toBe(expectedSource);
  });

  it('preserves escaped HTML around the official q18-style span, its style, quoted attributes, and Unicode', () => {
    const style = 'display:inline-block;min-width:4em;border:1px solid #000;text-align:center;background:transparent;';
    const content = toTrackContent('Q18', `<qti-assessment-item identifier="Q18" title="Q18"><qti-item-body><pre><code>&#x3C;div id=&quot;content&quot;&#x3E;\n    document.getElementById(&quot;content&quot;). <span style="${style}" title="&quot;quoted&quot;" data-label="日本語">A</span> = &quot;2em&quot;;\n&#x3C;/div&#x3E;</code></pre><qti-extended-text-interaction responseIdentifier="RESPONSE" /></qti-item-body></qti-assessment-item>`);
    const document = parseTrackHtml(content);
    const code = document.getElementsByTagName('code').item(0);
    const span = document.getElementsByTagName('span').item(0);

    expect(span?.getAttribute('style')).toBe(style);
    expect(span?.getAttribute('title')).toBe('"quoted"');
    expect(span?.getAttribute('data-label')).toBe('日本語');
    expect(span?.textContent).toBe('A');
    expect(renderPreformattedText(code)).toBe('<div id="content">\n    document.getElementById("content"). A = "2em";\n</div>');
    expect(content).not.toContain('&#x3C;');
    expect(content).not.toContain('&#60;');
    expect(content).not.toContain('&amp;lt;');
  });

  it('converts only preformatted text-node line endings to Track line breaks', () => {
    const content = toTrackContent(
      'PRE-COMPATIBILITY',
      '<qti-assessment-item identifier="PRE-COMPATIBILITY" title="Pre compatibility"><qti-item-body><p id="ordinary" data-kind="text">ordinary1\nordinary2</p><pre id="snippet" class="example"><code class="language-js" data-language="js">line1\n    indented\nline3</code></pre><pre><code>before\n    <span style="color:red" class="token">A</span>\nafter</code></pre><qti-extended-text-interaction responseIdentifier="RESPONSE" /></qti-item-body></qti-assessment-item>',
    );

    expect(content).toBe(
      '<p id="ordinary" data-kind="text">ordinary1\nordinary2</p><pre id="snippet" class="example"><code class="language-js" data-language="js">line1<br />    indented<br />line3</code></pre><pre><code>before<br />    <span style="color:red" class="token">A</span><br />after</code></pre>',
    );

    const document = parseTrackHtml(content);
    expect(renderPreformattedText(document.getElementsByTagName('code').item(0))).toBe(
      'line1\n    indented\nline3',
    );
    expect(renderPreformattedText(document.getElementsByTagName('code').item(1))).toBe(
      'before\n    A\nafter',
    );
    expect(document.getElementsByTagName('p').item(0)?.textContent).toBe('ordinary1\nordinary2');
    expect(document.getElementsByTagName('pre').item(0)?.getAttribute('id')).toBe('snippet');
    expect(document.getElementsByTagName('pre').item(0)?.getAttribute('class')).toBe('example');
    expect(document.getElementsByTagName('code').item(0)?.getAttribute('data-language')).toBe('js');
    expect(document.getElementsByTagName('span').item(0)?.getAttribute('style')).toBe('color:red');
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

function toTrackContent(identifier: string, itemXml: string): string {
  const parsed = parseQtiPackageFromXml({
    assessmentXml: `<assessmentTest identifier="ENTITY-TEST"><testPart><assessmentSection><assessmentItemRef identifier="${identifier}" href="entity.xml" /></assessmentSection></testPart></assessmentTest>`,
    itemXmlByIdentifier: {
      [identifier]: itemXml,
    },
  });

  return toTrackPayloads(parsed).questions[0]?.content ?? '';
}

function parseTrackHtml(content: string) {
  return new DOMParser({
    onError(_level, message) {
      throw new Error(`Invalid Track HTML fragment in test: ${message}`);
    },
  }).parseFromString(`<root>${content}</root>`, 'application/xml');
}

interface DomLikeNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  firstChild: DomLikeNode | null;
  nextSibling: DomLikeNode | null;
}

function renderPreformattedText(node: unknown): string {
  if (!node || typeof node !== 'object') {
    return '';
  }

  const current = node as DomLikeNode;
  if (current.nodeType === 3) {
    return current.nodeValue ?? '';
  }
  if (current.nodeType === 1 && current.nodeName === 'br') {
    return '\n';
  }

  let result = '';
  for (let child = current.firstChild; child !== null; child = child.nextSibling) {
    result += renderPreformattedText(child);
  }
  return result;
}
