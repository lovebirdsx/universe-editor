/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Outline view keyboard commands. The tree's own arrow keys reach the focused
 *  container directly; these expose emacs-style aliases (Ctrl+P/N/B/F) that the
 *  global keybinding handler claims in the document capture phase before the keys
 *  could reach the tree, so they must be real commands gated on `focusedView`.
 *
 *  Ctrl+J rides along with Ctrl+N as the down alias. Ctrl+K is the app's chord
 *  leader (Ctrl+K Ctrl+S, …) and chord-first resolution means a single-stroke
 *  Ctrl+K binding can never fire, so the up pair is only complete while the tree
 *  container itself has DOM focus — `ctrlNavigationRegistry` claims Ctrl+P/N/J/K
 *  at the window capture phase there (see packages/workbench-ui). These commands
 *  remain the fallback while `focusedView` holds but focus sits elsewhere in the
 *  view body — including the filter box, where they keep the aliases on the
 *  outline list instead of letting the global commands run behind it.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  KeybindingWeight,
  localize2,
  type ILocalizedString,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { OutlineNavigatorRegistry } from '../workbench/outline/outlineNavigatorRegistry.js'
import { viewFocusWhen } from './viewFocusWhen.js'

const CATEGORY = localize2('command.category.view', 'View')

// Only when the Outline tree itself holds focus — so these Ctrl keys keep their
// global meaning (quick open / new file / …) everywhere else. The weight (above
// the default WorkbenchContrib) makes the scoped binding authoritative over the
// global Ctrl+P/N/B/F whenever OUTLINE_FOCUS_WHEN holds, independent of which
// action registered last.
const OUTLINE_FOCUS_WHEN = viewFocusWhen('workbench.view.outline.main')
const OUTLINE_KEY_WEIGHT = KeybindingWeight.WorkbenchContrib + 50

class OutlineNavigateAction extends Action2 {
  constructor(
    id: string,
    title: ILocalizedString,
    keys: readonly string[],
    private readonly _direction: 'up' | 'down' | 'left' | 'right',
  ) {
    super({
      id,
      title,
      category: CATEGORY,
      keybinding: keys.map((primary) => ({
        primary,
        when: OUTLINE_FOCUS_WHEN,
        weight: OUTLINE_KEY_WEIGHT,
      })),
      precondition: OUTLINE_FOCUS_WHEN,
    })
  }
  override run(_accessor: ServicesAccessor): void {
    OutlineNavigatorRegistry.current?.navigate(this._direction)
  }
}

export class OutlineNavigateUpAction extends OutlineNavigateAction {
  static readonly ID = 'outline.navigate.up'
  constructor() {
    super(
      OutlineNavigateUpAction.ID,
      localize2('action.outline.navigateUp', 'Outline: Select Previous Item'),
      ['ctrl+p'],
      'up',
    )
  }
}

export class OutlineNavigateDownAction extends OutlineNavigateAction {
  static readonly ID = 'outline.navigate.down'
  constructor() {
    super(
      OutlineNavigateDownAction.ID,
      localize2('action.outline.navigateDown', 'Outline: Select Next Item'),
      ['ctrl+n', 'ctrl+j'],
      'down',
    )
  }
}

export class OutlineNavigateLeftAction extends OutlineNavigateAction {
  static readonly ID = 'outline.navigate.left'
  constructor() {
    super(
      OutlineNavigateLeftAction.ID,
      localize2('action.outline.navigateLeft', 'Outline: Collapse or Select Parent'),
      ['ctrl+b'],
      'left',
    )
  }
}

export class OutlineNavigateRightAction extends OutlineNavigateAction {
  static readonly ID = 'outline.navigate.right'
  constructor() {
    super(
      OutlineNavigateRightAction.ID,
      localize2('action.outline.navigateRight', 'Outline: Expand or Select First Child'),
      ['ctrl+f'],
      'right',
    )
  }
}
