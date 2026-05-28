export type ParsedXmlNode = Record<string, unknown>;
export declare function parseXml(xml: string): ParsedXmlNode;
export declare function asArray<T>(value: T | T[] | null | undefined): T[];
export declare function getTextContent(node: unknown): string;
