import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedQtiPackage } from '../types.js';
import { parseAssessmentItemXml, parseQtiPackageFromXml } from '../parser/qti-parser.js';
import { parseXml } from '../parser/xml-parser.js';

async function listXmlFilesRecursively(directoryPath: string): Promise<string[]> {
  const dirents = await readdir(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const dirent of dirents) {
    const fullPath = join(directoryPath, dirent.name);

    if (dirent.isDirectory()) {
      files.push(...(await listXmlFilesRecursively(fullPath)));
      continue;
    }

    if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.xml')) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function loadQtiPackage(directoryPath: string): Promise<ParsedQtiPackage> {
  const xmlFiles = await listXmlFilesRecursively(directoryPath);
  if (xmlFiles.length === 0) {
    throw new Error(`No XML files found in directory: ${directoryPath}`);
  }

  let assessmentXml: string | undefined;
  const itemXmlByIdentifier: Record<string, string> = {};

  for (const filePath of xmlFiles) {
    const xml = await readFile(filePath, 'utf8');

    let root: Record<string, unknown>;
    try {
      root = parseXml(xml);
    } catch (error) {
      throw new Error(`Failed to parse XML file: ${filePath}`, { cause: error });
    }

    if (root.assessmentTest) {
      if (assessmentXml) {
        throw new Error(`Multiple assessment-test XML files found under directory: ${directoryPath}`);
      }

      assessmentXml = xml;
      continue;
    }

    if (root.assessmentItem) {
      const parsedItem = parseAssessmentItemXml(xml);
      itemXmlByIdentifier[parsedItem.identifier] = xml;
    }
  }

  if (!assessmentXml) {
    throw new Error(`assessment-test XML not found under directory: ${directoryPath}`);
  }

  return parseQtiPackageFromXml({
    assessmentXml,
    itemXmlByIdentifier,
  });
}
