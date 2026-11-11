// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
// Portions derived from KiCad, copyright The KiCad Developers. See NOTICE.md.
/**
 * `PCB_EDIT_FRAME::OpenProjectFiles` (files.cpp:906-908): once the board is
 * up and its nets are known, `LoadProjectSettings()` and `LoadDrawingSheet()`
 * read the project's `.kicad_prl` into the frame. A later reload of the same
 * files (Board Setup's OK, another session) does not: nothing upstream
 * re-reads local settings then.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GAL_LAYER_ID, PCB_LAYER_ID } from '@ziroeda/common/layer_id.js';
import { blankNetClass } from '@ziroeda/common/project/net_settings.js';
import { LSET } from '@ziroeda/common/lset.js';
import {
  UserVisbilityLayers,
  VisibilityLayerFromRenderLayer,
  VisibilityLayerToString,
} from '@ziroeda/common/settings/layer_settings_utils.js';
import { DS_DATA_MODEL } from '@ziroeda/common/drawing_sheet/ds_data_model.js';
import { MEMORY_FILESYSTEM, wxMountFileSystem } from '@ziroeda/wx/filefn.js';
import { PGM_BASE, Pgm, SETTINGS_MANAGER, SetPgm } from '@ziroeda/common/pgm_base.js';
import { HIGH_CONTRAST_MODE } from '@ziroeda/common/project/board_project_settings.js';
import { PCB_EDIT_FRAME } from '@ziroeda/pcbnew/pcb_edit_frame.js';
import type { PCB_DRAW_PANEL_GAL } from '@ziroeda/pcbnew/pcb_draw_panel_gal.js';
import { PCB_RENDER_SETTINGS } from '@ziroeda/pcbnew/pcb_painter.js';
import { ParseBoard } from '@ziroeda/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.js';
import {
  BoardSetupFromWindow,
  BoardSetupToWindow,
  editedBoardSetupFields,
} from '@ziroeda/pcbnew/dialogs/dialog_board_setup.js';
import { PCB_SCREEN } from '@ziroeda/pcbnew/pcb_screen.js';
import { PCBNEW_SETTINGS } from '@ziroeda/pcbnew/pcbnew_settings.js';

const BOARD = `(kicad_pcb (version 20260206) (generator "pcbnew")
  (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "") (net 1 "GND") (net 2 "VCC")
  (segment (start 1 2) (end 5 2) (width 0.25) (layer "F.Cu") (net "GND")))
`;

const PRO = JSON.stringify({ meta: { filename: 'x.kicad_pro', version: 3 } });
const PRL = JSON.stringify({
  meta: { filename: 'x.kicad_prl', version: 5 },
  board: {
    opacity: { tracks: 0.25, zones: 0.75 },
    hidden_nets: ['GND'],
    visible_items: [],
  },
});

function frameOnBoard(): { frame: PCB_EDIT_FRAME; render: PCB_RENDER_SETTINGS } {
  SetPgm(new PGM_BASE(null, new SETTINGS_MANAGER()));
  const frame = new PCB_EDIT_FRAME({
    settings: () => new PCBNEW_SETTINGS(),
    onModify: () => {},
    onUndoRedoIncomplete: () => {},
    createDrcDialog: () => {
      throw new Error('no DRC dialog here');
    },
    isSingle: () => true,
    fetchNetlistFromSchematic: () => false,
    schematicNetlistText: () => null,
    projectText: () => null,
    showExchangeFootprintsDialog: () => {},
    findDialogRects: () => [],
    setViewCenter: () => {},
    editZoneParams: () => {},
    selectCopperLayerPair: () => {},
    updatePcbFromSchematic: () => {},
  });
  frame.SetBoard(ParseBoard(BOARD, '/p/x.kicad_pcb'), false);
  frame.SetScreen(new PCB_SCREEN({ x: 297000000, y: 210000000 }));
  const render = new PCB_RENDER_SETTINGS();
  const view = {
    GetPainter: () => ({ GetSettings: () => render }),
    UpdateDisplayOptions: () => {},
    SetMirror: () => {},
    IsMirroredY: () => false,
    RecacheAllItems: () => {},
    UpdateAllItemsConditionally: () => {},
    SetLayerVisible: () => {},
    UpdateAllItems: () => {},
  };
  frame.SetCanvas({
    // `GetViewControls()->GetCursorPosition()`, which UpdateStatusBar reads.
    GetViewControls: () => ({ GetCursorPosition: () => ({ x: 0, y: 0 }) }),
    GetView: () => view,
    SetHighContrastLayer: () => {},
    Refresh: () => {},
    ForceRefresh: () => {},
    GetGAL: () => ({}),
  } as unknown as PCB_DRAW_PANEL_GAL);
  return { frame, render };
}

const FILES = [
  { name: 'x.kicad_pro', text: PRO },
  { name: 'x.kicad_prl', text: PRL },
];

afterEach(() => SetPgm(null));

describe('File > Save after loading project settings', () => {
  const full = UserVisbilityLayers()
    .Seq()
    .map((layer) => VisibilityLayerToString(VisibilityLayerFromRenderLayer(layer)!));
  it.each(
    [full, ['tracks', 'grid'], ['none'], undefined].map((items) => ({ items })),
  )('retains the open visibility through a no-op save, width edit and one toggle ($items)', ({
    items,
  }) => {
    const { frame } = frameOnBoard();
    const mask = new LSET([PCB_LAYER_ID.B_Cu, PCB_LAYER_ID.In2_Cu]).FmtHex();
    const files = [{ name: 'x.kicad_pro', text: PRO }];
    if (items)
      files.push({
        name: 'x.kicad_prl',
        text: JSON.stringify({
          meta: { version: 5 },
          board: { visible_items: items, visible_layers: mask, auto_track_width: false },
        }),
      });
    frame.SyncProjectSettingsIntoBoard(files, 'x', false, '/p');
    const board = frame.GetBoard()!;
    const expected = new Set(items ?? full);
    expect(full).toHaveLength(22);
    function checkSave() {
      const saved = frame.SaveProjectLocalSettings()!.prl;
      expect(saved.meta).toMatchObject({ version: 5 });
      const state = saved.board as { visible_items: string[] };
      expect(new Set(state.visible_items)).toEqual(expected);
      expect(state).toMatchObject({
        visible_layers: items ? mask : LSET.AllLayersMask().FmtHex(),
        auto_track_width: !items,
      });
    }
    checkSave();
    board.Tracks()[0]!.SetWidth(450000);
    checkSave();
    const show = !board.IsElementVisible(GAL_LAYER_ID.LAYER_VIAS);
    board.SetElementVisibility(GAL_LAYER_ID.LAYER_VIAS, show);
    expected.delete('none');
    if (show) expected.add('vias');
    else expected.delete('vias');
    frame.SyncProjectSettingsIntoBoard(files, 'x', true, '/p');
    checkSave();
  });

  it('keeps unknown fields with a renamed and moved Board Setup row', () => {
    const { frame } = frameOnBoard();
    const assignments = { GND: ['Power', 'Signal'] };
    const source = {
      net_settings: {
        classes: [
          { name: 'Default' },
          { name: 'Power', vendor: { code: 1 } },
          { name: 'Signal', vendor: { code: 2 } },
        ],
        netclass_assignments: assignments,
        netclass_patterns: [{ pattern: 'V*', netclass: 'Power' }],
      },
    };
    const files = [{ name: 'x.kicad_pro', text: JSON.stringify(source) }];
    frame.SyncProjectSettingsIntoBoard(files, 'x', true, '/p');
    const board = frame.GetBoard()!;
    const initial = BoardSetupToWindow(board, frame.Prj(), '');
    const draft = structuredClone(initial);
    const [base, power, signal] = draft.netClasses.classes;
    expect(power!.originalName).toBe('Power');
    power!.name = 'Rails';
    draft.netClasses.classes = [base!, signal!, power!, blankNetClass('Power')];
    draft.netClasses.assignments[0]!.netClass = 'Rails';
    expect(frame.NetclassRenameError(draft.netClasses.classes)).toBeNull();
    BoardSetupFromWindow(draft, board, frame.Prj(), editedBoardSetupFields(initial, draft));
    const [write] = frame.SaveExplicitProjectFiles(files, 'x', '', draft.netClasses.classes);
    const saved = JSON.parse(write!.text).net_settings;
    expect(saved.classes).toEqual([
      expect.objectContaining({ name: 'Default' }),
      expect.objectContaining({ name: 'Signal', vendor: { code: 2 } }),
      expect.objectContaining({ name: 'Rails', vendor: { code: 1 } }),
      expect.objectContaining({ name: 'Power' }),
    ]);
    expect(saved.classes[3]).not.toHaveProperty('vendor');
    expect(saved.classes[2]).not.toHaveProperty('originalName');
    expect(saved.netclass_assignments).toEqual(assignments);
    expect(saved.netclass_patterns).toEqual([{ pattern: 'V*', netclass: 'Rails' }]);
    expect(frame.SaveExplicitProjectFiles(files, 'x')).toEqual([]);
  });

  it('preserves the source through Board Setup OK, a net colour edit, repeated saves and reload', () => {
    const { frame, render } = frameOnBoard();
    const source = {
      meta: { filename: 'x.kicad_pro', version: 3 },
      board: {
        design_settings: {
          defaults: { pads: { drill: 0.8, width: 1.27, height: 1.27, vendor: 'keep' } },
          teardrop_parameters: [{ td_target_name: 'td_round_shape', td_enabled: false }],
        },
      },
      net_settings: {
        net_colors: { OFF_BOARD: 'rgb(1, 2, 3)' },
        netclass_assignments: {},
        vendor: null,
      },
      future: { empty: {}, list: [], unset: null },
    };
    const name = 'x.kicad_pro';
    const original = JSON.stringify(source, null, 4) + '\r\n';
    const fs = new MEMORY_FILESYSTEM();
    fs.Write(name, new TextEncoder().encode(original));
    const read = () => new TextDecoder().decode(fs.Read(name)!);
    const unmount = wxMountFileSystem('/p', fs);
    try {
      frame.SyncProjectSettingsIntoBoard([{ name, text: original }], 'x', false, '/p');
      const board = frame.GetBoard()!;
      const values = BoardSetupToWindow(board, frame.Prj(), '');
      const draft = structuredClone(values);
      BoardSetupFromWindow(draft, board, frame.Prj(), editedBoardSetupFields(values, draft));
      board.SynchronizeTuningProfileProperties();
      board.SynchronizeNetsAndNetClasses(true);
      frame.OnBoardLoaded('', 'x.kicad_dru');
      const explicitSave = (rules?: string) =>
        frame.SaveExplicitProjectFiles([{ name, text: read() }], 'x', rules);
      expect(explicitSave('')).toEqual([]);
      const rules = '(version 1)\n';
      expect(explicitSave(rules)).toEqual([{ name: 'x.kicad_dru', text: rules }]);
      expect(read()).toBe(original);

      const red = { r: 1, g: 0, b: 0, a: 1 };
      board.GetDesignSettings().m_NetSettings.GetNetColorAssignments().set('GND', red);
      const expected = structuredClone(source);
      Object.assign(expected.net_settings.net_colors, { GND: 'rgb(255, 0, 0)' });
      const writes = explicitSave();
      const written = read();
      expect(writes).toEqual([{ name, text: written }]);
      expect(JSON.parse(written)).toEqual(expected);
      expect(frame.SaveProjectLocalSettings()?.pro).toBeNull(); // before the painter catches up
      render.GetNetColorMap().set(board.GetNetInfo().GetNetItem('GND')!.GetNetCode(), red);
      expect(frame.SaveProjectLocalSettings()?.pro).toBeNull();
      expect(explicitSave()).toEqual([]);

      frame.SyncProjectSettingsIntoBoard([{ name, text: read() }], 'x', true, '/p');
      expect(
        frame.Prj().GetProjectFile().NetSettings().GetNetColorAssignments().get('GND'),
      ).toEqual(red);
      expect(frame.SaveProjectLocalSettings()?.pro).toBeNull();
      expect(read()).toBe(written);

      const initial = BoardSetupToWindow(board, frame.Prj(), '');
      const changed = { ...initial, trackWidthsMM: [0.42] };
      BoardSetupFromWindow(changed, board, frame.Prj(), editedBoardSetupFields(initial, changed));
      const updated = structuredClone(expected);
      Object.assign(updated.board.design_settings, { track_widths: [0, 0.42] });
      expect(explicitSave()).toHaveLength(1);
      expect(JSON.parse(read())).toEqual(updated);
      expect(frame.SaveProjectLocalSettings()?.pro).toBeNull();
    } finally {
      unmount();
    }
  });

  it('leaves project bytes alone after a track width edit, while saving local visibility', () => {
    const { frame, render } = frameOnBoard();
    const pro =
      JSON.stringify(
        {
          board: {
            design_settings: {
              defaults: { pads: { drill: 0.8, height: 1.27, width: 1.27 } },
              teardrop_parameters: ['td_round_shape', 'td_rect_shape', 'td_track_end'].map(
                (td_target_name) => ({ td_target_name, td_enabled: false }),
              ),
            },
          },
          net_settings: { net_colors: {}, netclass_assignments: {} },
        },
        null,
        4,
      ) + '\r\n';
    const bytes = new TextEncoder().encode(pro);
    const fs = new MEMORY_FILESYSTEM();
    fs.Write('x.kicad_pro', bytes);
    const unmount = wxMountFileSystem('/p', fs);
    try {
      frame.SyncProjectSettingsIntoBoard([{ name: 'x.kicad_pro', text: pro }], 'x', false, '/p');
      const board = frame.GetBoard()!;
      board.Tracks()[0]!.SetWidth(400000);
      render.GetHiddenNets().add(board.GetNetInfo().GetNetItem('GND')!.GetNetCode());
      const saved = frame.SaveProjectLocalSettings()!;
      expect(saved.pro).toBeNull(); // No host write either.
      expect(fs.Read('x.kicad_pro')).toEqual(bytes);
      expect(saved.prl).toMatchObject({ board: { hidden_nets: ['GND'] } });
    } finally {
      unmount();
    }
  });

  it('writes a changed project setting once and keeps it on the next board save', () => {
    const { frame } = frameOnBoard();
    frame.SyncProjectSettingsIntoBoard(FILES, 'x', false, '/p');
    frame.GetDesignSettings().m_TrackWidthList = [0, 420000];
    expect(frame.SaveProjectLocalSettings()?.pro).toMatchObject({
      board: { design_settings: { track_widths: [0, 0.42] } },
    });
    expect(frame.SaveProjectLocalSettings()?.pro).toBeNull();
  });

  it('distinguishes applying reloaded project colours from editing them in the frame', () => {
    const { frame, render } = frameOnBoard();
    frame.SyncProjectSettingsIntoBoard(FILES, 'x', false, '/p');
    const gnd = frame.GetBoard()!.GetNetInfo().GetNetItem('GND')!.GetNetCode();
    const pro = JSON.stringify({ net_settings: { net_colors: { GND: 'rgb(255, 0, 0)' } } });
    frame.SyncProjectSettingsIntoBoard([{ name: 'x.kicad_pro', text: pro }], 'x', true, '/p');
    render.GetNetColorMap().set(gnd, { r: 1, g: 0, b: 0, a: 1 });
    expect(frame.SaveProjectLocalSettings()?.pro).toBeNull();
    render.GetNetColorMap().clear();
    expect(frame.SaveProjectLocalSettings()?.pro).toMatchObject({
      net_settings: { net_colors: null },
    });
  });
});

describe('PCB_EDIT_FRAME::SyncProjectSettingsIntoBoard, the open path', () => {
  it('loads the .kicad_prl into the frame after the board is bound', () => {
    const { frame, render } = frameOnBoard();
    frame.SyncProjectSettingsIntoBoard(FILES, 'x', false, '/p');
    const o = frame.GetDisplayOptions();
    expect(o.m_TrackOpacity).toBe(0.25);
    expect(o.m_ZoneOpacity).toBe(0.75);
    expect(o.m_ContrastModeDisplay).toBe(HIGH_CONTRAST_MODE.NORMAL);
    const gnd = frame.GetBoard()!.GetNetInfo().GetNetItem('GND')!.GetNetCode();
    expect([...render.GetHiddenNets()]).toEqual([gnd]);
  });

  it('a reload for Board Setup does not re-read local settings', () => {
    const { frame, render } = frameOnBoard();
    frame.SyncProjectSettingsIntoBoard(FILES, 'x', true, '/p');
    expect(frame.GetDisplayOptions().m_TrackOpacity).toBe(1);
    expect(render.GetHiddenNets().size).toBe(0);
  });

  it('a board of the project already active keeps it; Board Setup and another project reload', () => {
    const { frame } = frameOnBoard();
    const manager = Pgm().GetSettingsManager();
    manager.LoadProject('/p/x.kicad_pro', JSON.parse(PRO));
    const active = manager.Prj();

    // files.cpp:594 - no UnloadProject/LoadProject, so no LIBRARY_MANAGER::ProjectChanged.
    frame.SyncProjectSettingsIntoBoard(FILES, 'x', false, '/p');
    expect(manager.Prj() === active).toBe(true);
    expect(frame.GetBoard()!.GetProject() === active).toBe(true);

    frame.SyncProjectSettingsIntoBoard(FILES, 'x', true, '/p');
    const reread = manager.Prj();
    expect(reread === active).toBe(false);
    expect(reread.GetProjectFullName()).toBe('/p/x.kicad_pro');

    frame.SyncProjectSettingsIntoBoard(FILES, 'x', false, '/q');
    expect(manager.Prj().GetProjectFullName()).toBe('/q/x.kicad_pro');
  });

  it("reads the project's drawing sheet from the project files", () => {
    const { frame } = frameOnBoard();
    const wks = `(kicad_wks (version 20220228) (generator "pl_editor")
  (setup (textsize 1.5 1.5) (linewidth 0.15) (textlinewidth 0.15)
    (left_margin 37) (right_margin 11) (top_margin 12) (bottom_margin 13)))`;
    const fs = new MEMORY_FILESYSTEM();
    fs.Write('mine.kicad_wks', new Uint8Array());
    const unmount = wxMountFileSystem('/p', fs);
    try {
      const pro = JSON.stringify({ pcbnew: { page_layout_descr_file: 'mine.kicad_wks' } });
      frame.SyncProjectSettingsIntoBoard(
        [
          { name: 'x.kicad_pro', text: pro },
          { name: 'mine.kicad_wks', text: wks },
        ],
        'x',
        false,
        '/p',
      );
      expect(DS_DATA_MODEL.GetTheInstance().GetLeftMargin()).toBe(37);
    } finally {
      unmount();
      DS_DATA_MODEL.GetTheInstance().SetDefaultLayout();
    }
  });
});
