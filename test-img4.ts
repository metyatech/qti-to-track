import { parseXml } from './src/parser/xml-parser.js';

const xml = `
<qti-assessment-item identifier="item-1">
</qti-assessment-item>
`;

console.dir(parseXml(xml), { depth: null });
