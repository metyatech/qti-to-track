import { XMLParser } from 'fast-xml-parser';
import {
  type ParsedBlank,
  type ParsedAssessment,
  type ParsedQtiChoice,
  type ParsedQtiItem,
  type ParsedQtiPackage,
  type TrackQuestionType,
} from '../types.js';
import { asArray, getTextContent, parseXml, type ParsedXmlNode } from './xml-parser.js';

type XmlRecord = Record<string, unknown>;

interface ParsedResponseDeclaration {
  identifier: string;
  values: string[];
  kind: 'exact' | 'regex';
}

interface OrderedElement {
  name: string;
  children: XmlRecord[];
  attrs: XmlRecord;
}

interface MarkdownRenderContext {
  responsesByDeclaration: Record<string, ParsedResponseDeclaration>;
  responseIdentifiers: string[];
}

interface MarkdownInlineRenderOptions {
  lineBreak?: string;
}

type MarkdownTableAlignment = 'left' | 'center' | 'right';

interface MarkdownTableCell {
  content: string;
  alignment?: MarkdownTableAlignment;
}

interface MarkdownTableRow {
  cells: MarkdownTableCell[];
  header: boolean;
}

const preserveOrderXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  preserveOrder: true,
  processEntities: true,
  transformTagName: (tagName) => {
    const stripped = tagName.replace(/^qti-/, '');
    return stripped.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  },
});

const INTERACTION_KEYS = [
  'choiceInteraction',
  'textEntryInteraction',
  'extendedTextInteraction',
] as const;

const ORDERED_ATTRS_KEY = ':@';
const ORDERED_TEXT_KEY = '#text';
const BLOCK_ELEMENT_NAMES = new Set([
  'blockquote',
  'contentBody',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'rubricBlock',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

function asRecord(value: unknown, errorMessage: string): XmlRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return value as XmlRecord;
}

function readStringAttribute(node: XmlRecord, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

function readAnyStringAttribute(node: XmlRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readStringAttribute(node, key);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function readResponseIdentifierAttribute(node: XmlRecord): string | undefined {
  return readAnyStringAttribute(node, ['@_responseIdentifier', '@_response-identifier']);
}

function hasViewAttribute(node: XmlRecord, view: string): boolean {
  const rawView = readStringAttribute(node, '@_view');
  return rawView?.toLowerCase().split(/\s+/u).includes(view) ?? false;
}

function asRecords(value: unknown): XmlRecord[] {
  return asArray(value).filter(
    (node): node is XmlRecord => !!node && typeof node === 'object' && !Array.isArray(node),
  );
}

function getOrderedElement(node: unknown): OrderedElement | undefined {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return undefined;
  }

  const record = node as XmlRecord;
  const name = Object.keys(record).find(
    (key) => key !== ORDERED_ATTRS_KEY && key !== ORDERED_TEXT_KEY,
  );
  if (name === undefined) {
    return undefined;
  }

  const children = asRecords(record[name]);
  const attrs =
    record[ORDERED_ATTRS_KEY] && typeof record[ORDERED_ATTRS_KEY] === 'object' && !Array.isArray(record[ORDERED_ATTRS_KEY])
      ? (record[ORDERED_ATTRS_KEY] as XmlRecord)
      : {};

  return { name, children, attrs };
}

function getOrderedText(node: unknown): string | undefined {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return undefined;
  }

  const value = (node as XmlRecord)[ORDERED_TEXT_KEY];
  return typeof value === 'string' ? value : undefined;
}

function parseOrderedAssessmentItemXml(xml: string): OrderedElement | undefined {
  const parsed = preserveOrderXmlParser.parse(xml);
  if (!Array.isArray(parsed)) {
    return undefined;
  }

  for (const node of parsed) {
    const element = getOrderedElement(node);
    if (element?.name === 'assessmentItem') {
      return element;
    }
  }

  return undefined;
}

function findOrderedChildElement(
  nodes: readonly XmlRecord[],
  name: string,
): OrderedElement | undefined {
  for (const node of nodes) {
    const element = getOrderedElement(node);
    if (element?.name === name) {
      return element;
    }
  }

  return undefined;
}

function findOrderedChildElements(
  nodes: readonly XmlRecord[],
  name: string,
): OrderedElement[] {
  return nodes
    .map((node) => getOrderedElement(node))
    .filter((element): element is OrderedElement => element?.name === name);
}

function findOrderedDescendantElements(
  nodes: readonly XmlRecord[],
  name: string,
): OrderedElement[] {
  const matches: OrderedElement[] = [];

  for (const node of nodes) {
    const element = getOrderedElement(node);
    if (element === undefined) {
      continue;
    }

    if (element.name === name) {
      matches.push(element);
    }

    matches.push(...findOrderedDescendantElements(element.children, name));
  }

  return matches;
}

function getOrderedItemBody(xml: string): OrderedElement | undefined {
  const item = parseOrderedAssessmentItemXml(xml);
  return item === undefined ? undefined : findOrderedChildElement(item.children, 'itemBody');
}

function collectAssessmentItemRefs(node: unknown): XmlRecord[] {
  if (!node || typeof node !== 'object') {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(collectAssessmentItemRefs);
  }

  const record = node as XmlRecord;
  const refs: XmlRecord[] = [];

  for (const [key, value] of Object.entries(record)) {
    if (key === 'assessmentItemRef') {
      for (const ref of asArray(value)) {
        if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
          refs.push(ref as XmlRecord);
        }
      }
      continue;
    }

    refs.push(...collectAssessmentItemRefs(value));
  }

  return refs;
}

function findInteraction(itemBody: XmlRecord): {
  key: (typeof INTERACTION_KEYS)[number];
  interaction?: XmlRecord;
} {
  for (const key of ['choiceInteraction', 'extendedTextInteraction'] as const) {
    const value = itemBody[key];
    if (value) {
      const interaction = asRecord(
        Array.isArray(value) ? value[0] : value,
        `Invalid ${key}: expected an object node.`,
      );
      return { key, interaction };
    }
  }

  // textEntryInteraction can be deeply nested inside p, div, etc.
  const hasTextEntry = JSON.stringify(itemBody).includes('"textEntryInteraction"');
  if (hasTextEntry) {
    return { key: 'textEntryInteraction' };
  }

  throw new Error('Unsupported or missing interaction in assessment item body.');
}

function inferInteractionType(
  interactionKey: (typeof INTERACTION_KEYS)[number],
): TrackQuestionType {
  if (interactionKey === 'choiceInteraction') {
    return 'choice';
  }

  if (interactionKey === 'textEntryInteraction') {
    return 'text-entry';
  }

  return 'extended-text';
}

function extractPrompt(itemBody: XmlRecord): string {
  const chunks: string[] = [];

  for (const [key, value] of Object.entries(itemBody)) {
    if (INTERACTION_KEYS.includes(key as (typeof INTERACTION_KEYS)[number])) {
      break;
    }

    if (key.startsWith('@_')) {
      continue;
    }

    const text = getTextContent(value);
    if (text) {
      chunks.push(text);
    }
  }

  return chunks.join('\n').trim();
}

function extractChoices(interaction: XmlRecord | undefined, interactionType: TrackQuestionType): ParsedQtiChoice[] {
  if (interactionType !== 'choice' || !interaction) {
    return [];
  }

  return asArray(interaction.simpleChoice)
    .map((choice) => asRecord(choice, 'Invalid simpleChoice node: expected object.'))
    .map((choice): ParsedQtiChoice => ({
      identifier: readStringAttribute(choice, '@_identifier') ?? '',
      text: getTextContent(choice),
    }))
    .filter((choice) => choice.identifier.length > 0);
}

function extractCorrectResponses(itemNode: XmlRecord): string[] {
  return extractResponseDeclarations(itemNode).flatMap((declaration) => declaration.values);
}

function extractResponseDeclarations(itemNode: XmlRecord): ParsedResponseDeclaration[] {
  const declarations = asArray(itemNode.responseDeclaration)
    .filter((value): value is XmlRecord => !!value && typeof value === 'object' && !Array.isArray(value));

  const parsedDeclarations: ParsedResponseDeclaration[] = [];

  for (const declaration of declarations) {
    const declarationId = readStringAttribute(declaration, '@_identifier');
    if (!declarationId) {
      continue;
    }

    const correctResponse = declaration.correctResponse;
    if (!correctResponse || typeof correctResponse !== 'object' || Array.isArray(correctResponse)) {
      continue;
    }

    const valueNode = (correctResponse as XmlRecord).value;
    const values: string[] = [];

    for (const value of asArray(valueNode)) {
      const text = getTextContent(value).trim();
      if (text) {
        values.push(text);
      }
    }

    if (values.length > 0) {
      const interpretationKind = readStringAttribute(declaration, '@_interpretation') === 'regex' ? 'regex' : 'exact';
      const kind =
        interpretationKind === 'regex' ||
        (values.length === 1 && values[0]!.length >= 2 && values[0]!.startsWith('/') && values[0]!.endsWith('/'))
          ? 'regex'
          : 'exact';

      parsedDeclarations.push({
        identifier: declarationId,
        values: kind === 'regex' ? values.map((value) => value.replace(/^\/(.+)\/$/u, '$1')) : values,
        kind,
      });
    }
  }

  return parsedDeclarations;
}

function extractCorrectResponsesByDeclaration(itemNode: XmlRecord): Record<string, ParsedResponseDeclaration> {
  const map: Record<string, ParsedResponseDeclaration> = {};

  for (const declaration of extractResponseDeclarations(itemNode)) {
    map[declaration.identifier] = declaration;
  }

  return map;
}

function formatBlankPlaceholder(blank: ParsedBlank | undefined): string {
  if (!blank || blank.answer.length === 0) {
    return '${}';
  }

  return blank.kind === 'regex' ? `\${/${blank.answer}/}` : `\${${blank.answer}}`;
}

function createMarkdownRenderContext(
  responsesByDeclaration: Record<string, ParsedResponseDeclaration>,
): MarkdownRenderContext {
  return {
    responsesByDeclaration,
    responseIdentifiers: [],
  };
}

function renderOrderedMarkdownBlocks(
  nodes: readonly XmlRecord[],
  context: MarkdownRenderContext,
): string {
  const blocks: string[] = [];

  for (const node of nodes) {
    const rendered = renderOrderedMarkdownBlock(node, context);
    if (rendered.length > 0) {
      blocks.push(rendered);
    }
  }

  return blocks.join('\n\n').trim();
}

function renderOrderedMarkdownBlock(
  node: XmlRecord,
  context: MarkdownRenderContext,
): string {
  const text = getOrderedText(node);
  if (text !== undefined) {
    return text.trim().length > 0 ? normalizeInlineMarkdown(text) : '';
  }

  const element = getOrderedElement(node);
  if (element === undefined) {
    return '';
  }

  switch (element.name) {
    case 'blockquote': {
      const content = renderOrderedMarkdownBlocks(element.children, context);
      return content
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
        .trim();
    }
    case 'contentBody':
    case 'div':
    case 'rubricBlock':
      return renderOrderedMarkdownBlocks(element.children, context);
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(element.name.slice(1));
      return `${'#'.repeat(level)} ${renderOrderedMarkdownInline(element.children, context)}`;
    }
    case 'hr':
      return '---';
    case 'ol':
      return renderOrderedMarkdownList(element.children, context, true);
    case 'p':
      return renderOrderedMarkdownInline(element.children, context);
    case 'pre':
      return renderCodeFence(renderOrderedPreText(element.children, context));
    case 'table':
      return renderOrderedMarkdownTable(element, context);
    case 'ul':
      return renderOrderedMarkdownList(element.children, context, false);
    default:
      if (hasBlockElement(element.children)) {
        return renderOrderedMarkdownBlocks(element.children, context);
      }
      return renderOrderedMarkdownInline(element.children, context);
  }
}

function renderOrderedMarkdownTable(
  table: OrderedElement,
  context: MarkdownRenderContext,
): string {
  const rows: MarkdownTableRow[] = [];

  for (const node of table.children) {
    const element = getOrderedElement(node);
    if (element === undefined) {
      continue;
    }

    if (element.name === 'thead' || element.name === 'tbody' || element.name === 'tfoot') {
      const sectionIsHeader = element.name === 'thead';
      for (const row of findOrderedChildElements(element.children, 'tr')) {
        rows.push(renderOrderedMarkdownTableRow(row, context, sectionIsHeader));
      }
      continue;
    }

    if (element.name === 'tr') {
      rows.push(renderOrderedMarkdownTableRow(element, context, false));
    }
  }

  const nonEmptyRows = rows.filter((row) => row.cells.length > 0);
  const columnCount = Math.max(0, ...nonEmptyRows.map((row) => row.cells.length));
  if (columnCount === 0) {
    return '';
  }

  const headerIndex = nonEmptyRows.findIndex((row) => row.header);
  const headerRow = headerIndex >= 0
    ? nonEmptyRows[headerIndex]!
    : { cells: [], header: true };
  const bodyRows = nonEmptyRows.filter((_, index) => index !== headerIndex);
  const paddedHeaderCells = padMarkdownTableCells(headerRow.cells, columnCount);
  const paddedBodyRows = bodyRows.map((row) => padMarkdownTableCells(row.cells, columnCount));
  const alignments = Array.from({ length: columnCount }, (_, columnIndex) =>
    resolveMarkdownTableColumnAlignment(
      [paddedHeaderCells, ...paddedBodyRows],
      columnIndex,
    ),
  );

  return [
    formatMarkdownTableRow(paddedHeaderCells.map((cell) => cell.content)),
    formatMarkdownTableRow(alignments.map(formatMarkdownTableAlignment)),
    ...paddedBodyRows.map((cells) => formatMarkdownTableRow(cells.map((cell) => cell.content))),
  ].join('\n');
}

function renderOrderedMarkdownTableRow(
  row: OrderedElement,
  context: MarkdownRenderContext,
  sectionIsHeader: boolean,
): MarkdownTableRow {
  const cellElements = row.children
    .map((node) => getOrderedElement(node))
    .filter((element): element is OrderedElement => element?.name === 'th' || element?.name === 'td');

  return {
    cells: cellElements.map((cell) => renderOrderedMarkdownTableCell(cell, context)),
    header: sectionIsHeader || cellElements.some((cell) => cell.name === 'th'),
  };
}

function renderOrderedMarkdownTableCell(
  cell: OrderedElement,
  context: MarkdownRenderContext,
): MarkdownTableCell {
  assertSupportedMarkdownTableCellSpan(cell);

  return {
    content: normalizeMarkdownTableCell(renderOrderedMarkdownTableCellContent(cell.children, context)),
    alignment: readMarkdownTableAlignment(cell.attrs),
  };
}

function assertSupportedMarkdownTableCellSpan(cell: OrderedElement): void {
  for (const attribute of ['@_colspan', '@_rowspan']) {
    const value = readStringAttribute(cell.attrs, attribute);
    if (value !== undefined && value !== '1') {
      throw new Error(
        `Cannot safely convert QTI table cell with ${attribute.slice(2)}="${value}" to Markdown.`,
      );
    }
  }
}

function renderOrderedMarkdownTableCellContent(
  nodes: readonly XmlRecord[],
  context: MarkdownRenderContext,
): string {
  const chunks: string[] = [];

  for (const node of nodes) {
    const text = getOrderedText(node);
    if (text !== undefined) {
      chunks.push(text);
      continue;
    }

    const element = getOrderedElement(node);
    if (element === undefined) {
      continue;
    }

    if (element.name === 'p') {
      chunks.push('<br>', renderOrderedMarkdownInline(element.children, context, { lineBreak: '<br>' }), '<br>');
      continue;
    }

    if (element.name === 'contentBody' || element.name === 'div') {
      chunks.push('<br>', renderOrderedMarkdownTableCellContent(element.children, context), '<br>');
      continue;
    }

    if (element.name === 'pre') {
      chunks.push('<br>', formatInlineCode(renderOrderedPreText(element.children, context)), '<br>');
      continue;
    }

    if (BLOCK_ELEMENT_NAMES.has(element.name)) {
      chunks.push(
        '<br>',
        renderOrderedMarkdownBlock(node, context).replace(/\r?\n+/gu, '<br>'),
        '<br>',
      );
      continue;
    }

    chunks.push(renderOrderedMarkdownInlineNode(node, context, { lineBreak: '<br>' }));
  }

  return chunks.join('');
}

function readMarkdownTableAlignment(attrs: XmlRecord): MarkdownTableAlignment | undefined {
  const style = readStringAttribute(attrs, '@_style');
  const match = style?.match(/(?:^|;)\s*text-align\s*:\s*(left|center|right)\b/iu);
  return match?.[1]?.toLowerCase() as MarkdownTableAlignment | undefined;
}

function normalizeMarkdownTableCell(value: string): string {
  return value
    .replace(/\s+/gu, ' ')
    .replace(/\s*<br>\s*/gu, '<br>')
    .replace(/(?:<br>){2,}/gu, '<br>')
    .replace(/^(?:<br>)+|(?:<br>)+$/gu, '')
    .trim()
    .replace(/(?<!\\)\|/gu, '\\|');
}

function padMarkdownTableCells(
  cells: readonly MarkdownTableCell[],
  columnCount: number,
): MarkdownTableCell[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? { content: '' });
}

function resolveMarkdownTableColumnAlignment(
  rows: readonly MarkdownTableCell[][],
  columnIndex: number,
): MarkdownTableAlignment | undefined {
  const alignments = [
    ...new Set(
      rows
        .map((cells) => cells[columnIndex]?.alignment)
        .filter((alignment): alignment is MarkdownTableAlignment => alignment !== undefined),
    ),
  ];

  if (alignments.length > 1) {
    throw new Error(
      `Cannot safely convert conflicting QTI table alignments in column ${String(columnIndex + 1)} to Markdown.`,
    );
  }

  return alignments[0];
}

function formatMarkdownTableAlignment(
  alignment: MarkdownTableAlignment | undefined,
): string {
  switch (alignment) {
    case 'left':
      return ':---';
    case 'center':
      return ':---:';
    case 'right':
      return '---:';
    default:
      return '---';
  }
}

function formatMarkdownTableRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function renderOrderedMarkdownList(
  nodes: readonly XmlRecord[],
  context: MarkdownRenderContext,
  ordered: boolean,
): string {
  const items = nodes
    .map((node) => getOrderedElement(node))
    .filter((element): element is OrderedElement => element?.name === 'li');

  return items
    .map((item, index) => {
      const prefix = ordered ? `${index + 1}. ` : '- ';
      const content = renderOrderedMarkdownBlocks(item.children, context) || renderOrderedMarkdownInline(item.children, context);
      const lines = content.split('\n');
      const [firstLine = '', ...restLines] = lines;
      return [
        `${prefix}${firstLine}`,
        ...restLines.map((line) => `${' '.repeat(prefix.length)}${line}`),
      ].join('\n');
    })
    .join('\n');
}

function renderOrderedMarkdownInline(
  nodes: readonly XmlRecord[],
  context: MarkdownRenderContext,
  options: MarkdownInlineRenderOptions = {},
): string {
  return normalizeInlineMarkdown(
    nodes.map((node) => renderOrderedMarkdownInlineNode(node, context, options)).join(''),
  );
}

function renderOrderedMarkdownInlineNode(
  node: XmlRecord,
  context: MarkdownRenderContext,
  options: MarkdownInlineRenderOptions = {},
): string {
  const text = getOrderedText(node);
  if (text !== undefined) {
    return text;
  }

  const element = getOrderedElement(node);
  if (element === undefined) {
    return '';
  }

  switch (element.name) {
    case 'a': {
      const label = renderOrderedMarkdownInline(element.children, context, options);
      const href = readStringAttribute(element.attrs, '@_href');
      return href === undefined || href.length === 0 ? label : `[${label}](${href})`;
    }
    case 'br':
      return options.lineBreak ?? '\n';
    case 'code':
      return formatInlineCode(rawOrderedText(element.children));
    case 'del':
      return `~~${renderOrderedMarkdownInline(element.children, context, options)}~~`;
    case 'em':
    case 'i':
      return `*${renderOrderedMarkdownInline(element.children, context, options)}*`;
    case 'img': {
      const src = readStringAttribute(element.attrs, '@_src') ?? '';
      const alt = readStringAttribute(element.attrs, '@_alt') ?? '';
      return src.length > 0 ? `![${alt}](${src})` : '';
    }
    case 'strong':
    case 'b':
      return `**${renderOrderedMarkdownInline(element.children, context, options)}**`;
    case 'textEntryInteraction':
      return renderTextEntryPlaceholder(element, context);
    default:
      return renderOrderedMarkdownInline(element.children, context, options);
  }
}

function renderTextEntryPlaceholder(
  element: OrderedElement,
  context: MarkdownRenderContext,
): string {
  const responseIdentifier = readResponseIdentifierAttribute(element.attrs);
  const responseDeclaration =
    responseIdentifier === undefined
      ? undefined
      : context.responsesByDeclaration[responseIdentifier];

  if (responseIdentifier !== undefined) {
    context.responseIdentifiers.push(responseIdentifier);
  }

  return formatBlankPlaceholder(
    responseIdentifier === undefined
      ? undefined
      : {
          responseIdentifier,
          answer: responseDeclaration?.values[0] ?? '',
          kind: responseDeclaration?.kind ?? 'exact',
        },
  );
}

function renderCodeFence(rawCode: string): string {
  const code = rawCode.replace(/^\n+/u, '').replace(/\n+$/u, '');
  return `\`\`\`\n${code}\n\`\`\``;
}

function formatInlineCode(rawCode: string): string {
  const code = normalizeInlineMarkdown(rawCode);
  if (!code.includes('`')) {
    return `\`${code}\``;
  }

  const longestRun = Math.max(
    ...Array.from(code.matchAll(/`+/gu), (match) => match[0].length),
  );
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${code} ${fence}`;
}

function rawOrderedText(nodes: readonly XmlRecord[]): string {
  const chunks: string[] = [];

  for (const node of nodes) {
    const text = getOrderedText(node);
    if (text !== undefined) {
      chunks.push(text);
      continue;
    }

    const element = getOrderedElement(node);
    if (element !== undefined) {
      chunks.push(rawOrderedText(element.children));
    }
  }

  return chunks.join('');
}

function renderOrderedPreText(
  nodes: readonly XmlRecord[],
  context: MarkdownRenderContext,
): string {
  const chunks: string[] = [];

  for (const node of nodes) {
    const text = getOrderedText(node);
    if (text !== undefined) {
      chunks.push(text);
      continue;
    }

    const element = getOrderedElement(node);
    if (element === undefined) {
      continue;
    }

    chunks.push(
      element.name === 'textEntryInteraction'
        ? renderTextEntryPlaceholder(element, context)
        : renderOrderedPreText(element.children, context),
    );
  }

  return chunks.join('');
}

function hasBlockElement(nodes: readonly XmlRecord[]): boolean {
  return nodes.some((node) => {
    const element = getOrderedElement(node);
    return element !== undefined && BLOCK_ELEMENT_NAMES.has(element.name);
  });
}

function normalizeInlineMarkdown(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function extractPromptFromXml(
  xml: string,
  responsesByDeclaration: Record<string, ParsedResponseDeclaration>,
): { prompt: string; responseIdentifiers: string[] } | undefined {
  const itemBody = getOrderedItemBody(xml);
  if (itemBody === undefined) {
    return undefined;
  }

  const context = createMarkdownRenderContext(responsesByDeclaration);
  const promptNodes: XmlRecord[] = [];

  for (const node of itemBody.children) {
    const element = getOrderedElement(node);
    if (
      element !== undefined &&
      (element.name === 'choiceInteraction' ||
        element.name === 'extendedTextInteraction' ||
        element.name === 'rubricBlock')
    ) {
      break;
    }

    promptNodes.push(node);
  }

  return {
    prompt: renderOrderedMarkdownBlocks(promptNodes, context),
    responseIdentifiers: context.responseIdentifiers,
  };
}

function extractChoicesFromXml(
  xml: string,
  interactionType: TrackQuestionType,
): ParsedQtiChoice[] | undefined {
  if (interactionType !== 'choice') {
    return undefined;
  }

  const itemBody = getOrderedItemBody(xml);
  const interaction =
    itemBody === undefined
      ? undefined
      : findOrderedChildElement(itemBody.children, 'choiceInteraction');
  if (interaction === undefined) {
    return undefined;
  }

  const context = createMarkdownRenderContext({});
  const choices = interaction.children
    .map((node) => getOrderedElement(node))
    .filter((element): element is OrderedElement => element?.name === 'simpleChoice')
    .map((choice): ParsedQtiChoice => ({
      identifier: readStringAttribute(choice.attrs, '@_identifier') ?? '',
      text: renderOrderedMarkdownInline(choice.children, context),
    }))
    .filter((choice) => choice.identifier.length > 0);

  return choices.length > 0 ? choices : undefined;
}

function extractRubricFromXml(xml: string, options: { view?: string } = {}): string[] | undefined {
  const item = parseOrderedAssessmentItemXml(xml);
  if (item === undefined) {
    return undefined;
  }

  const context = createMarkdownRenderContext({});
  const rubric = findOrderedDescendantElements(item.children, 'rubricBlock')
    .filter((element) => options.view === undefined || hasViewAttribute(element.attrs, options.view))
    .map((element) => renderOrderedMarkdownBlocks(element.children, context))
    .filter((value) => value.length > 0);

  return rubric.length > 0 ? rubric : undefined;
}

function extractMaxScore(itemNode: XmlRecord): number | undefined {
  const maxScoreDeclaration = asRecords(itemNode.outcomeDeclaration)
    .find((declaration) => readStringAttribute(declaration, '@_identifier') === 'MAXSCORE');
  if (maxScoreDeclaration === undefined) {
    return undefined;
  }

  const defaultValue = asRecord(
    maxScoreDeclaration.defaultValue,
    'Invalid MAXSCORE outcomeDeclaration: expected defaultValue object node.',
  );
  const rawValue = asArray(defaultValue.value)
    .map((value) => getTextContent(value).trim())
    .find((value) => value.length > 0);
  if (rawValue === undefined) {
    return undefined;
  }

  const maxScore = Number(rawValue);
  return Number.isFinite(maxScore) && maxScore >= 0 ? maxScore : undefined;
}

function extractFeedbackFromXml(xml: string): string[] | undefined {
  const item = parseOrderedAssessmentItemXml(xml);
  if (item === undefined) {
    return undefined;
  }

  const context = createMarkdownRenderContext({});
  const feedback = findOrderedChildElements(item.children, 'modalFeedback')
    .map((element) => findOrderedChildElement(element.children, 'contentBody') ?? element)
    .map((element) => renderOrderedMarkdownBlocks(element.children, context))
    .filter((value) => value.length > 0);

  return feedback.length > 0 ? feedback : undefined;
}

function parseTimeLimitsNodeSeconds(timeLimitsNode: XmlRecord): number | undefined {
  const rawValue =
    readStringAttribute(timeLimitsNode, '@_maxTime') ??
    readStringAttribute(timeLimitsNode, '@_max-time') ??
    readStringAttribute(timeLimitsNode, '@_maxtime') ??
    readStringAttribute(timeLimitsNode, '@_maximum') ??
    readStringAttribute(timeLimitsNode, '@_seconds');

  if (!rawValue) {
    return undefined;
  }

  const numericSeconds = Number(rawValue);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return numericSeconds;
  }

  const isoMatch = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(rawValue.trim());
  if (!isoMatch) {
    return undefined;
  }

  const hours = Number(isoMatch[1] ?? 0);
  const minutes = Number(isoMatch[2] ?? 0);
  const seconds = Number(isoMatch[3] ?? 0);
  const totalSeconds = (hours * 60 * 60) + (minutes * 60) + seconds;
  return totalSeconds > 0 ? totalSeconds : undefined;
}

function parseTimeLimitSeconds(node: XmlRecord): number | undefined {
  for (const timeLimitsNode of asRecords(node.timeLimits)) {
    const timeLimitSeconds = parseTimeLimitsNodeSeconds(timeLimitsNode);
    if (timeLimitSeconds !== undefined) {
      return timeLimitSeconds;
    }
  }

  return undefined;
}

function findAssessmentSectionTimeLimitSeconds(sectionNode: XmlRecord): number | undefined {
  const sectionTimeLimitSeconds = parseTimeLimitSeconds(sectionNode);
  if (sectionTimeLimitSeconds !== undefined) {
    return sectionTimeLimitSeconds;
  }

  for (const childSectionNode of asRecords(sectionNode.assessmentSection)) {
    const childTimeLimitSeconds = findAssessmentSectionTimeLimitSeconds(childSectionNode);
    if (childTimeLimitSeconds !== undefined) {
      return childTimeLimitSeconds;
    }
  }

  return undefined;
}

function findTestPartTimeLimitSeconds(testPartNode: XmlRecord): number | undefined {
  const testPartTimeLimitSeconds = parseTimeLimitSeconds(testPartNode);
  if (testPartTimeLimitSeconds !== undefined) {
    return testPartTimeLimitSeconds;
  }

  for (const sectionNode of asRecords(testPartNode.assessmentSection)) {
    const sectionTimeLimitSeconds = findAssessmentSectionTimeLimitSeconds(sectionNode);
    if (sectionTimeLimitSeconds !== undefined) {
      return sectionTimeLimitSeconds;
    }
  }

  return undefined;
}

function findAssessmentTimeLimitSeconds(assessmentNode: XmlRecord): number | undefined {
  const assessmentTimeLimitSeconds = parseTimeLimitSeconds(assessmentNode);
  if (assessmentTimeLimitSeconds !== undefined) {
    return assessmentTimeLimitSeconds;
  }

  for (const testPartNode of asRecords(assessmentNode.testPart)) {
    const testPartTimeLimitSeconds = findTestPartTimeLimitSeconds(testPartNode);
    if (testPartTimeLimitSeconds !== undefined) {
      return testPartTimeLimitSeconds;
    }
  }

  return undefined;
}

function extractRubric(itemNode: XmlRecord): string[] {
  return asArray(itemNode.rubricBlock)
    .map((node) => getTextContent(node).trim())
    .filter((value) => value.length > 0);
}

function extractFeedback(itemNode: XmlRecord): string[] {
  return asArray(itemNode.modalFeedback)
    .map((node) => getTextContent(node).trim())
    .filter((value) => value.length > 0);
}

export function parseAssessmentXml(xml: string): ParsedAssessment {
  const parsedRoot: ParsedXmlNode = parseXml(xml);
  const assessmentNode = asRecord(
    parsedRoot.assessmentTest,
    'Invalid assessment-test XML: missing assessmentTest root.',
  );

  const identifier = readStringAttribute(assessmentNode, '@_identifier');
  if (!identifier) {
    throw new Error('Invalid assessment-test XML: missing assessment identifier.');
  }

  const itemRefs = collectAssessmentItemRefs(assessmentNode).map((refNode) => {
    const refIdentifier = readStringAttribute(refNode, '@_identifier') ?? '';
    return {
      identifier: refIdentifier,
      href: readStringAttribute(refNode, '@_href'),
    };
  }).filter((ref) => ref.identifier.length > 0);

  return {
    identifier,
    title: readStringAttribute(assessmentNode, '@_title'),
    timeLimitSeconds: findAssessmentTimeLimitSeconds(assessmentNode),
    itemRefs,
  };
}

export function parseAssessmentItemXml(xml: string): ParsedQtiItem {
  const parsedRoot: ParsedXmlNode = parseXml(xml);
  const itemNode = asRecord(
    parsedRoot.assessmentItem,
    'Invalid qti-assessment-item XML: missing assessmentItem root.',
  );

  const identifier = readStringAttribute(itemNode, '@_identifier');
  if (!identifier) {
    throw new Error('Invalid qti-assessment-item XML: missing item identifier.');
  }

  const title = readStringAttribute(itemNode, '@_title') ?? '';

  const itemBody = asRecord(itemNode.itemBody, 'Invalid qti-assessment-item XML: missing itemBody.');
  const { key: interactionKey, interaction } = findInteraction(itemBody);
  const interactionType = inferInteractionType(interactionKey);
  const responsesByDeclaration = extractCorrectResponsesByDeclaration(itemNode);
  const richPrompt = extractPromptFromXml(xml, responsesByDeclaration);
  const blanks =
    interactionType === 'text-entry'
      ? (
          richPrompt && richPrompt.responseIdentifiers.length > 0
            ? richPrompt.responseIdentifiers
            : Object.keys(responsesByDeclaration)
        )
          .map((responseIdentifier): ParsedBlank | undefined => {
            const declaration = responsesByDeclaration[responseIdentifier];
            const answer = declaration?.values[0];
            if (!answer) {
              return undefined;
            }

            return {
              responseIdentifier,
              answer,
              kind: declaration.kind,
            };
          })
          .filter((blank): blank is ParsedBlank => blank !== undefined)
      : [];
  const choices = extractChoicesFromXml(xml, interactionType);
  const rubric = extractRubricFromXml(xml);
  const scorerRubric = extractRubricFromXml(xml, { view: 'scorer' });
  const feedback = extractFeedbackFromXml(xml);

  return {
    identifier,
    title,
    interactionType,
    prompt: richPrompt && richPrompt.prompt.length > 0 ? richPrompt.prompt : extractPrompt(itemBody),
    timeLimitSeconds: parseTimeLimitSeconds(itemNode),
    choices: choices ?? extractChoices(interaction, interactionType),
    correctResponses: extractCorrectResponses(itemNode),
    blanks,
    rubric: rubric ?? extractRubric(itemNode),
    scorerRubric: scorerRubric ?? [],
    maxScore: extractMaxScore(itemNode),
    feedback: feedback ?? extractFeedback(itemNode),
  };
}

export function parseQtiPackageFromXml(options: {
  assessmentXml: string;
  itemXmlByIdentifier: Record<string, string>;
}): ParsedQtiPackage {
  const assessment = parseAssessmentXml(options.assessmentXml);
  const items: ParsedQtiItem[] = [];

  for (const itemRef of assessment.itemRefs) {
    const itemXml = options.itemXmlByIdentifier[itemRef.identifier];
    if (!itemXml) {
      continue;
    }

    items.push(parseAssessmentItemXml(itemXml));
  }

  const itemsByIdentifier = Object.fromEntries(items.map((item) => [item.identifier, item]));

  return {
    assessment,
    items,
    itemsByIdentifier,
  };
}
