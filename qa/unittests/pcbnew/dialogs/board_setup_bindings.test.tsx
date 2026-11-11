// @vitest-environment happy-dom
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
// Portions derived from KiCad, copyright The KiCad Developers. See NOTICE.md.
/**
 * What each control on the selection filter, Board Finish and Physical Stackup writes, and the
 * stackup's labels: a sublayer's "(i/n)", thicknesses in the frame's units, Remove's enable.
 */
import { SetMessageDialogPresenter } from '@ziroeda/common/confirm.js';
import { PanelSetupNetclasses } from '@ziroeda/common/dialogs/panel_setup_netclasses.js';
import { blankNetClass, defaultNetClasses } from '@ziroeda/common/project/net_settings.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type JSX, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BoardFinish,
  PanelPcbBoardFinish,
} from '@ziroeda/pcbnew/board_stackup_manager/panel_board_finish.js';
import {
  PanelPcbStackup,
  type PhysicalStackup,
} from '@ziroeda/pcbnew/board_stackup_manager/panel_board_stackup.js';
import {
  DEFAULT_SELECTION_FILTER_OPTIONS,
  SelectionFilterPanel,
} from '@ziroeda/pcbnew/widgets/panel_selection_filter.js';
import { freshBoardSetup } from '../../designer/board_setup_test_utils.js';

afterEach(cleanup);

it('moves the original name with the renamed panel row and updates its pattern', () => {
  const data = defaultNetClasses();
  for (const name of ['Power', 'Signal'])
    data.classes.push({ ...blankNetClass(name), originalName: name });
  data.assignments = [{ pattern: 'V*', netClass: 'Power' }];
  let latest = data;
  function Harness(): JSX.Element {
    const [value, setValue] = useState(data);
    latest = value;
    return <PanelSetupNetclasses value={value} onChange={setValue} />;
  }
  render(<Harness />);
  const cell = document.querySelector('table[aria-label="Netclasses"] td[data-col="0"]')!;
  fireEvent.mouseDown(cell, { button: 0 });
  fireEvent.mouseUp(cell);
  const input = cell.querySelector('input')!;
  fireEvent.change(input, { target: { value: 'Rails' } });
  fireEvent.blur(input);
  fireEvent.click(screen.getByRole('button', { name: 'Move down' }));
  expect(latest.classes.slice(1).map(({ name, originalName }) => [name, originalName])).toEqual([
    ['Signal', 'Signal'],
    ['Rails', 'Power'],
  ]);
  expect(latest.assignments).toEqual([{ pattern: 'V*', netClass: 'Rails' }]);
});

const pick = (aCombo: HTMLElement, aLabel: string): void => {
  fireEvent.click(aCombo.closest('.ze-combo') as HTMLElement);
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent === aLabel,
  );
  fireEvent.mouseDown(option as HTMLElement);
};

describe('PANEL_SELECTION_FILTER', () => {
  it('All items turns every category off, and Vias is vias alone', () => {
    let last = new Set(DEFAULT_SELECTION_FILTER_OPTIONS);
    render(<SelectionFilterPanel filter={last} onChange={(n) => (last = n)} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'All items' }));
    expect(last.size).toBe(0);
    cleanup();
    last = new Set(DEFAULT_SELECTION_FILTER_OPTIONS);
    render(<SelectionFilterPanel filter={last} onChange={(n) => (last = n)} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Vias' }));
    expect(last.has('vias')).toBe(false);
    expect(last.has('tracks')).toBe(true);
  });
});

describe('PANEL_SETUP_BOARD_FINISH', () => {
  it('Edge card connectors writes its choice', () => {
    let last: BoardFinish = {
      platedBoardEdge: false,
      copperFinish: 'None',
      edgeCardConnectors: 'None',
    };
    render(<PanelPcbBoardFinish value={last} onChange={(v) => (last = v)} />);
    pick(screen.getByLabelText('Edge card connectors'), 'Yes, bevelled');
    expect(last.edgeCardConnectors).toBe('Yes, bevelled');
  });
});

describe('PANEL_SETUP_BOARD_STACKUP', () => {
  function Harness({
    initial,
    units = 'mm',
  }: {
    initial: PhysicalStackup;
    units?: 'mm' | 'mils';
  }): JSX.Element {
    const [v, setV] = useState(initial);
    return <PanelPcbStackup value={v} onChange={setV} units={units} />;
  }
  const withSublayer = (): PhysicalStackup => {
    const v = freshBoardSetup().physicalStackup;
    const i = v.layers.findIndex((l) => l.type === 'Core' || l.type === 'Prepreg');
    v.layers[i] = { ...v.layers[i]!, sublayers: [{ material: 'FR4', thicknessMM: 0.1 }] };
    return v;
  };

  it('names a dielectric of several sublayers "(i/n)"', () => {
    render(<Harness initial={withSublayer()} />);
    expect(screen.getByText('Dielectric 1  (1/2)', { normalizer: (t) => t })).toBeTruthy();
    expect(screen.getByText('Dielectric 1  (2/2)', { normalizer: (t) => t })).toBeTruthy();
  });

  it('shows thicknesses in the frame units', () => {
    render(<Harness initial={freshBoardSetup().physicalStackup} units="mils" />);
    expect(
      (screen.getByRole('textbox', { name: 'F.Cu thickness' }) as HTMLInputElement).value,
    ).toMatch(/mils$/);
  });

  it('Remove Dielectric Layer is enabled only while a dielectric has sublayers', () => {
    render(<Harness initial={freshBoardSetup().physicalStackup} />);
    expect(
      (screen.getByRole('button', { name: 'Remove Dielectric Layer...' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    cleanup();
    render(<Harness initial={withSublayer()} />);
    expect(
      (screen.getByRole('button', { name: 'Remove Dielectric Layer...' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe('Adjust Dielectric Thickness (onAdjustDielectricThickness)', () => {
  function Harness({ units = 'mm' as 'mm' | 'mils' }): JSX.Element {
    const [v, setV] = useState(freshBoardSetup().physicalStackup);
    return (
      <>
        <PanelPcbStackup value={v} onChange={setV} units={units} />
        <output data-testid="core">
          {v.layers.find((l) => l.type === 'Core')?.thicknessMM ?? ''}
        </output>
      </>
    );
  }

  it('asks in a wxTextEntryDialog in the frame units, then spreads the rest over the cores', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust Dielectric Thickness' }));
    expect(screen.getByText('Adjust Unlocked Dielectric Layers')).toBeTruthy();
    expect(
      screen.getByText(/^Enter expected board thickness \(min value [\d.]+ mm\):$/),
    ).toBeTruthy();
    const before = screen.getByTestId('core').textContent;
    fireEvent.change(screen.getByRole('textbox', { name: /Enter expected board thickness/ }), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByText('Adjust Unlocked Dielectric Layers')).toBeNull();
    expect(screen.getByTestId('core').textContent).not.toBe(before);
  });

  it('states the minimum in the frame units, as m_frame->StringFromValue does', () => {
    render(<Harness units="mils" />);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust Dielectric Thickness' }));
    expect(
      screen.getByText(/^Enter expected board thickness \(min value [\d.]+ mils\):$/),
    ).toBeTruthy();
  });

  it('refuses a thickness under the fixed layers with the wxMessageBox text', () => {
    const msgs: string[] = [];
    SetMessageDialogPresenter(async (a) => {
      msgs.push(a.message);
      return 0;
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust Dielectric Thickness' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Enter expected board thickness/ }), {
      target: { value: '0.01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/^Value too small \(min value [\d.]+ mm\)\.$/);
  });
});
