/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  DirtyDiffPeekRegistry — module singleton that exposes the active editor's
 *  dirty-diff "quick diff" peek to code outside the contribution: the Esc
 *  keybinding (close), the "show change at cursor" command (open), and the E2E
 *  probe (introspection). DirtyDiffContribution registers itself as the host for
 *  whichever file editor is active; there is at most one host at a time, mirroring
 *  the single active dirty-diff peek in VSCode's QuickDiffEditorController.
 *--------------------------------------------------------------------------------------------*/

export interface IDirtyDiffPeekHost {
  /** Open (or move) the peek to the change containing `line`, else the closest. */
  openAtLine(line: number): boolean
  /** Close the peek if open. */
  closePeek(): void
  /** Whether the peek is currently open. */
  isPeekOpen(): boolean
  /** Current panel height in px, or undefined when closed (E2E introspection). */
  getPeekPanelHeightPx(): number | undefined
  /** The capped initial / maximum panel height in px (E2E introspection). */
  getPeekMaxHeightPx(): number | undefined
  /** Grow / shrink the panel by `deltaPx`; returns the resulting height. */
  resizePeekByPx(deltaPx: number): number | undefined
}

class DirtyDiffPeekRegistryImpl {
  private _host: IDirtyDiffPeekHost | undefined

  setHost(host: IDirtyDiffPeekHost): void {
    this._host = host
  }

  clearHost(host: IDirtyDiffPeekHost): void {
    if (this._host === host) this._host = undefined
  }

  getHost(): IDirtyDiffPeekHost | undefined {
    return this._host
  }
}

export const DirtyDiffPeekRegistry = new DirtyDiffPeekRegistryImpl()
