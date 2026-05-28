import { parseXml, getTextContent } from './src/parser/xml-parser.js';

const xml = `
<qti-item-body>
  <qti-p>Which is a prime? <qti-img src="images/diagram.png" alt="Alt text" title="Diagram"/></qti-p>
  <img src="html-img.png" alt="HTML Image" />
</qti-item-body>
`;

const parsed = parseXml(xml);
console.dir(parsed, { depth: null });
console.log("Extracted:", getTextContent(parsed));
