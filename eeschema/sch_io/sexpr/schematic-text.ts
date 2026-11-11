// SPDX-License-Identifier: GPL-3.0-or-later
import { parse, serialize, type SList } from '@ziroeda/sexpr/index.js';
import type { Schematic } from '../../types.js';
import { readSchematic } from './read-schematic.js';
import { writeSchematic } from './write-schematic.js';

export const isPreservedVersion = (version: number) => version === 20250114 || version === 20230121;

// Only the immutable record actually read from this text can reuse it. A
// repair or record edit sharing its source AST still needs the record writer.
const exactTexts = new WeakMap<Schematic, string>();

export function readSchematicText(text: string, fileName: string): Schematic {
  return recordFromSource(parse(text), fileName, text);
}

export function recordFromSource(source: SList, fileName: string, text?: string): Schematic {
  const record = { ...readSchematic(source), fileName };
  if (isPreservedVersion(record.version)) exactTexts.set(record, text ?? serialize(source));
  return record;
}

export function schematicSaveSource(record: Schematic): SList {
  return exactTexts.has(record) ? record.source : writeSchematic(record);
}

export function serializeSchematic(record: Schematic): string {
  return exactTexts.get(record) ?? serialize(writeSchematic(record));
}

/** The host snapshots all resident sheets on autosave and on flush. */
export function serializeSheetFiles(docs: ReadonlyMap<string, Schematic>): { name: string; text: string }[] {
  const files = [];
  for (const [name, doc] of docs) {
    try {
      files.push({ name, text: serializeSchematic(doc) });
    } catch {
      // A bad sheet must not prevent saving the others.
    }
  }
  return files;
}
