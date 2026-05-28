import { parseAssessmentItemXml } from './src/parser/qti-parser.js';

const xml1 = `
<qti-assessment-item identifier="item-1">
  <qti-item-body>
    <qti-p>Which is a prime? <qti-img src="images/diagram.png" alt="Alt text" title="Diagram"/></qti-p>
    <qti-choice-interaction response-identifier="RESPONSE">
      <qti-simple-choice identifier="CHOICE_1">9</qti-simple-choice>
      <qti-simple-choice identifier="CHOICE_2">11</qti-simple-choice>
    </qti-choice-interaction>
  </qti-item-body>
</qti-assessment-item>
`;

const xml2 = `
<qti-assessment-item identifier="item-2">
  <qti-item-body>
    <qti-p>The value of <img src="math.png" alt="math" /> is <qti-text-entry-interaction response-identifier="RESPONSE"/>.</qti-p>
  </qti-item-body>
</qti-assessment-item>
`;

console.log("Choice:", parseAssessmentItemXml(xml1).prompt);
console.log("Cloze:", parseAssessmentItemXml(xml2).prompt);
