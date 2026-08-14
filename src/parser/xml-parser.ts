import { XMLParser } from 'fast-xml-parser';

export type ParsedXmlNode = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  preserveOrder: false,
  processEntities: true,
  transformTagName: (tagName) => {
    const stripped = tagName.replace(/^qti-/, '');
    return stripped.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  },
  isArray: (_name, jpath, isLeafNode, isAttribute) => {
    if (isAttribute) {
      return false;
    }

    if (isLeafNode) {
      return false;
    }

    const forceArrayPaths = new Set([
      'assessmentTest.testPart.assessmentSection.assessmentItemRef',
      'assessmentItem.itemBody.choiceInteraction.simpleChoice',
      'assessmentItem.responseDeclaration.correctResponse.value',
      'assessmentItem.modalFeedback',
      'assessmentItem.rubricBlock',
    ]);

    const normalizedPath = typeof jpath === 'string' ? jpath : '';

    return forceArrayPaths.has(normalizedPath);
  },
});

export function parseXml(xml: string): ParsedXmlNode {
  const parsed = xmlParser.parse(xml);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid XML root: expected an object node.');
  }

  return parsed as ParsedXmlNode;
}

export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function getTextContent(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }

  if (typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }

  if (!node || typeof node !== 'object') {
    return '';
  }

  const valueObject = node as Record<string, unknown>;
  const chunks: string[] = [];

  for (const [key, value] of Object.entries(valueObject)) {
    if (key === '#text' && typeof value === 'string') {
      chunks.push(value);
      continue;
    }

    if (key.startsWith('@_')) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const nested of value) {
        const text = getTextContent(nested);
        if (text) {
          chunks.push(text);
        }
      }
      continue;
    }

    const text = getTextContent(value);
    if (text) {
      chunks.push(text);
    }
  }

  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}
