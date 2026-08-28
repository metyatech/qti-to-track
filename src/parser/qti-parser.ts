import { DOMParser, type Element as XmlElement } from '@xmldom/xmldom';
import hljs from 'highlight.js';
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
  type: 'element';
  name: string;
  children: OrderedNode[];
  attrs: XmlRecord;
}

interface OrderedText {
  type: 'text';
  value: string;
}

type OrderedNode = OrderedElement | OrderedText;

interface HtmlRenderContext {
  responsesByDeclaration: Record<string, ParsedResponseDeclaration>;
  responseIdentifiers: string[];
  insidePre: boolean;
}

const INTERACTION_KEYS = [
  'choiceInteraction',
  'textEntryInteraction',
  'extendedTextInteraction',
] as const;

const RETIRED_PRESENTATION_TAG_NAMES = new Set([
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
]);

const VOID_HTML_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
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

function normalizePresentationTagName(rawName: string): string {
  const localName = rawName.split(':').pop() ?? rawName;
  if (RETIRED_PRESENTATION_TAG_NAMES.has(localName)) {
    throw new Error(`Retired QTI presentation element is not supported: ${localName}`);
  }

  const stripped = localName.replace(/^qti-/, '');
  return stripped.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toOrderedElement(element: XmlElement): OrderedElement {
  const name = normalizePresentationTagName(element.localName || element.tagName);
  const attrs: XmlRecord = {};
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute !== null) {
      attrs[`@_${attribute.name}`] = attribute.value;
    }
  }

  const children: OrderedNode[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (child === null) {
      continue;
    }

    if (child.nodeType === 1) {
      children.push(toOrderedElement(child as XmlElement));
    } else if (child.nodeType === 3 || child.nodeType === 4) {
      children.push({ type: 'text', value: child.nodeValue ?? '' });
    }
  }

  return {
    type: 'element',
    name,
    children,
    attrs,
  };
}

function parseOrderedAssessmentItemXml(xml: string): OrderedElement | undefined {
  const document = new DOMParser({
    onError(_level, message) {
      throw new Error(`Invalid QTI presentation XML: ${message}`);
    },
  }).parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (root === null) {
    return undefined;
  }

  const item = toOrderedElement(root);
  return item.name === 'assessmentItem' ? item : undefined;
}

function getOrderedElement(node: OrderedNode): OrderedElement | undefined {
  return node.type === 'element' ? node : undefined;
}

function getOrderedText(node: OrderedNode): string | undefined {
  return node.type === 'text' ? node.value : undefined;
}

function findOrderedChildElement(
  nodes: readonly OrderedNode[],
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
  nodes: readonly OrderedNode[],
  name: string,
): OrderedElement[] {
  return nodes
    .map((node) => getOrderedElement(node))
    .filter((element): element is OrderedElement => element?.name === name);
}

function findOrderedDescendantElements(
  nodes: readonly OrderedNode[],
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

  if (JSON.stringify(itemBody).includes('"textEntryInteraction"')) {
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

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/gu, '&quot;');
}

function serializeAttributes(attrs: XmlRecord): string {
  return Object.entries(attrs)
    .filter(([key, value]) => key.startsWith('@_') && typeof value === 'string')
    .map(([key, value]) => ` ${key.slice(2)}="${escapeHtmlAttribute(value as string)}"`)
    .join('');
}

function appendMissingRelTokens(rel: string, requiredTokens: readonly string[]): string {
  const existingTokens = new Set(
    rel
      .split(/\s+/u)
      .filter((token) => token.length > 0)
      .map((token) => token.toLowerCase()),
  );
  const missingTokens = requiredTokens.filter((token) => !existingTokens.has(token));

  return missingTokens.length === 0
    ? rel
    : `${rel}${rel.length > 0 ? ' ' : ''}${missingTokens.join(' ')}`;
}

function serializeTrackElementAttributes(element: OrderedElement): string {
  if (element.name !== 'a') {
    return serializeAttributes(element.attrs);
  }

  const href = readStringAttribute(element.attrs, '@_href');
  if (href === undefined || !/^(?:https?:\/\/|\/\/)/iu.test(href.trim())) {
    return serializeAttributes(element.attrs);
  }

  const attrs = { ...element.attrs };
  attrs['@_target'] = '_blank';
  attrs['@_rel'] = appendMissingRelTokens(
    readStringAttribute(attrs, '@_rel') ?? '',
    ['noopener', 'noreferrer'],
  );
  return serializeAttributes(attrs);
}

function createHtmlRenderContext(
  responsesByDeclaration: Record<string, ParsedResponseDeclaration>,
): HtmlRenderContext {
  return {
    responsesByDeclaration,
    responseIdentifiers: [],
    insidePre: false,
  };
}

function formatBlankPlaceholder(blank: ParsedBlank | undefined): string {
  if (!blank || blank.answer.length === 0) {
    return '${}';
  }

  return blank.kind === 'regex' ? `\${/${blank.answer}/}` : `\${${blank.answer}}`;
}

function renderTextEntryPlaceholder(
  element: OrderedElement,
  context: HtmlRenderContext,
): string {
  const responseIdentifier = readResponseIdentifierAttribute(element.attrs);
  const responseDeclaration =
    responseIdentifier === undefined
      ? undefined
      : context.responsesByDeclaration[responseIdentifier];

  if (responseIdentifier !== undefined && !context.responseIdentifiers.includes(responseIdentifier)) {
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

function serializeOrderedHtml(
  nodes: readonly OrderedNode[],
  context: HtmlRenderContext,
): string {
  return nodes.map((node) => serializeOrderedHtmlNode(node, context)).join('');
}

function normalizePreformattedText(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

function serializeTrackText(value: string, insidePre: boolean): string {
  if (!insidePre) {
    return escapeHtmlText(value);
  }

  const normalized = normalizePreformattedText(value);
  return escapeHtmlText(normalized).replace(/\n/gu, '<br />');
}

function readCodeLanguage(attrs: XmlRecord): string | undefined {
  const className = readStringAttribute(attrs, '@_class');
  const match = className?.match(/\blang(?:uage)?-([\w-]+)\b/u);
  return match?.[1];
}

function hasAuthoredElementChildren(element: OrderedElement): boolean {
  return element.children.some((child) => child.type === 'element');
}

function getTextOnlyCodeSource(element: OrderedElement): string | undefined {
  if (hasAuthoredElementChildren(element)) {
    return undefined;
  }

  return element.children
    .map((child) => (child.type === 'text' ? child.value : ''))
    .join('');
}

function parseHtmlFragment(value: string): OrderedNode[] {
  const document = new DOMParser({
    onError(_level, message) {
      throw new Error(`Invalid highlighted HTML fragment: ${message}`);
    },
  }).parseFromString(`<track-fragment>${value}</track-fragment>`, 'application/xml');
  const root = document.documentElement;
  if (root === null) {
    return [];
  }

  const nodes: OrderedNode[] = [];
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const child = root.childNodes.item(index);
    if (child === null) {
      continue;
    }

    if (child.nodeType === 1) {
      nodes.push(toOrderedElement(child as XmlElement));
    } else if (child.nodeType === 3 || child.nodeType === 4) {
      nodes.push({ type: 'text', value: child.nodeValue ?? '' });
    }
  }

  return nodes;
}

function serializeHighlightedCode(
  element: OrderedElement,
  context: HtmlRenderContext,
): string {
  const source = getTextOnlyCodeSource(element);
  if (source === undefined) {
    return serializeOrderedHtml(element.children, context);
  }

  const normalizedSource = normalizePreformattedText(source);
  const language = readCodeLanguage(element.attrs);
  if (language === 'plain') {
    return serializeTrackText(normalizedSource, true);
  }

  const highlightedHtml = language !== undefined && hljs.getLanguage(language) !== undefined
    ? hljs.highlight(language, normalizedSource).value
    : hljs.highlightAuto(normalizedSource).value;
  return serializeOrderedHtml(parseHtmlFragment(highlightedHtml), { ...context, insidePre: true });
}

function serializeOrderedHtmlNode(
  node: OrderedNode,
  context: HtmlRenderContext,
): string {
  const text = getOrderedText(node);
  if (text !== undefined) {
    return serializeTrackText(text, context.insidePre);
  }

  const element = getOrderedElement(node);
  if (element === undefined) {
    return '';
  }

  switch (element.name) {
    case 'contentBody':
    case 'rubricBlock':
      return element.name === 'rubricBlock' ? '' : serializeOrderedHtml(element.children, context);
    case 'choiceInteraction':
    case 'extendedTextInteraction':
      return '';
    case 'textEntryInteraction':
      return renderTextEntryPlaceholder(element, context);
    default: {
      const attributes = serializeTrackElementAttributes(element);
      const openingTag = `<${element.name}${attributes}`;
      if (VOID_HTML_ELEMENTS.has(element.name)) {
        return `${openingTag} />`;
      }

      const childContext =
        element.name === 'pre' ? { ...context, insidePre: true } : context;
      const children = element.name === 'code' && context.insidePre
        ? serializeHighlightedCode(element, childContext)
        : serializeOrderedHtml(element.children, childContext);
      return `${openingTag}>${children}</${element.name}>`;
    }
  }
}

function renderOrderedPlainText(nodes: readonly OrderedNode[]): string {
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

    if (element.name === 'br') {
      chunks.push('\n');
      continue;
    }

    chunks.push(renderOrderedPlainText(element.children));
  }

  return chunks.join('');
}

function normalizePlainRubric(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

function extractPromptFromXml(
  xml: string,
  responsesByDeclaration: Record<string, ParsedResponseDeclaration>,
): { prompt: string; responseIdentifiers: string[] } | undefined {
  const itemBody = getOrderedItemBody(xml);
  if (itemBody === undefined) {
    return undefined;
  }

  const context = createHtmlRenderContext(responsesByDeclaration);
  return {
    prompt: serializeOrderedHtml(itemBody.children, context).trim(),
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

  const context = createHtmlRenderContext({});
  const choices = interaction.children
    .map((node) => getOrderedElement(node))
    .filter((element): element is OrderedElement => element?.name === 'simpleChoice')
    .map((choice): ParsedQtiChoice => ({
      identifier: readStringAttribute(choice.attrs, '@_identifier') ?? '',
      text: serializeOrderedHtml(choice.children, context).trim(),
    }))
    .filter((choice) => choice.identifier.length > 0);

  return choices.length > 0 ? choices : undefined;
}

function extractRubricFromXml(xml: string, options: { view?: string } = {}): string[] | undefined {
  const item = parseOrderedAssessmentItemXml(xml);
  if (item === undefined) {
    return undefined;
  }

  const rubric = findOrderedDescendantElements(item.children, 'rubricBlock')
    .filter((element) => options.view === undefined || hasViewAttribute(element.attrs, options.view))
    .flatMap((element) => {
      if (options.view === 'scorer') {
        const directChildren = element.children
          .map((node) => getOrderedElement(node))
          .filter((child): child is OrderedElement => child !== undefined);
        const rubricParts = directChildren.length > 0
          ? directChildren.map((child) => normalizePlainRubric(renderOrderedPlainText(child.children)))
          : [normalizePlainRubric(renderOrderedPlainText(element.children))];
        return rubricParts;
      }

      return [serializeOrderedHtml(element.children, createHtmlRenderContext({})).trim()];
    })
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

  const feedback = findOrderedChildElements(item.children, 'modalFeedback')
    .map((element) => findOrderedChildElement(element.children, 'contentBody') ?? element)
    .map((element) => serializeOrderedHtml(element.children, createHtmlRenderContext({})).trim())
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
    prompt: richPrompt?.prompt ?? '',
    timeLimitSeconds: parseTimeLimitSeconds(itemNode),
    choices: choices ?? [],
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
