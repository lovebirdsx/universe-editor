/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Breadcrumb navigation commands. The bar owns the focused segment and the
 *  active picker; commands only resolve the ACTIVE editor group's controller and
 *  delegate, so a split view's background bar never reacts to a key meant for
 *  the focused group.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
  IEditorGroupsService,
  KeybindingWeight,
  localize2,
  type IAction2Keybinding,
  type ILocalizedString,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  IBreadcrumbsService,
  type IBreadcrumbsController,
} from '../services/breadcrumbs/BreadcrumbsService.js'

const CATEGORY = localize2('command.category.breadcrumbs', 'Breadcrumbs')

// Above WorkbenchContrib so these scoped bindings beat the global keys
// (Escape focus-editor, arrow keys) whenever the breadcrumb when-clause holds —
// the resolver only promotes by weight, `when` merely filters.
const WEIGHT = KeybindingWeight.WorkbenchContrib + 50

function focusedController(accessor: ServicesAccessor): IBreadcrumbsController | undefined {
  const service = accessor.get(IBreadcrumbsService)
  // Keyboard focus can be in a background group's bar (Tab), so prefer the
  // controller that owns focus over the active group's.
  return service.activeController ?? service.get(accessor.get(IEditorGroupsService).activeGroup.id)
}

class BreadcrumbCommandAction extends Action2 {
  constructor(
    id: string,
    title: ILocalizedString,
    private readonly _run: (controller: IBreadcrumbsController) => void,
    keybinding: IAction2Keybinding | readonly IAction2Keybinding[],
    options?: { readonly precondition?: string; readonly f1?: boolean },
  ) {
    super({
      id,
      title,
      category: CATEGORY,
      keybinding: Array.isArray(keybinding)
        ? keybinding.map((item) => ({ ...item, weight: WEIGHT }))
        : { ...(keybinding as IAction2Keybinding), weight: WEIGHT },
      ...(options?.precondition === undefined ? {} : { precondition: options.precondition }),
      ...(options?.f1 === undefined ? {} : { f1: options.f1 }),
    })
  }

  override run(accessor: ServicesAccessor): void {
    const controller = focusedController(accessor)
    if (controller) this._run(controller)
  }
}

export class BreadcrumbsFocusAndSelectAction extends BreadcrumbCommandAction {
  static readonly ID = 'breadcrumbs.focusAndSelect'
  constructor() {
    super(
      BreadcrumbsFocusAndSelectAction.ID,
      localize2('action.breadcrumbs.focusAndSelect', 'Focus Breadcrumbs and Select'),
      (controller) => controller.focusAndSelectLast(),
      { primary: 'ctrl+shift+.', when: 'breadcrumbsPossible' },
    )
  }
}

export class BreadcrumbsFocusAction extends BreadcrumbCommandAction {
  static readonly ID = 'breadcrumbs.focus'
  constructor() {
    super(
      BreadcrumbsFocusAction.ID,
      localize2('action.breadcrumbs.focus', 'Focus Breadcrumbs'),
      (controller) => controller.focusLast(),
      { primary: 'ctrl+shift+;', when: 'breadcrumbsPossible' },
    )
  }
}

export class BreadcrumbsFocusNextAction extends BreadcrumbCommandAction {
  static readonly ID = 'breadcrumbs.focusNext'
  constructor() {
    super(
      BreadcrumbsFocusNextAction.ID,
      localize2('action.breadcrumbs.focusNext', 'Focus Next Breadcrumb'),
      (controller) => controller.focusNext(),
      { primary: 'right', when: 'breadcrumbsActive' },
    )
  }
}

export class BreadcrumbsFocusPreviousAction extends BreadcrumbCommandAction {
  static readonly ID = 'breadcrumbs.focusPrevious'
  constructor() {
    super(
      BreadcrumbsFocusPreviousAction.ID,
      localize2('action.breadcrumbs.focusPrevious', 'Focus Previous Breadcrumb'),
      (controller) => controller.focusPrevious(),
      { primary: 'left', when: 'breadcrumbsActive' },
    )
  }
}

export class BreadcrumbsSelectFocusedAction extends BreadcrumbCommandAction {
  static readonly ID = 'breadcrumbs.selectFocused'
  constructor() {
    super(
      BreadcrumbsSelectFocusedAction.ID,
      localize2('action.breadcrumbs.selectFocused', 'Select Focused Breadcrumb'),
      (controller) => controller.selectFocused(),
      [
        { primary: 'enter', when: 'breadcrumbsActive' },
        { primary: 'down', when: 'breadcrumbsActive' },
      ],
    )
  }
}

export class BreadcrumbsRevealFocusedAction extends BreadcrumbCommandAction {
  static readonly ID = 'breadcrumbs.revealFocused'
  constructor() {
    super(
      BreadcrumbsRevealFocusedAction.ID,
      localize2('action.breadcrumbs.revealFocused', 'Open Focused Breadcrumb'),
      (controller) => controller.revealFocused(),
      [
        { primary: 'space', when: 'breadcrumbsActive' },
        { primary: 'ctrl+enter', when: 'breadcrumbsActive' },
      ],
    )
  }
}

export class BreadcrumbsSelectEditorAction extends BreadcrumbCommandAction {
  static readonly ID = 'breadcrumbs.selectEditor'
  constructor() {
    super(
      BreadcrumbsSelectEditorAction.ID,
      localize2('action.breadcrumbs.selectEditor', 'Return to Editor'),
      (controller) => controller.selectEditor(),
      { primary: 'escape', when: 'breadcrumbsActive' },
    )
  }
}

export class BreadcrumbsToggleAction extends Action2 {
  static readonly ID = 'breadcrumbs.toggle'
  constructor() {
    super({
      id: BreadcrumbsToggleAction.ID,
      title: localize2('action.breadcrumbs.toggle', 'Toggle Breadcrumbs'),
      category: CATEGORY,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    const config = accessor.get(IConfigurationService)
    const enabled = config.get<boolean>('breadcrumbs.enabled', true) !== false
    config.update('breadcrumbs.enabled', !enabled, ConfigurationTarget.User)
  }
}
