/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineNavigatorRegistry — the live navigation handle for the focused Outline
 *  tree, so view-level keyboard commands can drive it.
 *
 *  The Outline tree's arrow/Enter keys are handled inside the generic <Tree>
 *  (the event reaches the focused container). But emacs-style Ctrl+P/N/B/F are
 *  claimed by the global keybinding handler in the document capture phase before
 *  they ever reach the tree, so they must be real commands. Those commands are
 *  gated on `focusedView == 'workbench.view.outline.main'` and routed here to the
 *  currently-mounted OutlineView. Mirrors AcpSessionOutlineRegistry.
 *--------------------------------------------------------------------------------------------*/

export interface IOutlineNavigator {
  /** Move the tree selection like the matching arrow key would. */
  navigate(direction: 'up' | 'down' | 'left' | 'right'): void
}

class OutlineNavigatorRegistryImpl {
  private _current: IOutlineNavigator | null = null

  register(navigator: IOutlineNavigator): { dispose(): void } {
    this._current = navigator
    return {
      dispose: () => {
        if (this._current === navigator) this._current = null
      },
    }
  }

  get current(): IOutlineNavigator | null {
    return this._current
  }

  /** @internal test hook */
  _resetForTests(): void {
    this._current = null
  }
}

export const OutlineNavigatorRegistry: OutlineNavigatorRegistryImpl =
  new OutlineNavigatorRegistryImpl()
