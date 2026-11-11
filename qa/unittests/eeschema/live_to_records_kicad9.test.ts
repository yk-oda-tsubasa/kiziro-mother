// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CROSS_PROBING_SETTINGS } from '@ziroeda/common/settings/app_settings.js';
import { PGM_BASE, SETTINGS_MANAGER, SetPgm } from '@ziroeda/common/pgm_base.js';
import { MEMORY_FILESYSTEM, wxMountFileSystem } from '@ziroeda/wx/filefn.js';
import { repairPageNumbersOnLoad } from '@ziroeda/eeschema/project.js';
import { SCH_SHEET } from '@ziroeda/eeschema/sch_sheet.js';
import { SCH_SCREEN } from '@ziroeda/eeschema/sch_screen.js';
import { MD_CTRL } from '@ziroeda/common/tool/tool_event.js';
import { schToolHarness } from './support/sch_tool_harness.js';
import { KICAD_T } from '@ziroeda/core/typeinfo.js';
import { SCH_EDIT_FRAME } from '@ziroeda/eeschema/sch_edit_frame.js';
import type { SCH_LINE } from '@ziroeda/eeschema/sch_line.js';
import type { SCH_SYMBOL } from '@ziroeda/eeschema/sch_symbol.js';
import {
  LIVE_SCHEMATIC_MIRROR,
  openRecordsLive,
  liveScreensToRecords,
} from '@ziroeda/eeschema/sch_record_bridge.js';
import { readSchematic } from '@ziroeda/eeschema/sch_io/sexpr/read-schematic.js';
import { readSchematicText, serializeSheetFiles, serializeSchematic } from '@ziroeda/eeschema/sch_io/sexpr/schematic-text.js';
import { writeSchematic } from '@ziroeda/eeschema/sch_io/sexpr/write-schematic.js';
import { parse, serialize } from '@ziroeda/sexpr/index.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const id = (i: number) => '10000000-0000-4000-8000-' + String(i).padStart(12, '0');
const root = 'project.kicad_sch';
const child = 'child.kicad_sch';
const header = (i: number) =>
  `(kicad_sch (version 20250114) (generator eeschema) (uuid "${id(i)}") (paper "A4")`;
const title = '(title_block (title "Keep body_style") (comment 4 "retain this"))';
const parentText = `${header(1)} (lib_symbols)
  (sheet (at 20 20) (size 30 20) (uuid "${id(2)}")
    (property "Sheetname" "Child" (at 20 19 0)) (property "Sheetfile" "${child}" (at 20 41 0))
    (instances (project "project" (path "/${id(1)}" (page "2"))))))
`;
const childText = `${header(3)} ${title}
  (lib_symbols (symbol "Test:Gate" (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 0 0)) (property "Value" "Gate" (at 0 0 0))
    (symbol "Gate_1_1" (rectangle (start -1 1) (end 1 -1) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "Gate_1_2" (circle (center 0 0) (radius 1) (stroke (width 0) (type default)) (fill (type none))))))
  (symbol (lib_id "Test:Gate") (at 30 20 0) (unit 1) (convert 2) (uuid "${id(4)}")
    (property "Reference" "U1" (at 30 18 0)) (property "Value" "Gate" (at 30 22 0))
    (property "LegacyEmpty" "~" (at 30 24 0))
    (instances (project "project" (path "/${id(1)}/${id(2)}" (reference "U1") (unit 1)))))
  (wire (pts (xy 10 10) (xy 20 10)) (stroke (width 0) (type default)) (uuid "${id(5)}"))) `;

beforeEach(() => SetPgm(new PGM_BASE(null, new SETTINGS_MANAGER())));
afterEach(() => SetPgm(null));

function open(version = 20250114, rootText = parentText) {
  const frame = new SCH_EDIT_FRAME({
    crossProbingSettings: () => new CROSS_PROBING_SETTINGS(),
    saveProject: () => true,
  });
  let text = childText.replace('20250114', String(version));
  if (version === 20260306) text = text.replace('(convert 2)', '(body_style 2)');
  const docs = new Map([
    [root, readSchematicText(rootText, root)],
    [child, readSchematicText(text, child)],
  ]);
  const schematic = openRecordsLive(frame, { dir: '/project', root, docs, files: [] })!;
  const screen = [...schematic.Hierarchy()]
    .find((p) => p.LastScreen()?.GetFileName().endsWith(child))!
    .LastScreen()!;
  const symbol = [...screen.Items().OfType(KICAD_T.SCH_SYMBOL_T)][0] as SCH_SYMBOL;
  const save = () => liveScreensToRecords(frame, [screen], '/project').get(child)!;
  return { frame, docs, screen, symbol, save };
}

function editChild(version = 20250114) {
  const { docs, screen, symbol, save } = open(version);
  screen.GetTitleBlock().SetComment(0, 'Edited (in_pos_files yes)');
  const first = save();
  expect(first.version).toBe(version);
  expect(first.libSymbols).toEqual(docs.get(child)!.libSymbols);
  const line = [...screen.Items().OfType(KICAD_T.SCH_LINE_T)][0] as SCH_LINE;
  line.SetEndPoint({ x: 250000, y: 100000 });
  symbol.GetField('Value')!.SetText('Edited gate');
  const edited = save();
  const text = serialize(writeSchematic(edited));
  expect(edited.lines[0]!.end).toEqual({ x: 250000, y: 100000 });
  expect(edited.symbols[0]!.bodyStyle).toBe(2);
  expect(text).toContain('(convert 2)');
  expect(text).toContain('"LegacyEmpty" "~"');
  expect(text).toContain('"Edited (in_pos_files yes)"');
  expect(text).toContain('"retain this"');
  expect(text).not.toMatch(
    /\(body_style |\(duplicate_pin_numbers_are_jumpers|\(in_pos_files (yes|no)\)(?!")/,
  );
  return text;
}

it.each([
  20250114, 20230121,
])('preserves a %i child across successive page and wire edits', (version) => {
  editChild(version);
});

it('rejects a real position-file exclusion and keeps the source baseline', () => {
  const { frame, screen, symbol, save } = open();
  const parent = frame.GetScreen()!;
  parent.GetTitleBlock().SetComment(0, 'parent edit');
  symbol.SetExcludedFromPosFiles(true);
  expect(() => liveScreensToRecords(frame, [parent, screen], '/project')).toThrow(
    /child.kicad_sch.*in_pos_files/,
  );
  // The parent was visited first. A failed batch must not consume its delta.
  expect(
    serialize(writeSchematic(liveScreensToRecords(frame, [parent], '/project').get(root)!)),
  ).toContain('"parent edit"');
  symbol.SetExcludedFromPosFiles(false);
  symbol.SetBodyStyle(1);
  expect(serialize(writeSchematic(save()))).toContain('(convert 1)');
  screen.GetLibSymbols().get('Test:Gate')!.SetDuplicatePinNumbersAreJumpers(true);
  expect(save).toThrow(/lib_symbols/);
});

it('snapshots an untouched KiCad 10 root verbatim and writes its edited child natively', () => {
  const rootText = parentText.replace('20250114', '20260306').trimEnd() + '\r\n\r\n';
  const { docs, screen, symbol, save } = open(20260306, rootText);
  screen.GetTitleBlock().SetComment(0, 'new format');
  symbol.SetExcludedFromPosFiles(true);
  const doc = save();
  expect(doc.version).toBe(20260306);
  docs.set(child, doc);
  const snapshot = new Map(serializeSheetFiles(docs).map(({ name, text }) => [name, text]));
  expect(snapshot.get(root)).toBe(rootText);
  expect(snapshot.get(child)).toBe(serialize(writeSchematic(doc)));
  expect(snapshot.get(child)).toContain('"new format"');
  expect(snapshot.get(child)).toContain('(in_pos_files no)');
});

// Set KICAD9_CLI to opt into the exact native parser check.
it.skipIf(!process.env.KICAD9_CLI)('opens the saved child and hierarchy in native 9.0.7', () => {
  const cli = process.env.KICAD9_CLI!;
  expect(execFileSync(cli, ['version'], { encoding: 'utf8' }).trim()).toBe('9.0.7');
  const dir = mkdtempSync(join(tmpdir(), 'sch-bridge-'));
  try {
    writeFileSync(join(dir, child), editChild(20230121));
    writeFileSync(join(dir, root), parentText);
    for (const file of [child, root]) {
      const output = join(dir, file + '.xml');
      execFileSync(cli, [
        'sch',
        'export',
        'netlist',
        '--format',
        'kicadxml',
        '-o',
        output,
        join(dir, file),
      ]);
      expect(readFileSync(output, 'utf8')).toContain('<value>Edited gate</value>');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('saves the mixed hierarchy and current sheet copy from the accepted records', async () => {
  const disk = new MEMORY_FILESYSTEM();
  const unmount = wxMountFileSystem('/project', disk);
  const pro =
    '{"erc":{"rule_severities":{"pin_not_connected":"error"}},"net_settings":{"classes":[{"name":"Keep"}]}}';
  disk.Write('project.kicad_pro', new TextEncoder().encode(pro));
  const text = (file: string) => new TextDecoder().decode(disk.Read(file)!);
  try {
    const { frame, screen, save } = open(20230121);
    screen.GetTitleBlock().SetComment(0, 'child edit');
    const expected = serializeSchematic(save());
    expect(await frame.SaveProject()).toBe(true);
    expect(text(root)).toBe(parentText);
    expect(text(child)).toBe(expected);
    expect(text(child)).toContain('(version 20230121)');
    expect(text('project.kicad_pro')).toBe(pro);
    const sheet = frame.Schematic().Hierarchy().FindSheetForScreen(screen).Last()!;
    expect(frame.saveSchematicFile(sheet, '/project/copy.kicad_sch')).toBe(true);
    expect(text('copy.kicad_sch')).toBe(expected);

    screen.SetContentModified();
    frame.GetScreen()!.SetContentModified();
    const writes: string[] = [];
    disk.SetWriteListener((name) => writes.push(name));
    const symbol = [...screen.Items().OfType(KICAD_T.SCH_SYMBOL_T)][0] as SCH_SYMBOL;
    symbol.SetExcludedFromPosFiles(true);
    expect(save).toThrow(/in_pos_files/);
    expect(await frame.SaveProject()).toBe(false);
    expect(frame.saveSchematicFile(sheet, '/project/rejected.kicad_sch')).toBe(false);
    expect(writes).toEqual([]);
    expect(frame.GetScreen()!.IsContentModified()).toBe(true);
    expect(screen.IsContentModified()).toBe(true);
  } finally {
    unmount();
  }
});

it('rejects a new sheet without a source record before adopting its parent', () => {
  const { frame } = open();
  const parent = frame.GetScreen()!;
  const sheet = new SCH_SHEET(frame.Schematic());
  sheet.SetFileName('new.kicad_sch');
  const screen = new SCH_SCREEN(frame.Schematic());
  screen.SetFileName('/project/new.kicad_sch');
  sheet.SetScreen(screen);
  parent.Append(sheet);
  expect(() => liveScreensToRecords(frame, [parent, screen], '/project')).toThrow(/new sheet/);
  expect(() => frame.recordSaveSources!()).toThrow();
});

it.skipIf(!process.env.KICAD9_CLI)(
  'retains the full native component and net lists through a files-io project save',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixed-sch-'));
    const disk = new MEMORY_FILESYSTEM();
    const unmount = wxMountFileSystem('/issue14494', disk);
    const root = 'issue14494.kicad_sch';
    const child = 'issue14494_subsheet1.kicad_sch';
    const exportConnectivity = () => {
      const path = join(dir, 'out.xml');
      execFileSync(process.env.KICAD9_CLI!, [
        'sch',
        'export',
        'netlist',
        '--format',
        'kicadxml',
        '-o',
        path,
        join(dir, root),
      ]);
      const xml = readFileSync(path, 'utf8');
      const components = xml.match(/<components>[\s\S]*?<\/components>/)?.[0];
      const nets = xml.match(/<nets>[\s\S]*?<\/nets>/)?.[0];
      expect(components?.match(/<comp ref=/g)).toHaveLength(4);
      expect(nets).toContain('<node ref=');
      return { components, nets };
    };
    try {
      const docs = new Map<string, ReturnType<typeof readSchematic>>();
      for (const name of [root, child]) {
        const original = readFileSync(
          join(__dirname, '../../data/eeschema/netlist_oracle_graph/issue14494', name),
          'utf8',
        );
        const text =
          name === root ? original.replace('(version 20230121)', '(version 20250114)') : original;
        writeFileSync(join(dir, name), text);
        docs.set(name, readSchematicText(text, name));
      }
      const before = exportConnectivity();
      const frame = new SCH_EDIT_FRAME({
        crossProbingSettings: () => new CROSS_PROBING_SETTINGS(),
        saveProject: () => true,
      });
      schToolHarness(frame);
      const sch = openRecordsLive(frame, { dir: '/issue14494', root, docs, files: [] })!;
      const path = [...sch.Hierarchy()].find((p) => p.LastScreen()?.GetFileName().endsWith(child))!;
      frame.SetCurrentSheet(path);
      frame.DisplayCurrentSheet();
      const screen = path.LastScreen()!;
      screen.GetTitleBlock().SetComment(0, 'mixed hierarchy edit');
      liveScreensToRecords(frame, [screen], '/issue14494');
      expect(
        frame
          .GetToolManager()!
          .GetActionManager()
          .RunHotKey(MD_CTRL | 'S'.charCodeAt(0)),
      ).toBe(true);
      await vi.waitFor(() => expect(disk.Read(child)).not.toBeNull());
      for (const name of [root, child]) writeFileSync(join(dir, name), disk.Read(name)!);
      expect(exportConnectivity()).toEqual(before);
    } finally {
      unmount();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('restores the last accepted child and its dirty flag after a rejected edit', () => {
  const { frame, docs } = open(20230121);
  const mirror = new LIVE_SCHEMATIC_MIRROR(frame, () => ({
    dir: '/project',
    root,
    docs,
    files: [],
  }));
  const getChild = () =>
    [...mirror.get()!.Hierarchy()]
      .find((p) => p.LastScreen()?.GetFileName().endsWith(child))!
      .LastScreen()!;
  const original = getChild();
  original.GetTitleBlock().SetComment(0, 'accepted');
  const accepted = liveScreensToRecords(frame, [original], '/project');
  docs.set(child, accepted.get(child)!);
  mirror.Adopt(accepted);
  original.SetContentModified();
  const symbol = [...original.Items().OfType(KICAD_T.SCH_SYMBOL_T)][0] as SCH_SYMBOL;
  symbol.SetExcludedFromPosFiles(true);
  expect(() => liveScreensToRecords(frame, [original], '/project')).toThrow(/in_pos_files/);
  mirror.Invalidate();
  const restored = getChild();
  expect(restored !== original).toBe(true);
  expect(restored.IsContentModified()).toBe(true);
  expect(serializeSchematic(frame.recordSaveSources!()!.get(restored)!)).toContain('"accepted"');
  expect(
    ([...restored.Items().OfType(KICAD_T.SCH_SYMBOL_T)][0] as SCH_SYMBOL).GetExcludedFromPosFiles(),
  ).toBe(false);
});

it('preserves the new project’s exact peer text while saving a repaired and edited root', async () => {
  const { frame } = open();
  // Reuse the sheet filenames on the same frame, with different source bytes.
  const peer = childText.trimEnd().replaceAll('\n', '\r\n\t  ') + '\r\n\r\n';
  const duplicate = parentText
    .replace('(lib_symbols)', '(lib_symbols) (sheet_instances (path "/" (page "1")))')
    .replace('(page "2")', '(page "1")');
  const imported = new Map([
    [root, readSchematicText(duplicate, root)],
    [child, readSchematicText(peer, child)],
  ]);
  const { docs, repaired } = repairPageNumbersOnLoad(imported, root);
  expect(repaired).toBe(true);

  const disk = new MEMORY_FILESYSTEM();
  const dir = '/second';
  const unmount = wxMountFileSystem(dir, disk);
  try {
    const live = openRecordsLive(frame, { dir, root, docs, files: [] })!;
    live.RootScreen()!.GetTitleBlock().SetComment(0, 'Second project edit');
    const screens = [...live.Hierarchy()].map((path) => path.LastScreen()!);
    const adopted = liveScreensToRecords(frame, screens, dir);
    for (const [file, doc] of adopted) docs.set(file, doc);

    const snapshot = new Map(serializeSheetFiles(docs).map(({ name, text }) => [name, text]));
    expect(snapshot.get(child)).toBe(peer);
    const savedRoot = snapshot.get(root)!;
    expect(readSchematicText(savedRoot, root).sheets[0]!.instances[0]!.page).toBe('2');
    expect(savedRoot).toContain('"Second project edit"');

    expect(await frame.SaveProject()).toBe(true);
    const encode = new TextEncoder();
    expect(disk.Read(child)).toEqual(encode.encode(peer));
    expect(disk.Read(root)).toEqual(encode.encode(savedRoot));
  } finally {
    unmount();
  }
});
