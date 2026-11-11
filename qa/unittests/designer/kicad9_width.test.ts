// SPDX-License-Identifier: GPL-3.0-or-later
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openWidthBoard } from '@ziroeda/designer/src/editors/pcb/kicad9_width.js';
import { nativeBoardEntry } from '@ziroeda/designer/src/editors/pcb/board_entry.js';
import { EMPTY_PCB } from '@ziroeda/designer/src/home/new_project.js';
import {
  loadProject,
  saveProject,
  updateProjectFiles,
} from '@ziroeda/designer/src/home/projectStore.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL('../../data/pcbnew/' + name, import.meta.url)));
const bytes = fixture('kiziro9/handoff.kicad_pcb');
const text = new TextDecoder().decode(bytes);
const encode = (s: string) => new TextEncoder().encode(s);
const open = (s: string) => openWidthBoard(s, encode(s));
const front = 'fe917dfc-fc9d-47ed-a2f2-c9369527404c';
const back = '498de150-f456-4111-bbd8-6bc6a9cc2324';

describe('isolated KiCad 9 width editing', () => {
  it('only admits native 10 or the exact app blank to the ordinary PCB editor', () => {
    const ten = new TextDecoder().decode(fixture('component_classes_resave.kicad_pcb'));
    expect(nativeBoardEntry(ten, EMPTY_PCB)).toBe(true);
    expect(nativeBoardEntry(EMPTY_PCB, EMPTY_PCB)).toBe(true);
    for (const s of [
      text,
      '',
      text.slice(15),
      text.replace('(version 20241229)', '(version "20260206")'),
      EMPTY_PCB + '(unknown)',
    ])
      expect(nativeBoardEntry(s, EMPTY_PCB)).toBe(false);
  });
  it('splices one or both widths, preserving even noncanonical whitespace and numeric spelling', () => {
    const source = text.replace(/\r?\n/g, '\r\n').replace('(width 0.5)', '(width\t0.500000 )');
    const board = open(source);
    expect(board.segments.map((s) => [s.id, s.net])).toEqual([
      [front, '1: SIGNAL'],
      [back, '1: SIGNAL'],
    ]);
    expect(board.withWidth([front], '0.32')).toBe(
      source.replace('(width\t0.500000 )', '(width\t0.32 )'),
    );
    const expected = source
      .replace('(width\t0.500000 )', '(width\t0.42 )')
      .replace('(width 0.5)', '(width 0.42)');
    expect(board.withWidth([back, front], '0.42')).toBe(expected);
    expect(open(expected).segments.map((s) => s.width)).toEqual(['0.42', '0.42']);
  });
  it.each([
    ['(thermal_bridge_angle 45)', '(thermal_bridge_angle 45 (later yes))'],
    ['(thermal_bridge_angle 45)', '(thermal_bridge_angle 45 later)'],
    ['(attr smd)', '(attr smd exclude_from_bom)'],
    ['(disableapertmacros no)', '(disableapertmacros maybe)'],
    ['(width 0.5)', '(width 0.5) (locked yes)'],
    ['(width 0.5)', '(width 0.5) (width 0.4)'],
    ['(net 1 "SIGNAL")', '(net 3 "SIGNAL")'],
    ['(net_name "GND")', '(net_name "SIGNAL")'],
    ['(xy 12 12)', '(xy 12 12 0)'],
    [back, front],
    ['(width 0.5)', '(width "0.5")'],
    ['(width 0.5)', '(width 0.5'],
    ['(net 2 "GND")', '(net 2"GND")'],
  ])('rejects unsupported source %s → %s before offering any edit', (a, b) => {
    expect(() => open(text.replace(a, b))).toThrow();
  });
  it('requires original bytes and a complete board, rejects trailing data, BOM and lossy decoding', () => {
    expect(() => open(text + '(segment)')).toThrow();
    expect(() => openWidthBoard(text)).toThrow();
    expect(() => openWidthBoard(text, encode('\uFEFF' + text))).toThrow();
    expect(() =>
      openWidthBoard(
        text,
        bytes.map((b, i) => (i === 95 ? 255 : b)),
      ),
    ).toThrow();
  });
  it('rejects a via, a mixed selection, duplicate IDs and invalid widths as a whole', () => {
    const board = open(text);
    for (const ids of [[], [front, front], [front, 'c28c53d7-db7f-439e-aaee-e2133cfca420']])
      expect(() => board.withWidth(ids, '0.8')).toThrow();
    for (const width of ['-1', '0', '20', '1e-5', '0.1234567', 'NaN', '1) (net 2'])
      expect(() => board.withWidth([front], width)).toThrow();
  });
  it('commits only the board, refuses stale/deleted sources and preserves project and rule bytes', async () => {
    const original = { name: 'handoff.kicad_pcb', bytes };
    const project = { name: 'handoff.kicad_pro', bytes: fixture('kiziro9/handoff.kicad_pro') };
    const rules = { name: 'handoff.kicad_dru', bytes: encode('(version 1)\r\n') };
    const id = await saveProject('handoff', [original, project, rules]);
    const changed = { name: original.name, bytes: encode(open(text).withWidth([back], '0.3')) };
    await updateProjectFiles(id, [changed], original);
    await expect(updateProjectFiles(id, [original], original)).rejects.toThrow(/changed/);
    await expect(updateProjectFiles('deleted-project', [changed], original)).rejects.toThrow();
    expect((await loadProject(id))?.files).toEqual([changed, project, rules]);
  });
});
