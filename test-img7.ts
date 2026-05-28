import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  transformTagName: (tagName) => {
    const stripped = tagName.replace(/^qti-/, '');
    return stripped.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }
});

console.dir(parser.parse("<qti-assessment-item><qti-item-body><qti-choice-interaction/></qti-item-body></qti-assessment-item>"), { depth: null });
