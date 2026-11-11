// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
/**
 * TRANSITIONAL (stage S1a of docs/eeschema-live-stage0.md; deleted at S7). No KiCad
 * counterpart: the bridge from the record model the window still edits to the live
 * `SCHEMATIC` the KiCad classes run on (and back, for edits made on the live model), the way pcbnew's `commitViewToBoard` bridged its
 * view while #636 moved callers over.
 *
 * The window's records are written out in KiCad's own format and opened through
 * `SCH_EDIT_FRAME::OpenProjectFiles`, so the live model is exactly what KiCad would have
 * after opening those files. It is rebuilt only when asked for and only if a sheet's
 * record changed since the last build: re-opening a large hierarchy on every edit would
 * cost the edit.
 */
import { PRETTIFIED_STRING_FORMATTER } from '@ziroeda/common/richio.js';
import type { SCH_EDIT_FRAME } from './sch_edit_frame.js';
import type { Schematic } from './types.js';
import { isPreservedVersion, recordFromSource, schematicSaveSource, serializeSchematic } from './sch_io/sexpr/schematic-text.js';
import { parse, atom, list, head, isList, type SList, type SNode } from '@ziroeda/sexpr/index.js';
import { arg, childNamed, stringField } from '@ziroeda/sexpr/query.js';
import { fieldIsPrivate, readSchematic } from './sch_io/sexpr/read-schematic.js';
import { SCH_IO_KICAD_SEXPR } from './sch_io/kicad_sexpr/sch_io_kicad_sexpr.js';
import { SCH_SCREENS, type SCH_SCREEN } from './sch_screen.js';
import type { SCHEMATIC, SCHEMATIC_LISTENER } from './schematic.js';
import type { SCH_SHEET } from './sch_sheet.js';
import type { SCH_ITEM } from './sch_item.js';
import { Pgm } from '@ziroeda/common/pgm_base.js';
import type { PROJECT } from '@ziroeda/common/project.js';
import { LoadSchematic } from './eeschema_helpers.js';
import { KICAD_T } from '@ziroeda/core/typeinfo.js';
import type { SCH_MARKER } from './sch_marker.js';
import { SCH_NAVIGATE_TOOL } from './tools/sch_navigate_tool.js';

export interface RecordProject {
  /**
   * The project folder's absolute path, `/<projectName>`: the same one pcbnew loads the
   * project under (pcbnew/files.ts), so the settings manager both editors share holds one
   * project, not two that unload each other.
   */
  dir: string;
  /** A tool or rollback may still own a partially changed live model. */
  assertCanSave?: () => void;
  /** Each sheet's record by its file name (relative to the project folder). */
  docs: ReadonlyMap<string, Schematic>;
  /** The root sheet's file name. */
  root: string;
  /** The project's other files the load reads (the `.kicad_pro`, `.kicad_prl`), by name. */
  files: readonly { name: string; text: string }[];
}

const base = (aName: string) => aName.replace(/\\/g, '/').replace(/^.*\//, '');

/**
 * Open \a aProject's records on \a aFrame through `OpenProjectFiles`; returns the live
 * schematic, or null when it could not be opened.
 */
export function openRecordsLive(aFrame: SCH_EDIT_FRAME, aProject: RecordProject): SCHEMATIC | null {
  const texts = new Map<string, string>();

  for (const f of aProject.files) texts.set(`${aProject.dir}/${base(f.name)}`, f.text);

  const olderSources = new Map<string, Schematic>();
  for (const [file, sheet] of aProject.docs) {
    const absolute = `${aProject.dir}/${file}`;
    texts.set(absolute, serializeSchematic(sheet));
    if (isPreservedVersion(sheet.version)) olderSources.set(absolute, sheet);
  }

  const ok = aFrame.OpenProjectFiles(
    [`${aProject.dir}/${aProject.root}`],
    0,
    (p) => texts.get(p) ?? null,
  );

  if (!ok) return null;
  const schematic = aFrame.Schematic();
  if (!olderSources.size) {
    delete aFrame.recordSaveSources;
    return schematic;
  }
  const loaded = new WeakSet<SCH_SCREEN>();
  recordHierarchies.set(schematic, loaded);
  aFrame.recordSaveSources = () => {
    aProject.assertCanSave?.();
    if (aFrame.Schematic() !== schematic)
      throw new Error('Cannot save until the source records are reopened');
    return validatedRecordSources(schematic);
  };
  const hierarchy = schematic.Hierarchy();
  const io = new SCH_IO_KICAD_SEXPR();
  const screens = new SCH_SCREENS(schematic.Root());
  for (let screen = screens.GetFirst(); screen; screen = screens.GetNext()) {
    const absolute = screen.GetFileName().replace(/\\/g, '/');
    if (texts.has(absolute)) loaded.add(screen);
    const record = olderSources.get(absolute);
    if (!record) continue;
    const live = liveProjection(io, hierarchy.FindSheetForScreen(screen).Last()!, schematic);
    oldScreens.set(screen, { record, live, opened: { record, live } });
  }
  return schematic;
}

/**
 * \a aProject's records loaded as a schematic of their own (`EESCHEMA_HELPERS::LoadSchematic`,
 * what kicad-cli runs), under \a aPrj: for a check that must not touch the editor's screens.
 */
export function loadRecordsDetached(aProject: RecordProject, aPrj: PROJECT): SCHEMATIC | null {
  const texts = new Map<string, string>();

  for (const f of aProject.files) texts.set(`${aProject.dir}/${base(f.name)}`, f.text);

  for (const [file, sheet] of aProject.docs)
    texts.set(`${aProject.dir}/${file}`, serializeSchematic(sheet));

  return LoadSchematic(`${aProject.dir}/${aProject.root}`, aPrj, (p) => texts.get(p) ?? null);
}

/**
 * The live mirror of a window's records: `get()` answers the live schematic, rebuilding it
 * first when any sheet's record is not the one it was built from.
 */
export class LIVE_SCHEMATIC_MIRROR {
  private m_builtFrom: Map<string, Schematic> | null = null;
  private m_live: SCHEMATIC | null = null;
  /** The `.kicad_pro` text the live project last read or wrote. */
  private m_proText: string | null = null;
  /** The screens a commit has touched since TakeCommittedScreens last read them. */
  private m_committed = new Set<SCH_SCREEN>();
  /** Hears every SCH_COMMIT on the live schematic (SCHEMATIC::OnItemsChanged and the rest). */
  private readonly m_listener: SCHEMATIC_LISTENER = {
    OnSchItemsAdded: (_aSch, aItems) => this.noteCommitted(aItems),
    OnSchItemsRemoved: (_aSch, aItems) => this.noteCommitted(aItems),
    OnSchItemsChanged: (_aSch, aItems) => this.noteCommitted(aItems),
  };

  constructor(
    private readonly m_frame: SCH_EDIT_FRAME,
    private readonly m_project: () => RecordProject | null,
    /** Told of each rebuild, with the schematic that replaced the last one. */
    private readonly m_onRebuilt: (aSchematic: SCHEMATIC) => void = () => {},
  ) {}

  private noteCommitted(aItems: readonly SCH_ITEM[]): void {
    for (const item of aItems) {
      let parent = item.GetParent();

      while (parent && parent.Type() !== KICAD_T.SCH_SCREEN_T) parent = parent.GetParent();

      if (parent) this.m_committed.add(parent as unknown as SCH_SCREEN);
    }
  }

  /**
   * The screens the live commits since the last call changed - every sheet a multi-sheet commit
   * (the Symbol Fields Table's, say) reached, which OnModify's current screen alone misses.
   */
  TakeCommittedScreens(): Set<SCH_SCREEN> {
    const out = this.m_committed;
    this.m_committed = new Set();
    return out;
  }

  /** Discard a failed edit on the next rebuild, retaining the outgoing screen for redraw. */
  Invalidate(): void {
    this.m_builtFrom = null;
  }

  /**
   * The window has taken \a aDocs, records written from this live model (liveScreensToRecords):
   * the live model already is what they say, so they count as built from and the next get()
   * does not reopen the project for them.
   */
  Adopt(aDocs: ReadonlyMap<string, Schematic>): void {
    if (!this.m_builtFrom) return;

    for (const [file, doc] of aDocs) this.m_builtFrom.set(file, doc);
  }

  /** The live project wrote \a aText as its `.kicad_pro` (SETTINGS_MANAGER::SaveProject). */
  NoteProjectSaved(aText: string): void {
    this.m_proText = aText;
  }

  get(): SCHEMATIC | null {
    const project = this.m_project();

    if (!project) return null;

    const proText = project.files.find((f) => /\.kicad_pro$/i.test(f.name))?.text ?? null;
    const built = this.m_builtFrom;
    const proChanged = built !== null && proText !== this.m_proText;
    const fresh =
      built !== null &&
      !proChanged &&
      built.size === project.docs.size &&
      [...project.docs].every(([file, doc]) => built.get(file) === doc);

    if (!fresh) {
      const previous = this.m_live;
      const carried = new Map<string, SCH_MARKER[]>();
      const dirty = new Set<string>();

      if (previous) {
        // The excluded markers come back from the settings (OpenProjectFiles'
        // ResolveERCExclusionsPostUpdate); the others ride across on their sheet's file.
        previous.RecordERCExclusions();

        const screens = new SCH_SCREENS(previous.Root());

        for (let screen = screens.GetFirst(); screen; screen = screens.GetNext()) {
          if (!built && screen.IsContentModified()) dirty.add(screen.GetFileName());
          const markers = [...screen.Items().OfType(KICAD_T.SCH_MARKER_T)]
            .map((m) => m as SCH_MARKER)
            .filter((m) => !m.IsExcluded());

          if (markers.length) carried.set(screen.GetFileName(), markers);
        }
      }

      // The window's project file changed under the live project: reload it from the text.
      if (proChanged) {
        const prj = this.m_frame.Prj();

        if (!prj.IsNullProject()) Pgm().GetSettingsManager().UnloadProject(prj);
      }

      // A rebuild is not an open: the Back/Forward history rides across it.
      const navigator = this.m_frame.GetToolManager()?.GetTool(SCH_NAVIGATE_TOOL);
      const history = previous && navigator ? navigator.TakeHistory() : null;

      previous?.RemoveListener(this.m_listener);
      this.m_committed.clear();
      this.m_live = openRecordsLive(this.m_frame, project);
      this.m_live?.AddListener(this.m_listener);
      this.m_builtFrom = new Map(project.docs);
      this.m_proText = proText;

      if (this.m_live) {
        const screens = new SCH_SCREENS(this.m_live.Root());

        for (let screen = screens.GetFirst(); screen; screen = screens.GetNext()) {
          if (dirty.has(screen.GetFileName())) screen.SetContentModified();
          for (const marker of carried.get(screen.GetFileName()) ?? []) screen.Append(marker);
        }

        if (history) navigator!.RestoreHistory(history);

        if (previous && previous !== this.m_live) this.m_onRebuilt(this.m_live);
      }
    }

    return this.m_live;
  }
}

// Compare two projections made by the same live formatter. Only the edit is
// applied to the older record; formatter defaults and load-time repairs are
// not edits. Keep the baseline with the screen so a rebuild cannot reuse it.
interface ScreenBaseline {
  record: Schematic;
  live: SList;
  opened: { record: Schematic; live: SList };
}
const recordHierarchies = new WeakMap<SCHEMATIC, WeakSet<SCH_SCREEN>>();
const oldScreens = new WeakMap<SCH_SCREEN, ScreenBaseline>();

// The shared parts of the two grammars we can edit. Anything else may pass
// through untouched, but a change to it must not be silently discarded.
const editableChildren: Record<string, string> = {
  kicad_sch:
    'paper title_block wire bus junction no_connect label text hierarchical_label global_label sheet symbol',
  title_block: 'title date rev company comment',
  symbol:
    'at property body_style unit instances in_bom on_board dnp exclude_from_sim fields_autoplaced',
  sheet:
    'at size property pin uuid instances stroke fill in_bom on_board dnp exclude_from_sim fields_autoplaced',
  wire: 'pts stroke uuid',
  bus: 'pts stroke uuid',
  pts: 'xy',
  junction: 'at diameter color uuid',
  no_connect: 'at uuid',
  label: 'at effects uuid',
  text: 'at effects uuid exclude_from_sim',
  hierarchical_label: 'at effects uuid shape',
  global_label: 'at effects uuid shape',
  property: 'at effects hide show_name do_not_autoplace',
  pin: 'at effects uuid',
  effects: 'font justify',
  font: 'size thickness bold italic',
  stroke: 'width type color',
  fill: 'color',
  instances: 'project',
  project: 'path',
  path: 'page reference unit',
};

function sameNode(a?: SNode, b?: SNode): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (isList(a) && isList(b))
    return a.items.length === b.items.length && a.items.every((v, i) => sameNode(v, b.items[i]));
  return !isList(a) && !isList(b) && a.value === b.value;
}

function childIndex(node?: SList) {
  const indexed = new Map<string, SList>();
  const counts = new Map<string, number>();
  for (const child of node?.items.filter(isList) ?? []) {
    const name = head(child)!;
    const id =
      stringField(child, 'uuid') ??
      (name === 'property'
        ? arg(child, fieldIsPrivate(child) ? 1 : 0)
        : ['comment', 'project', 'path'].includes(name)
          ? arg(child, 0)
          : '');
    const key = JSON.stringify([name, id]);
    const n = counts.get(key) ?? 0;
    indexed.set(key + n, child);
    counts.set(key, n + 1);
  }
  return indexed;
}

function applyLiveEdit(
  source: SList | undefined,
  before: SList | undefined,
  after: SList | undefined,
  file: string,
  path: string,
): SList | undefined {
  if (sameNode(before, after)) return source;
  const name = head((after ?? before)!)!;
  const fail = (detail: string): never => {
    throw new Error(`${file}: cannot preserve KiCad 9 format for ${path}: ${detail}`);
  };
  if (before && !source && (!after || before.items.some(isList) || name === 'property'))
    fail('no corresponding source item');
  // A deleted item takes its fields with it. Containers such as title_block
  // may also hold source-only fields, so remove only their changed children.
  if (!after && (childNamed(before!, 'uuid') || name === 'property')) return undefined;
  if (name === 'symbol' && !before) fail('new symbol needs a compatible library definition');
  if (name === 'body_style' && after) {
    if (!['1', '2'].includes(arg(after, 0) ?? '')) fail('only convert 1 and 2 are supported');
    return list(atom('convert'), ...after.items.slice(1));
  }

  const original = source ?? list(atom(name));
  const scalars = (n?: SList) => n?.items.filter((it) => !isList(it)) ?? [];
  const oldArgs = scalars(before);
  const newArgs = scalars(after);
  let items = original.items.slice();
  if (after && !sameNode(list(...oldArgs), list(...newArgs))) {
    if (name === 'property' && newArgs.at(-1)?.value === '~')
      fail('literal ~ is empty in this format');
    if (
      name === 'type' &&
      !['solid', 'default', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'].includes(arg(after, 0)!)
    )
      fail('unsupported stroke style');
    // Never overwrite extra source arguments the live projection did not carry.
    const originalArgs = scalars(source);
    if (before && source && originalArgs.length > oldArgs.length)
      fail('additional source arguments');
    const args = newArgs.map((value, i) =>
      originalArgs[i] && sameNode(value, oldArgs[i]) ? originalArgs[i]! : value,
    );
    items = [...args, ...items.filter(isList)];
  }
  const orig = childIndex(original),
    prev = childIndex(before),
    next = childIndex(after);
  for (const key of new Set([...prev.keys(), ...next.keys()])) {
    const b = prev.get(key),
      a = next.get(key);
    if (sameNode(b, a)) continue;
    const child = head((a ?? b)!)!;
    if (!editableChildren[name]?.split(' ').includes(child)) fail(`unsupported change to ${child}`);
    // A property rename appears as a deletion plus an insertion. Without a
    // stable id, its unmodeled source children cannot be assigned safely.
    if (before && after && child === 'property' && (!a || !b))
      fail('adding, removing or renaming a property on an existing item');
    const src =
      name === 'symbol' && child === 'body_style' ? childNamed(original, 'convert') : orig.get(key);
    if (src && !b) fail(`source already contains ${child} absent from the live baseline`);
    const replacement = applyLiveEdit(src, b, a, file, path + '/' + child);
    if (src) items.splice(items.indexOf(src), 1, ...(replacement ? [replacement] : []));
    else if (replacement) items.push(replacement);
  }
  if (!after && !items.some(isList)) return undefined;
  return list(...items);
}

/**
 * The other direction, for edits made on the live model (the AI's hierarchy edits) while the
 * window still edits records: each changed screen written in KiCad's own format
 * (`SCH_IO_KICAD_SEXPR::SaveSchematicFile`, the bytes a save writes) and read back as the
 * window's record, by its file name relative to the project folder. TRANSITIONAL like the rest
 * of this file: gone when the window edits the live model (S7).
 */
export function liveScreensToRecords(
  aFrame: SCH_EDIT_FRAME,
  aScreens: Iterable<SCH_SCREEN>,
  aProjectDir: string,
): Map<string, Schematic> {
  const out = new Map<string, Schematic>();
  const schematic = aFrame.Schematic();
  const hierarchy = schematic.Hierarchy();
  const io = new SCH_IO_KICAD_SEXPR();

  // Advance baselines only if every screen in the edit was representable.
  const pending = new Map<SCH_SCREEN, ScreenBaseline>();
  if (recordHierarchies.has(schematic)) {
    // A caller can report only the parent, even before Hierarchy() has been rebuilt.
    const screens = new SCH_SCREENS(schematic.Root());
    for (let i = 0; i < screens.GetCount(); i++)
      if (!screens.GetSheet(i)!.IsVirtualRootSheet())
        requireLoadedScreen(schematic, screens.GetScreen(i)!);
  }
  for (const screen of aScreens) {
    const path = hierarchy.FindSheetForScreen(screen);
    const sheet = path.Last();

    if (!sheet || sheet.IsVirtualRootSheet()) continue;

    const absolute = screen.GetFileName().replace(/\\/g, '/');
    const file = absolute.startsWith(`${aProjectDir}/`)
      ? absolute.slice(aProjectDir.length + 1)
      : base(absolute);
    const baseline = oldScreens.get(screen);
    const live = baseline
      ? liveProjection(io, sheet, schematic)
      : parse(io.SaveSchematicFile(sheet, schematic));
    let record: Schematic;
    if (baseline) {
      if (sameNode(baseline.live, live)) record = baseline.record;
      else if (sameNode(baseline.opened.live, live)) record = baseline.opened.record;
      else {
        const source = applyLiveEdit(schematicSaveSource(baseline.record), baseline.live, live, file, 'kicad_sch')!;
        record = recordFromSource(source, file);
      }
      pending.set(screen, { record, live, opened: baseline.opened });
    } else {
      if (isPreservedVersion(screen.GetFileFormatVersionAtLoad()))
        throw new Error(`${file}: cannot preserve KiCad 9 format without the original record`);
      record = { ...readSchematic(live), fileName: file };
    }
    out.set(file, record);
  }

  for (const [screen, baseline] of pending) oldScreens.set(screen, baseline);
  return out;
}

// Comparing a projection must not set file-exists or repair groups as a live save does.
function liveProjection(io: SCH_IO_KICAD_SEXPR, sheet: SCH_SHEET, schematic: SCHEMATIC): SList {
  const formatter = new PRETTIFIED_STRING_FORMATTER();
  io.FormatSchematicToFormatter(formatter, sheet, schematic);
  return parse(formatter.Finish());
}

function requireLoadedScreen(schematic: SCHEMATIC, screen: SCH_SCREEN): void {
  const loaded = recordHierarchies.get(schematic);
  if (loaded && !loaded.has(screen))
    throw new Error(
      `${screen.GetFileName()}: cannot save a new sheet without a source record in this KiCad 9 hierarchy`,
    );
}

/** Preflight the whole hierarchy before writing even the first sheet. A save never
 * consumes an edit: OnModify must have adopted it into the window's records first. */
function validatedRecordSources(schematic: SCHEMATIC): Map<SCH_SCREEN, Schematic | null> {
  const sources = new Map<SCH_SCREEN, Schematic | null>();
  const io = new SCH_IO_KICAD_SEXPR();
  const screens = new SCH_SCREENS(schematic.Root());
  for (let i = 0; i < screens.GetCount(); i++) {
    if (screens.GetSheet(i)!.IsVirtualRootSheet()) continue;
    const screen = screens.GetScreen(i)!;
    requireLoadedScreen(schematic, screen);
    const baseline = oldScreens.get(screen);
    if (!baseline) {
      sources.set(screen, null); // an existing sheet outside the two protected versions
      continue;
    }
    const sheet = schematic.Hierarchy().FindSheetForScreen(screen).Last()!;
    if (!sameNode(baseline.live, liveProjection(io, sheet, schematic)))
      throw new Error(
        `${screen.GetFileName()}: live changes have not been accepted into the KiCad 9 source record`,
      );
    sources.set(screen, baseline.record);
  }
  return sources;
}
