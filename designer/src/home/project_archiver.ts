// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
// Portions derived from KiCad, copyright The KiCad Developers. See NOTICE.md.
/**
 * Archive / Unarchive project logic: KiCad zips the whole project folder,
 * reading each file as a raw byte stream (PROJECT_ARCHIVER::Archive). We do
 * the same, byte-exact entries, re-nested under a folder named for the
 * project (so an archive unzips the way KiCad expects). Pure functions; the
 * download/upload plumbing stays in the launcher component.
 */

import { unzipSync, zipSync } from 'fflate';
import { isToolingPath } from './project_picker.js';
import { inArchiveAllowList } from './project_tree.js';

/** A manager selection and its editor snapshots share this identity. Independently
 * picked files get a fresh identity, even when every filename matches. */
export interface ArchiveSource {
  id: string | null;
  dirty: Map<string, Uint8Array>;
}
const sources = new WeakMap<readonly unknown[], ArchiveSource>();
export function archiveSource(files: readonly unknown[]): ArchiveSource {
  let source = sources.get(files);
  if (!source) {
    source = { id: null, dirty: new Map() };
    sources.set(files, source);
  }
  return source;
}
export function withArchiveSource<T extends readonly unknown[]>(
  files: T,
  source: ArchiveSource,
): T {
  sources.set(files, source);
  return files;
}

/** Path relative to the project's own folder ("proj/proj.kicad_sch" ->
 * "proj.kicad_sch", "proj/sub/a.kicad_sch" -> "sub/a.kicad_sch"). */
export const relPath = (name: string): string => {
  const p = name.replace(/\\/g, '/');
  return p.includes('/') ? p.slice(p.indexOf('/') + 1) : p;
};

/**
 * Collect the zip entries for Archive Project: only allow-listed file types
 * (gerbers/backups/images and other stray files are skipped, matching KiCad's
 * archiver), each as raw bytes under `<name>/…`. Returns null when nothing
 * qualifies.
 */
export function archiveEntries(
  files: readonly { name: string; bytes?: Uint8Array; text?: string }[],
  name: string,
  edits: ReadonlyMap<string, Uint8Array> = new Map(),
): Record<string, Uint8Array> | null {
  const normalize = (path: string) => path.replace(/\\/g, '/');
  const normalized = files.map((f) => ({ ...f, name: normalize(f.name) }));
  // Older folder picks include the selected folder. Strip it only when it
  // encloses the whole set and reveals a root design document.
  const first = normalized[0]?.name.split('/')[0];
  const prefix =
    first &&
    normalized.every((f) => f.name.startsWith(first + '/')) &&
    normalized.some((f) =>
      /^[^/]+\.(kicad_pro|kicad_sch|kicad_pcb|pro|sch|brd)$/i.test(f.name.slice(first.length + 1)),
    )
      ? first + '/'
      : '';
  const entries: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  for (const f of normalized) {
    if (!inArchiveAllowList(f.name)) continue;
    // A session file can retain its picked bytes after its text was edited.
    // Equal decoded text keeps its original encoding (including a UTF-8 BOM);
    // binary files have no text view.
    const data =
      f.bytes && (!f.text || dec.decode(f.bytes) === f.text) ? f.bytes : enc.encode(f.text);
    if (data.length) entries[`${name}/${f.name.slice(prefix.length)}`] = data;
  }
  for (const [path, bytes] of edits) {
    const p = normalize(path);
    if (!inArchiveAllowList(p)) continue;
    const key = `${name}/${prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p}`;
    if (bytes.length) entries[key] = bytes;
    else delete entries[key];
  }
  return Object.keys(entries).length ? entries : null;
}

/** A known record is authoritative, even if reading it fails. Never silently
 * substitute the older picker snapshot for an unreadable saved project. */
export async function currentArchiveEntries(
  picked: readonly { name: string; text: string; bytes?: Uint8Array }[],
  name: string,
  readSaved: (id: string) => Promise<{ files: { name: string; bytes: Uint8Array }[] } | null>,
) {
  const { id, dirty } = archiveSource(picked);
  const edits = new Map(dirty);
  if (!id) return archiveEntries(picked, name, edits);
  const record = await readSaved(id);
  if (!record) throw new Error('The saved project could not be found.');
  return archiveEntries(
    record.files.filter((f) => !isToolingPath(f.name)),
    name,
    edits,
  );
}

/** Zip the collected entries (blocking, paint any progress UI first). */
export const zipArchive = (entries: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> =>
  zipSync(entries, { level: 6 }) as Uint8Array<ArrayBuffer>;

/**
 * Expand an uploaded .zip into named byte entries, skipping directory
 * entries and empty files. Returns null when the bytes aren't a valid zip.
 */
export function expandArchive(bytes: Uint8Array): { name: string; data: Uint8Array }[] | null {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return null;
  }
  return Object.entries(entries)
    .filter(([name, data]) => !name.endsWith('/') && data.length > 0)
    .map(([name, data]) => ({ name, data }));
}
