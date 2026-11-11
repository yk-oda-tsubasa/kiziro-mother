// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
// Portions derived from KiCad, copyright The KiCad Developers. See NOTICE.md.
/**
 * Archive / Unarchive: allow-list filtering, project-folder re-nesting, and
 * byte-exact zip round-trips (the compatibility promise applies to archives
 * too, what goes in must come out identical).
 */
import 'fake-indexeddb/auto';
import {
  loadProject,
  saveProject,
  updateProjectFiles,
} from '@ziroeda/designer/src/home/projectStore.js';
import { describe, it, expect } from 'vitest';
import {
  archiveEntries,
  archiveSource,
  withArchiveSource,
  currentArchiveEntries,
  zipArchive,
  expandArchive,
  relPath,
} from '@ziroeda/designer/src/home/project_archiver.js';
import type { PickedHomeFile } from '@ziroeda/designer/src/home/files.js';

const enc = new TextEncoder();
const f = (name: string, text = 'x'): PickedHomeFile => ({ name, text, bytes: enc.encode(text) });

describe('relPath', () => {
  it('strips the project folder and normalises separators', () => {
    expect(relPath('proj/proj.kicad_sch')).toBe('proj.kicad_sch');
    expect(relPath('proj/sub/a.kicad_sch')).toBe('sub/a.kicad_sch');
    expect(relPath('proj\\sub\\a.kicad_sch')).toBe('sub/a.kicad_sch');
    expect(relPath('loose.kicad_pcb')).toBe('loose.kicad_pcb');
  });
});

describe('archiveEntries', () => {
  it('re-nests allow-listed files under the project name and skips the rest', () => {
    const entries = archiveEntries(
      [f('proj/proj.kicad_pcb'), f('proj/out/top.gbr'), f('proj/node_modules/x.tgz')],
      'proj',
    );
    expect(Object.keys(entries!)).toEqual(['proj/proj.kicad_pcb', 'proj/out/top.gbr']);
  });

  it('skips empty files and returns null when nothing qualifies', () => {
    expect(archiveEntries([{ name: 'proj/empty.kicad_sch', text: '' }], 'proj')).toBeNull();
    expect(archiveEntries([f('readme.docx')], 'proj')).toBeNull();
  });
});

describe('manager archive source', () => {
  const text = { name: 'main.sch', text: 'reopened sheet' };
  const binary = new Uint8Array([0, 255, 128]);
  it('includes text-only files and both library tables in an unsaved session', async () => {
    const files = [
      text,
      { name: 'sym-lib-table', text: 'symbols' },
      { name: 'fp-lib-table', text: 'footprints' },
    ];
    const entries = await currentArchiveEntries(files, 'main', loadProject);
    for (const f of files) expect(entries?.['main/' + f.name]).toEqual(enc.encode(f.text));
  });

  it('keeps original text bytes unless the session text changed', async () => {
    const bytes = enc.encode('\uFEFForiginal');
    const entries = await currentArchiveEntries(
      [
        { name: 'a.sch', text: 'original', bytes },
        { name: 'b.sch', text: 'edited', bytes },
      ],
      'main',
      loadProject,
    );
    expect(entries?.['main/a.sch']).toBe(bytes);
    expect(entries?.['main/b.sch']).toEqual(enc.encode('edited'));
  });

  it('uses the complete saved record over stale picks and overlays only outstanding writes', async () => {
    const files = [
      f('main.pro'),
      f('main.sch', 'saved sheet'),
      f('libs/a/part.lib', 'saved A'),
      f('libs/b/part.lib', 'saved B'),
      { name: 'libs/easyeda/part.step', bytes: binary },
    ];
    const id = await saveProject(
      'main',
      files.map((v) => ({ name: v.name, bytes: v.bytes! })),
    );
    await updateProjectFiles(id, [{ name: 'main.sch', bytes: enc.encode('explicit save') }]);
    const picked = [f('main.sch', 'stale'), f('deleted.lib')];
    const source = archiveSource(picked);
    source.id = id;
    source.dirty.set('libs/b/part.lib', enc.encode('just edited'));
    const entries = await currentArchiveEntries(picked, 'main', loadProject);
    const unpacked = expandArchive(zipArchive(entries!))!;
    expect(Object.fromEntries(unpacked.map((f) => [f.name, f.data]))).toEqual({
      'main/main.pro': enc.encode('x'),
      'main/main.sch': enc.encode('explicit save'),
      'main/libs/a/part.lib': enc.encode('saved A'),
      'main/libs/b/part.lib': enc.encode('just edited'),
      'main/libs/easyeda/part.step': binary,
    });
  });

  it('archives the displayed selection after Open Recent B and a Calculator manager remount', async () => {
    const a = [f('main.sch', 'A')];
    const b = [f('main.sch', 'B')];
    for (const files of [a, b]) {
      archiveSource(files).id = await saveProject(
        files === a ? 'A' : 'B',
        files.map((file) => ({ name: file.name, bytes: file.bytes! })),
      );
    }
    const editor = archiveSource(a);
    editor.dirty.set('main.sch', enc.encode('pending A'));
    // Open Recent changes only the manager. B can receive a newer write in another tab.
    await updateProjectFiles(archiveSource(b).id!, [
      { name: 'main.sch', bytes: enc.encode('new B') },
    ]);
    expect((await currentArchiveEntries(b, 'B', loadProject))?.['B/main.sch']).toEqual(
      enc.encode('new B'),
    );
    // Calculator did not open B in an editor. The manager mounts from A again.
    const remounted = withArchiveSource([...a], editor);
    expect((await currentArchiveEntries(remounted, 'A', loadProject))?.['A/main.sch']).toEqual(
      enc.encode('pending A'),
    );
    editor.dirty.clear();
    expect((await currentArchiveEntries(remounted, 'A', loadProject))?.['A/main.sch']).toEqual(
      enc.encode('A'),
    );
    const demo = [f('main.sch', 'demo')];
    expect((await currentArchiveEntries(demo, 'A', loadProject))?.['A/main.sch']).toEqual(
      enc.encode('demo'),
    );
  });

  it('removes one legacy wrapper, including on binary Windows paths', () => {
    const entries = archiveEntries(
      [f('import/main.pro'), { name: 'import\\libs\\part.step', bytes: binary }],
      'main',
    );
    expect(entries?.['main/libs/part.step']).toBe(binary);
  });

  it('reports a missing or unreadable saved record instead of archiving stale picks', async () => {
    const picked = [text];
    archiveSource(picked).id = 'missing';
    await expect(currentArchiveEntries(picked, 'main', async () => null)).rejects.toThrow(
      'not be found',
    );
    await expect(
      currentArchiveEntries(picked, 'main', async () => {
        throw Error('read failed');
      }),
    ).rejects.toThrow('read failed');
  });
});

describe('zip round-trip', () => {
  it('expandArchive(zipArchive(x)) is byte-exact', () => {
    const entries = archiveEntries([f('proj/proj.kicad_pcb', '(kicad_pcb)')], 'proj')!;
    const out = expandArchive(zipArchive(entries));
    expect(out).toHaveLength(1);
    expect(out![0]!.name).toBe('proj/proj.kicad_pcb');
    expect(new TextDecoder().decode(out![0]!.data)).toBe('(kicad_pcb)');
  });

  it('returns null for bytes that are not a zip', () => {
    expect(expandArchive(enc.encode('not a zip'))).toBeNull();
  });
});
