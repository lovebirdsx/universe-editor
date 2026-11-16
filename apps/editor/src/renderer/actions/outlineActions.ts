/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Outline view keyboard commands, exposed for user-defined keybindings.
 *
 *  The tree's own arrow keys reach the focused container directly, and while the
 *  tree holds DOM focus `ctrlNavigationRegistry` claims Ctrl+J/K/H/L at the
 *  window capture phase (see packages/workbench-ui). So the view itself needs no
 *  default aliases. These commands deliberately carry NO default keybinding:
 *  `outline.navigate.*` stays registrable for users who want to bind it, while
 *  editable surfaces inside the view (e.g. the filter box) keep their global
 *  Ctrl+J/K/H/L semantics instead of being hijacked by an outline fallback.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  localize2,
  type ILocalizedString,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { OutlineNavigatorRegistry } from '../workbench/outline/outlineNavigatorRegistry.js'
import { viewFocusWhen } from './viewFocusWhen.js'

const CATEGORY = localize2('command.category.view', 'View')
const OUTLINE_FOCUS_WHEN = viewFocusWhen('workbench.view.outline.main')

class OutlineNavigateAction extends Action2 {
  constructor(
    id: string,
    title: ILocalizedString,
    private readonly _direction: 'up' | 'down' | 'left' | 'right',
  ) {
    super({
      id,
      title,
      category: CATEGORY,
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
      'right',
    )
  }
}
