import { type ParsedAssessment, type ParsedQtiItem, type ParsedQtiPackage } from '../types.js';
export declare function parseAssessmentXml(xml: string): ParsedAssessment;
export declare function parseAssessmentItemXml(xml: string): ParsedQtiItem;
export declare function parseQtiPackageFromXml(options: {
    assessmentXml: string;
    itemXmlByIdentifier: Record<string, string>;
}): ParsedQtiPackage;
