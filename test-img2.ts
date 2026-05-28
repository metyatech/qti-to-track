import { XMLParser } from 'fast-xml-parser';

const xml = `
<qti-item-body>
  <qti-p>Which is a prime? <qti-img src="images/diagram.png" alt="Alt text" title="Diagram"/></qti-p>
  <img src="html-img.png" alt="HTML Image" />
</qti-item-body>
`;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
});

console.dir(parser.parse(xml), { depth: null });
