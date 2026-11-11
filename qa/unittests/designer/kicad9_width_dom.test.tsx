// @vitest-environment happy-dom
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import WidthEditor9 from '@ziroeda/designer/src/editors/pcb/WidthEditor9.js';
import { startDownload } from '@ziroeda/designer/src/output_downloads.js';

vi.mock('@ziroeda/designer/src/output_downloads.js', () => ({ startDownload: vi.fn() }));
const bytes = new Uint8Array(readFileSync('data/pcbnew/kiziro9/handoff.kicad_pcb'));
const text = new TextDecoder().decode(bytes);
const file = { name: 'handoff.kicad_pcb', bytes, text };
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('exposes no save or settings path after a failed open, even on Ctrl+S and pagehide', () => {
  const save = vi.fn();
  const damaged = text + ')';
  const ui = render(
    <WidthEditor9
      file={{ ...file, text: damaged, bytes: new TextEncoder().encode(damaged) }}
      save={save}
      readOnly={false}
      onExit={() => {}}
    />,
  );
  expect(ui.getByRole('alert').textContent).toContain('No files were written');
  expect(ui.queryByRole('button')).toBeNull();
  fireEvent.keyDown(window, { key: 's', ctrlKey: true });
  window.dispatchEvent(new Event('pagehide'));
  expect(save).not.toHaveBeenCalled();
  expect(startDownload).not.toHaveBeenCalled();
});

it('does not flush a draft, refuses invalid copies, downloads exact bytes, and reports failed saves', async () => {
  const save = vi.fn().mockRejectedValue(new Error('storage unavailable'));
  const ui = render(<WidthEditor9 file={file} readOnly={false} save={save} onExit={() => {}} />);
  for (const box of ui.getAllByRole('checkbox')) fireEvent.click(box);
  const input = ui.getByLabelText('New width (mm)');
  fireEvent.change(input, { target: { value: '-1' } });
  fireEvent.click(ui.getByRole('button', { name: /Save a Copy/ }));
  expect(ui.getByRole('status').textContent).toMatch(/Not saved/);
  expect(startDownload).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '0.7' } });
  window.dispatchEvent(new Event('pagehide'));
  document.dispatchEvent(new Event('visibilitychange'));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(ui.getByRole('button', { name: /Save a Copy/ }));
  const expected = text.replaceAll('(width 0.5)', '(width 0.7)');
  expect(startDownload).toHaveBeenCalledWith(
    expect.objectContaining({ bytes: new TextEncoder().encode(expected) }),
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 's', ctrlKey: true });
  await waitFor(() =>
    expect(ui.getByRole('status').textContent).toContain('Not saved. storage unavailable'),
  );
  expect(save).toHaveBeenCalledExactlyOnceWith(expected);
});
