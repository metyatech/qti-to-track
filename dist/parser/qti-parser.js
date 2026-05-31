import { XMLParser } from 'fast-xml-parser';
import { asArray, getTextContent, parseXml } from './xml-parser.js';
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
];
const ORDERED_ATTRS_KEY = ':@';
const ORDERED_TEXT_KEY = '#text';
const BLOCK_ELEMENT_NAMES = new Set([
    'blockquote',
    'contentBody',
    'div',
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
function asRecord(value, errorMessage) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(errorMessage);
    }
    return value;
}
function readStringAttribute(node, key) {
    const value = node[key];
    return typeof value === 'string' ? value : undefined;
}
function readAnyStringAttribute(node, keys) {
    for (const key of keys) {
        const value = readStringAttribute(node, key);
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}
function readResponseIdentifierAttribute(node) {
    return readAnyStringAttribute(node, ['@_responseIdentifier', '@_response-identifier']);
}
function asRecords(value) {
    return asArray(value).filter((node) => !!node && typeof node === 'object' && !Array.isArray(node));
}
function getOrderedElement(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return undefined;
    }
    const record = node;
    const name = Object.keys(record).find((key) => key !== ORDERED_ATTRS_KEY && key !== ORDERED_TEXT_KEY);
    if (name === undefined) {
        return undefined;
    }
    const children = asRecords(record[name]);
    const attrs = record[ORDERED_ATTRS_KEY] && typeof record[ORDERED_ATTRS_KEY] === 'object' && !Array.isArray(record[ORDERED_ATTRS_KEY])
        ? record[ORDERED_ATTRS_KEY]
        : {};
    return { name, children, attrs };
}
function getOrderedText(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return undefined;
    }
    const value = node[ORDERED_TEXT_KEY];
    return typeof value === 'string' ? value : undefined;
}
function parseOrderedAssessmentItemXml(xml) {
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
function findOrderedChildElement(nodes, name) {
    for (const node of nodes) {
        const element = getOrderedElement(node);
        if (element?.name === name) {
            return element;
        }
    }
    return undefined;
}
function findOrderedChildElements(nodes, name) {
    return nodes
        .map((node) => getOrderedElement(node))
        .filter((element) => element?.name === name);
}
function findOrderedDescendantElements(nodes, name) {
    const matches = [];
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
function getOrderedItemBody(xml) {
    const item = parseOrderedAssessmentItemXml(xml);
    return item === undefined ? undefined : findOrderedChildElement(item.children, 'itemBody');
}
function collectAssessmentItemRefs(node) {
    if (!node || typeof node !== 'object') {
        return [];
    }
    if (Array.isArray(node)) {
        return node.flatMap(collectAssessmentItemRefs);
    }
    const record = node;
    const refs = [];
    for (const [key, value] of Object.entries(record)) {
        if (key === 'assessmentItemRef') {
            for (const ref of asArray(value)) {
                if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
                    refs.push(ref);
                }
            }
            continue;
        }
        refs.push(...collectAssessmentItemRefs(value));
    }
    return refs;
}
function findInteraction(itemBody) {
    for (const key of ['choiceInteraction', 'extendedTextInteraction']) {
        const value = itemBody[key];
        if (value) {
            const interaction = asRecord(Array.isArray(value) ? value[0] : value, `Invalid ${key}: expected an object node.`);
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
function inferInteractionType(interactionKey) {
    if (interactionKey === 'choiceInteraction') {
        return 'choice';
    }
    if (interactionKey === 'textEntryInteraction') {
        return 'text-entry';
    }
    return 'extended-text';
}
function extractPrompt(itemBody) {
    const chunks = [];
    for (const [key, value] of Object.entries(itemBody)) {
        if (INTERACTION_KEYS.includes(key)) {
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
function extractChoices(interaction, interactionType) {
    if (interactionType !== 'choice' || !interaction) {
        return [];
    }
    return asArray(interaction.simpleChoice)
        .map((choice) => asRecord(choice, 'Invalid simpleChoice node: expected object.'))
        .map((choice) => ({
        identifier: readStringAttribute(choice, '@_identifier') ?? '',
        text: getTextContent(choice),
    }))
        .filter((choice) => choice.identifier.length > 0);
}
function extractCorrectResponses(itemNode) {
    return extractResponseDeclarations(itemNode).flatMap((declaration) => declaration.values);
}
function extractResponseDeclarations(itemNode) {
    const declarations = asArray(itemNode.responseDeclaration)
        .filter((value) => !!value && typeof value === 'object' && !Array.isArray(value));
    const parsedDeclarations = [];
    for (const declaration of declarations) {
        const declarationId = readStringAttribute(declaration, '@_identifier');
        if (!declarationId) {
            continue;
        }
        const correctResponse = declaration.correctResponse;
        if (!correctResponse || typeof correctResponse !== 'object' || Array.isArray(correctResponse)) {
            continue;
        }
        const valueNode = correctResponse.value;
        const values = [];
        for (const value of asArray(valueNode)) {
            const text = getTextContent(value).trim();
            if (text) {
                values.push(text);
            }
        }
        if (values.length > 0) {
            const interpretationKind = readStringAttribute(declaration, '@_interpretation') === 'regex' ? 'regex' : 'exact';
            const kind = interpretationKind === 'regex' ||
                (values.length === 1 && values[0].length >= 2 && values[0].startsWith('/') && values[0].endsWith('/'))
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
function extractCorrectResponsesByDeclaration(itemNode) {
    const map = {};
    for (const declaration of extractResponseDeclarations(itemNode)) {
        map[declaration.identifier] = declaration;
    }
    return map;
}
function formatBlankPlaceholder(blank) {
    if (!blank || blank.answer.length === 0) {
        return '${}';
    }
    return blank.kind === 'regex' ? `\${/${blank.answer}/}` : `\${${blank.answer}}`;
}
function createMarkdownRenderContext(responsesByDeclaration) {
    return {
        responsesByDeclaration,
        responseIdentifiers: [],
    };
}
function renderOrderedMarkdownBlocks(nodes, context) {
    const blocks = [];
    for (const node of nodes) {
        const rendered = renderOrderedMarkdownBlock(node, context);
        if (rendered.length > 0) {
            blocks.push(rendered);
        }
    }
    return blocks.join('\n\n').trim();
}
function renderOrderedMarkdownBlock(node, context) {
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
        case 'ol':
            return renderOrderedMarkdownList(element.children, context, true);
        case 'p':
            return renderOrderedMarkdownInline(element.children, context);
        case 'pre':
            return renderCodeFence(rawOrderedText(element.children));
        case 'ul':
            return renderOrderedMarkdownList(element.children, context, false);
        default:
            if (hasBlockElement(element.children)) {
                return renderOrderedMarkdownBlocks(element.children, context);
            }
            return renderOrderedMarkdownInline(element.children, context);
    }
}
function renderOrderedMarkdownList(nodes, context, ordered) {
    const items = nodes
        .map((node) => getOrderedElement(node))
        .filter((element) => element?.name === 'li');
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
function renderOrderedMarkdownInline(nodes, context) {
    return normalizeInlineMarkdown(nodes.map((node) => renderOrderedMarkdownInlineNode(node, context)).join(''));
}
function renderOrderedMarkdownInlineNode(node, context) {
    const text = getOrderedText(node);
    if (text !== undefined) {
        return text;
    }
    const element = getOrderedElement(node);
    if (element === undefined) {
        return '';
    }
    switch (element.name) {
        case 'br':
            return '\n';
        case 'code':
            return formatInlineCode(rawOrderedText(element.children));
        case 'em':
        case 'i':
            return `*${renderOrderedMarkdownInline(element.children, context)}*`;
        case 'img': {
            const src = readStringAttribute(element.attrs, '@_src') ?? '';
            const alt = readStringAttribute(element.attrs, '@_alt') ?? '';
            return src.length > 0 ? `![${alt}](${src})` : '';
        }
        case 'strong':
        case 'b':
            return `**${renderOrderedMarkdownInline(element.children, context)}**`;
        case 'textEntryInteraction':
            return renderTextEntryPlaceholder(element, context);
        default:
            return renderOrderedMarkdownInline(element.children, context);
    }
}
function renderTextEntryPlaceholder(element, context) {
    const responseIdentifier = readResponseIdentifierAttribute(element.attrs);
    const responseDeclaration = responseIdentifier === undefined
        ? undefined
        : context.responsesByDeclaration[responseIdentifier];
    if (responseIdentifier !== undefined) {
        context.responseIdentifiers.push(responseIdentifier);
    }
    return formatBlankPlaceholder(responseIdentifier === undefined
        ? undefined
        : {
            responseIdentifier,
            answer: responseDeclaration?.values[0] ?? '',
            kind: responseDeclaration?.kind ?? 'exact',
        });
}
function renderCodeFence(rawCode) {
    const code = rawCode.replace(/^\n+/u, '').replace(/\n+$/u, '');
    return `\`\`\`\n${code}\n\`\`\``;
}
function formatInlineCode(rawCode) {
    const code = normalizeInlineMarkdown(rawCode);
    if (!code.includes('`')) {
        return `\`${code}\``;
    }
    const longestRun = Math.max(...Array.from(code.matchAll(/`+/gu), (match) => match[0].length));
    const fence = '`'.repeat(longestRun + 1);
    return `${fence} ${code} ${fence}`;
}
function rawOrderedText(nodes) {
    const chunks = [];
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
function hasBlockElement(nodes) {
    return nodes.some((node) => {
        const element = getOrderedElement(node);
        return element !== undefined && BLOCK_ELEMENT_NAMES.has(element.name);
    });
}
function normalizeInlineMarkdown(value) {
    return value.replace(/\s+/gu, ' ').trim();
}
function extractPromptFromXml(xml, responsesByDeclaration) {
    const itemBody = getOrderedItemBody(xml);
    if (itemBody === undefined) {
        return undefined;
    }
    const context = createMarkdownRenderContext(responsesByDeclaration);
    const promptNodes = [];
    for (const node of itemBody.children) {
        const element = getOrderedElement(node);
        if (element !== undefined &&
            (element.name === 'choiceInteraction' ||
                element.name === 'extendedTextInteraction' ||
                element.name === 'rubricBlock')) {
            break;
        }
        promptNodes.push(node);
    }
    return {
        prompt: renderOrderedMarkdownBlocks(promptNodes, context),
        responseIdentifiers: context.responseIdentifiers,
    };
}
function extractChoicesFromXml(xml, interactionType) {
    if (interactionType !== 'choice') {
        return undefined;
    }
    const itemBody = getOrderedItemBody(xml);
    const interaction = itemBody === undefined
        ? undefined
        : findOrderedChildElement(itemBody.children, 'choiceInteraction');
    if (interaction === undefined) {
        return undefined;
    }
    const context = createMarkdownRenderContext({});
    const choices = interaction.children
        .map((node) => getOrderedElement(node))
        .filter((element) => element?.name === 'simpleChoice')
        .map((choice) => ({
        identifier: readStringAttribute(choice.attrs, '@_identifier') ?? '',
        text: renderOrderedMarkdownInline(choice.children, context),
    }))
        .filter((choice) => choice.identifier.length > 0);
    return choices.length > 0 ? choices : undefined;
}
function extractRubricFromXml(xml) {
    const item = parseOrderedAssessmentItemXml(xml);
    if (item === undefined) {
        return undefined;
    }
    const context = createMarkdownRenderContext({});
    const rubric = findOrderedDescendantElements(item.children, 'rubricBlock')
        .map((element) => renderOrderedMarkdownBlocks(element.children, context))
        .filter((value) => value.length > 0);
    return rubric.length > 0 ? rubric : undefined;
}
function extractFeedbackFromXml(xml) {
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
function parseTimeLimitsNodeSeconds(timeLimitsNode) {
    const rawValue = readStringAttribute(timeLimitsNode, '@_maxTime') ??
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
function parseTimeLimitSeconds(node) {
    for (const timeLimitsNode of asRecords(node.timeLimits)) {
        const timeLimitSeconds = parseTimeLimitsNodeSeconds(timeLimitsNode);
        if (timeLimitSeconds !== undefined) {
            return timeLimitSeconds;
        }
    }
    return undefined;
}
function findAssessmentSectionTimeLimitSeconds(sectionNode) {
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
function findTestPartTimeLimitSeconds(testPartNode) {
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
function findAssessmentTimeLimitSeconds(assessmentNode) {
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
function extractRubric(itemNode) {
    return asArray(itemNode.rubricBlock)
        .map((node) => getTextContent(node).trim())
        .filter((value) => value.length > 0);
}
function extractFeedback(itemNode) {
    return asArray(itemNode.modalFeedback)
        .map((node) => getTextContent(node).trim())
        .filter((value) => value.length > 0);
}
export function parseAssessmentXml(xml) {
    const parsedRoot = parseXml(xml);
    const assessmentNode = asRecord(parsedRoot.assessmentTest, 'Invalid assessment-test XML: missing assessmentTest root.');
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
export function parseAssessmentItemXml(xml) {
    const parsedRoot = parseXml(xml);
    const itemNode = asRecord(parsedRoot.assessmentItem, 'Invalid qti-assessment-item XML: missing assessmentItem root.');
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
    const blanks = interactionType === 'text-entry'
        ? (richPrompt && richPrompt.responseIdentifiers.length > 0
            ? richPrompt.responseIdentifiers
            : Object.keys(responsesByDeclaration))
            .map((responseIdentifier) => {
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
            .filter((blank) => blank !== undefined)
        : [];
    const choices = extractChoicesFromXml(xml, interactionType);
    const rubric = extractRubricFromXml(xml);
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
        feedback: feedback ?? extractFeedback(itemNode),
    };
}
export function parseQtiPackageFromXml(options) {
    const assessment = parseAssessmentXml(options.assessmentXml);
    const items = [];
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
