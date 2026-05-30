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

function asRecords(value: unknown): XmlRecord[] {
  return asArray(value).filter(
    (node): node is XmlRecord => !!node && typeof node === 'object' && !Array.isArray(node),
  );
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

function extractTextEntryPromptFromXml(
  xml: string,
  responsesByDeclaration: Record<string, ParsedResponseDeclaration>,
): { prompt: string; responseIdentifiers: string[] } {
  const preserveParsed = preserveOrderXmlParser.parse(xml);
  if (!Array.isArray(preserveParsed) || preserveParsed.length === 0) {
    return { prompt: '', responseIdentifiers: [] };
  }

  const rootNode = preserveParsed[0] as XmlRecord;
  const assessmentItemNodes = rootNode.assessmentItem;
  if (!Array.isArray(assessmentItemNodes)) {
    return { prompt: '', responseIdentifiers: [] };
  }

  const itemBodyEntry = assessmentItemNodes.find((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    return 'itemBody' in (entry as XmlRecord);
  }) as XmlRecord | undefined;

  if (!itemBodyEntry) {
    return { prompt: '', responseIdentifiers: [] };
  }

  const itemBodyNodes = itemBodyEntry.itemBody;
  if (!Array.isArray(itemBodyNodes)) {
    return { prompt: '', responseIdentifiers: [] };
  }

  const lines: string[] = [];
  const responseIdentifiers: string[] = [];

  for (const node of itemBodyNodes) {
    if (!node || typeof node !== 'object') {
      continue;
    }

    const record = node as XmlRecord;
    if ('choiceInteraction' in record || 'extendedTextInteraction' in record || 'rubricBlock' in record) {
      continue;
    }

    for (const [tagName, tagValue] of Object.entries(record)) {
      if (tagName === ':@' || !Array.isArray(tagValue)) {
        continue;
      }

      const chunks: string[] = [];

      for (const child of tagValue) {
        if (!child || typeof child !== 'object') {
          continue;
        }

        const childRecord = child as XmlRecord;
        const textValue = childRecord['#text'];
        if (typeof textValue === 'string' && textValue.length > 0) {
          chunks.push(textValue);
        }

        if ('textEntryInteraction' in childRecord) {
          const attrs = childRecord[':@'];
          const responseIdentifier =
            attrs && typeof attrs === 'object' && !Array.isArray(attrs)
              ? readResponseIdentifierAttribute(attrs as XmlRecord)
              : undefined;

          const responseDeclaration = responseIdentifier ? responsesByDeclaration[responseIdentifier] : undefined;
          if (responseIdentifier) {
            responseIdentifiers.push(responseIdentifier);
          }

          const placeholder = formatBlankPlaceholder(
            responseIdentifier
              ? {
                  responseIdentifier,
                  answer: responseDeclaration?.values[0] ?? '',
                  kind: responseDeclaration?.kind ?? 'exact',
                }
              : undefined,
          );
          chunks.push(placeholder);
        } else if ('img' in childRecord || 'qti-img' in childRecord) {
          const attrs = childRecord[':@'];
          if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
            const src = readStringAttribute(attrs as XmlRecord, '@_src') ?? '';
            const alt = readStringAttribute(attrs as XmlRecord, '@_alt') ?? '';
            if (src) {
              chunks.push(`![${alt}](${src})`);
            }
          }
        } else {
          const inlineText = getTextContent(
            Object.fromEntries(
              Object.entries(childRecord).filter(([key]) => key !== ':@' && key !== '#text' && key !== 'textEntryInteraction'),
            ),
          );
          if (inlineText) {
            chunks.push(inlineText);
          }
        }
      }

      const line = chunks.join('').replace(/\s+/g, ' ').trim();
      if (line) {
        lines.push(line);
      }
    }
  }

  return { prompt: lines.join('\n').trim(), responseIdentifiers };
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
  const textEntryPrompt =
    interactionType === 'text-entry'
      ? extractTextEntryPromptFromXml(xml, responsesByDeclaration)
      : undefined;
  const blanks =
    interactionType === 'text-entry'
      ? (
          textEntryPrompt && textEntryPrompt.responseIdentifiers.length > 0
            ? textEntryPrompt.responseIdentifiers
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

  return {
    identifier,
    title,
    interactionType,
    prompt: textEntryPrompt && textEntryPrompt.prompt.length > 0 ? textEntryPrompt.prompt : extractPrompt(itemBody),
    timeLimitSeconds: parseTimeLimitSeconds(itemNode),
    choices: extractChoices(interaction, interactionType),
    correctResponses: extractCorrectResponses(itemNode),
    blanks,
    rubric: extractRubric(itemNode),
    feedback: extractFeedback(itemNode),
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
