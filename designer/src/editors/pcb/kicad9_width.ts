// SPDX-License-Identifier: GPL-3.0-or-later
// This recognizer describes a small, ordered subset of native 9.0.7 output.
// There is deliberately no "skip list", generic attribute, or model serializer.
import { tokenCursor, tokenize, type Token, type TokenCursor } from '@ziroeda/sexpr';
import { layers9, setup9 } from './kicad9_profile.js';

const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
function mm(value: string): boolean {
  return decimal.test(value) && Math.abs(Number(value)) <= 1000;
}
function widthOK(value: string): boolean {
  return mm(value) && Number(value) > 0 && Number(value) <= 10;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const templates = new Map<string, Token[]>();

class Reader {
  private readonly ids = new Set<string>();
  private readonly cursor: TokenCursor;
  private current?: Token;
  private next?: Token;
  constructor(text: string) {
    this.cursor = tokenCursor(text);
    this.current = this.cursor.next();
    this.next = this.cursor.next();
  }

  at(head: string): boolean {
    return (
      this.current?.type === 'lparen' && this.next?.type === 'atom' && this.next.value === head
    );
  }
  fail(expected: string): never {
    const t = this.current;
    throw new Error(
      `Expected ${expected}; found ${t ? JSON.stringify(t.value.slice(0, 50)) + ' at offset ' + t.pos : 'end of board'}.`,
    );
  }
  // Match literals (including their quoting) and capture only typed operands.
  take(pattern: string): Token[] {
    const parts = templates.get(pattern) ?? tokenize(pattern);
    templates.set(pattern, parts);
    const captured: Token[] = [];
    for (const part of parts) {
      const t = this.current;
      if (!t) this.fail(part.value);
      const next = this.next;
      if (
        (t.type === 'atom' || t.type === 'string') &&
        (next?.type === 'atom' || next?.type === 'string') &&
        t.pos + t.value.length + (t.type === 'string' ? 2 : 0) === next.pos
      )
        this.fail('whitespace between values');
      const v = t.value;
      let ok: boolean;
      switch (part.value) {
        case '$id':
          ok = t.type === 'string' && uuid.test(v) && !this.ids.has(v) && !/^0[-0]+$/.test(v);
          this.ids.add(v);
          break;
        case '$text':
          ok = t.type === 'string' && !/[\r\n\t]/.test(v);
          break;
        case '$footprint':
          ok = t.type === 'string' && /^[\w.-]+:[\w.-]+$/.test(v);
          break;
        case '$pad':
          ok = t.type === 'string' && /^[1-9]\d{0,5}$/.test(v);
          break;
        case '$attr':
          ok = t.type === 'atom' && (v === 'smd' || v === 'through_hole');
          break;
        case '$cu':
          ok = t.type === 'string' && (v === 'F.Cu' || v === 'B.Cu');
          break;
        case '$net':
          ok = t.type === 'atom' && /^(0|[1-9]\d{0,5})$/.test(v);
          break;
        case '$mm':
          ok = t.type === 'atom' && mm(v);
          break;
        case '$size':
          ok = t.type === 'atom' && mm(v) && Number(v) > 0;
          break;
        case '$width':
          ok = t.type === 'atom' && widthOK(v);
          break;
        default:
          ok = t.type === part.type && v === part.value;
      }
      if (!ok) this.fail(part.value);
      if (part.value.startsWith('$')) captured.push(t);
      this.current = next;
      this.next = this.cursor.next();
    }
    return captured;
  }
  end(): void {
    if (this.current) this.fail('end of board');
  }
}

export interface Segment9 {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly layer: string;
  readonly net: string;
  readonly width: string;
}

export function openWidthBoard(text: string, bytes?: Uint8Array) {
  if (
    !bytes ||
    text.length > 2_000_000 ||
    bytes.length !== text.length ||
    /[^\x20-\x7e\t\r\n]|\\/.test(text) ||
    !bytes.every((byte, i) => byte === text.charCodeAt(i))
  ) {
    throw new Error('Expected verified plain ASCII board bytes (no BOM or escapes), at most 2 MB.');
  }
  const r = new Reader(text);
  const take = (pattern: string) => r.take(pattern);
  const nets = new Map<string, string>();
  const names = new Set<string>();
  const segments: Segment9[] = [];
  const spans = new Map<string, Token>();
  function netRef(named = false): string {
    const [n, name] = take(named ? '(net $net $text)' : '(net $net)');
    if (!nets.has(n!.value) || (name && nets.get(n!.value) !== name.value))
      throw new Error(`Unknown or inconsistent numbered net ${n!.value}.`);
    return n!.value;
  }
  function footprint() {
    take('(footprint $footprint (layer "F.Cu") (uuid $id) (at $mm $mm)');
    const properties = new Set(['Reference', 'Value', 'Datasheet', 'Description']);
    while (r.at('property')) {
      const [key] = take('(property $text $text (at $mm $mm 0)');
      if (!properties.delete(key!.value))
        throw new Error('Unknown or duplicate footprint property.');
      const [layer] = take('(layer $text)');
      if (!['F.SilkS', 'F.Fab'].includes(layer!.value))
        throw new Error('Unsupported property layer.');
      if (r.at('hide')) take('(hide yes)');
      take('(uuid $id) (effects (font (size $size $size) (thickness $size))))');
    }
    const [attr] = take('(attr $attr)');
    while (r.at('pad')) {
      if (attr!.value === 'smd') {
        take(
          '(pad $pad smd rect (at $mm $mm) (size $size $size) (layers "F.Cu" "F.Mask" "F.Paste")',
        );
        netRef(true);
        take('(thermal_bridge_angle 45) (uuid $id))');
      } else {
        take(
          '(pad $pad thru_hole circle (at $mm $mm) (size $size $size) (drill $size) (layers "*.Cu" "*.Mask") (remove_unused_layers no)',
        );
        netRef(true);
        take('(uuid $id))');
      }
    }
    take('(embedded_fonts no))');
  }
  function points() {
    take('(pts (xy $mm $mm) (xy $mm $mm) (xy $mm $mm)');
    while (r.at('xy')) take('(xy $mm $mm)');
    take('))');
  }
  function zone() {
    take('(zone');
    const net = netRef();
    const [name, layer] = take('(net_name $text) (layer $cu) (uuid $id) (hatch edge $size)');
    if (nets.get(net) !== name!.value) throw new Error('Zone net name does not match its number.');
    take('(connect_pads yes (clearance $size)) (min_thickness $size) (filled_areas_thickness no)');
    take('(fill yes (thermal_gap $size) (thermal_bridge_width $size)) (polygon');
    points();
    while (r.at('filled_polygon')) {
      const [filled] = take('(filled_polygon (layer $cu)');
      if (filled!.value !== layer!.value)
        throw new Error('Filled polygon layer does not match its zone.');
      points();
    }
    take(')');
  }

  take('(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")');
  take('(general (thickness $size) (legacy_teardrops no)) (paper "A4")');
  take(layers9);
  take(setup9);
  take('(net 0 "")');
  nets.set('0', '');
  names.add('');
  while (r.at('net')) {
    const [n, name] = take('(net $net $text)');
    if (nets.has(n!.value) || names.has(name!.value))
      throw new Error('Duplicate net number or name.');
    nets.set(n!.value, name!.value);
    names.add(name!.value);
  }
  while (r.at('footprint')) footprint();
  while (r.at('gr_line'))
    take(
      '(gr_line (start $mm $mm) (end $mm $mm) (stroke (width $size) (type default)) (layer "Edge.Cuts") (uuid $id))',
    );
  while (r.at('segment') || r.at('via')) {
    if (r.at('via')) {
      take('(via (at $mm $mm) (size $size) (drill $size) (layers "F.Cu" "B.Cu")');
      netRef();
      take('(uuid $id))');
    } else {
      const [x, y, ex, ey, width, layer] = take(
        '(segment (start $mm $mm) (end $mm $mm) (width $width) (layer $cu)',
      );
      const net = netRef();
      const [id] = take('(uuid $id))');
      spans.set(id!.value, width!);
      segments.push({
        id: id!.value,
        start: `${x!.value}, ${y!.value}`,
        end: `${ex!.value}, ${ey!.value}`,
        net: `${net}: ${nets.get(net) || '(unconnected)'}`,
        width: width!.value,
        layer: layer!.value,
      });
    }
  }
  while (r.at('zone')) zone();
  take('(embedded_fonts no))');
  r.end();
  return {
    segments: segments as readonly Segment9[],
    withWidth(ids: readonly string[], width: string): string {
      if (!widthOK(width))
        throw new Error(
          'Enter a width greater than 0 and at most 10 mm, with up to 6 decimal places.',
        );
      if (!ids.length || new Set(ids).size !== ids.length)
        throw new Error('Select one or more distinct segments.');
      const selected = ids
        .map((id) => {
          const t = spans.get(id);
          if (!t) throw new Error('Only existing straight copper segments can be edited.');
          return t;
        })
        .sort((a, b) => a.pos - b.pos);
      let offset = 0;
      const pieces: string[] = [];
      for (const t of selected) {
        pieces.push(text.slice(offset, t.pos), width);
        offset = t.pos + t.value.length;
      }
      return pieces.join('') + text.slice(offset);
    },
  };
}
