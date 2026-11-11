// SPDX-License-Identifier: GPL-3.0-or-later
// Positive admission to the native editor. Unknown/damaged headers must never
// turn a failed 9 open into an editable copy of the editor's warm blank board.
export function nativeBoardEntry(text: string, newBoard: string): boolean {
  return text === newBoard || /^\s*\(\s*kicad_pcb\s*\(\s*version\s+20260206\s*\)/.test(text);
}
