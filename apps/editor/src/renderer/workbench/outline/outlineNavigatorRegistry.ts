/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineNavigatorRegistry — the live navigation handle for the focused Outline
 *  tree, so view-level commands can drive it.
 *
 *  The Outline tree's arrow/Enter keys are handled inside the generic <Tree>
 *  (the event reaches the focused container), and while the tree holds DOM focus
 *  Ctrl+J/K/H/L are claimed by `ctrlNavigationRegistry` at the window capture
 *  phase. The `outline.navigate.*` commands therefore have no default keybinding;
 *  they exist only so users can bind them, gated on
 *  `focusedView == 'workbench.view.outline.main'` and routed here to the
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
