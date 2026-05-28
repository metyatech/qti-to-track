import { parseXml } from './src/parser/xml-parser.js';

const xml = `
<qti-assessment-item identifier="item-2">
  <qti-item-body>
    <qti-p>The value of <qti-text-entry-interaction response-identifier="RESPONSE"/>.</qti-p>
  </qti-item-body>
</qti-assessment-item>
`;
console.dir(parseXml(xml), { depth: null });
