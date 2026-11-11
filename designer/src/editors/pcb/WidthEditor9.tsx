// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HomeLink } from '../../ui/HomeLink.js';
import { startDownload } from '../../output_downloads.js';
import type { PickedHomeFile } from '../../home/files.js';
import { openWidthBoard } from './kicad9_width.js';

interface Props {
  file: PickedHomeFile;
  onExit(): void;
  save?: (text: string) => Promise<void>;
  readOnly: boolean;
  notice?: ReactNode;
}

// No PCB frame, editable BOARD, KIWAY player, settings writer or registered
// flush callback. Form values are proposals; only a submit can emit bytes.
export default function WidthEditor9({ file, save, onExit, readOnly, notice }: Props) {
  const opened = useMemo(() => {
    try {
      return { board: openWidthBoard(file.text, file.bytes) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [file.text, file.bytes]);
  const [ids, setIds] = useState<string[]>([]);
  const [width, setWidth] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const name = file.name.split(/[\\/]/).pop()!;
  const draft = width !== '' || ids.length > 0;

  async function submit(copy: boolean) {
    if (writing.current || !opened.board || readOnly) return;
    try {
      const text = copy && !draft ? file.text : opened.board.withWidth(ids, width);
      if (copy || !save) {
        startDownload({
          name,
          bytes: new TextEncoder().encode(text),
          mime: 'application/octet-stream',
        });
        setMessage('Download requested. The project has not been changed.');
      } else if (text === file.text) {
        setMessage('The selected widths are already set to this value.');
      } else {
        writing.current = true;
        setBusy(true);
        setMessage('Saving board…');
        await save(text);
        setWidth('');
        setIds([]);
        setMessage('Widths saved to the project on this device.');
      }
    } catch (e) {
      setMessage(`Not saved. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) copyButton.current?.click();
        else form.current?.requestSubmit();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  return (
    <div className="ze-app" style={{ height: '100%', overflow: 'auto' }}>
      <div className="ze-menubar">
        <HomeLink onClick={onExit} />
        {name} — PCB Editor
      </div>
      {opened.board && notice}
      <main style={{ padding: '1rem 1.5rem', maxWidth: '72rem' }}>
        <h2>KiCad 9 · Segment widths</h2>
        <p>
          Only the width of existing straight copper segments can change here. Routing, board setup,
          project settings and rules are unavailable. Zone fills are kept as stored.
        </p>
        {opened.board ? (
          <>
            <p>
              Select segments and enter their new width. This form saves manually; leaving or
              reloading the editor discards unsubmitted entries.
            </p>
            <form
              ref={form}
              onSubmit={(e) => {
                e.preventDefault();
                void submit(false);
              }}
            >
              <fieldset disabled={busy || readOnly}>
                <legend>Straight copper segments</legend>
                <table cellPadding={5}>
                  <thead>
                    <tr>
                      <th>Select</th>
                      <th>Layer</th>
                      <th>Numbered net</th>
                      <th>Start (mm)</th>
                      <th>End (mm)</th>
                      <th>Width (mm)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opened.board.segments.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${s.layer} segment ${s.id}`}
                            checked={ids.includes(s.id)}
                            onChange={(e) => {
                              setIds(
                                e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                              );
                              setMessage('');
                            }}
                          />
                        </td>
                        <td>{s.layer}</td>
                        <td>{s.net}</td>
                        <td>{s.start}</td>
                        <td>{s.end}</td>
                        <td>{s.width}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!opened.board.segments.length && <p>No straight copper segments on this board.</p>}
                <p>
                  <label>
                    New width (mm){' '}
                    <input
                      inputMode="decimal"
                      value={width}
                      onChange={(e) => {
                        setWidth(e.target.value);
                        setMessage('');
                      }}
                    />
                  </label>
                </p>
                <button type="submit">{save ? 'Save' : 'Save (download)'}</button>{' '}
                <button type="button" ref={copyButton} onClick={() => void submit(true)}>
                  Save a Copy…
                </button>
              </fieldset>
            </form>
            <p role="status">
              {message ||
                (readOnly ? 'This project is read only.' : draft ? 'Unsubmitted width edit.' : '')}
            </p>
          </>
        ) : (
          <p role="alert">
            <strong>Board editing is unavailable.</strong> This file does not match the supported
            KiCad 9.0.7 board profile. {opened.error} No files were written.
          </p>
        )}
      </main>
    </div>
  );
}
