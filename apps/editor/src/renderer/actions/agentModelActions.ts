/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session config option pickers (model / mode / thought level). These three
 *  actions all do the same thing: locate the active session's ConfigOption for a
 *  given category, show a QuickPick of its values, then apply the choice through
 *  `session.setConfigOption()`.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  INotificationService,
  IQuickInputService,
  Severity,
  localize,
  localize2,
  type IQuickPickItem,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionService, type IAcpSession } from '../services/acp/session/acpSessionService.js'
import type {
  SessionConfigOptionCategory,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk'
import { findConfigOptionLabel } from '../services/acp/configOptionLabel.js'
import {
  confirmModelSwitchContextShrink,
  evaluateModelSwitchContextShrink,
} from '../services/acp/session/modelSwitchContextGuard.js'
import { CATEGORY } from './_agentShared.js'

async function pickConfigOption(
  accessor: ServicesAccessor,
  category: SessionConfigOptionCategory,
  placeholder: string,
  notFound: string,
): Promise<void> {
  // Resolve every service up-front: the accessor is invalidated by the first
  // await (see memory: action2-async-accessor-invalidation).
  const sessionService = accessor.get(IAcpSessionService)
  const notificationService = accessor.get(INotificationService)
  const quickInputService = accessor.get(IQuickInputService)
  const dialogService = accessor.get(IDialogService)
  const session = sessionService.activeSession.get()
  if (!session) {
    notificationService.notify({
      severity: Severity.Info,
      message: localize('agent.noSession', 'No active agent session.'),
    })
    return
  }
  const option = session.configOptions.get().find((o) => o.category === category)
  if (!option || option.type !== 'select') {
    notificationService.notify({ severity: Severity.Info, message: notFound })
    return
  }
  const currentLabel = localize('agent.configOption.current', 'current')
  const flatValues = flattenSelectOptions(option.options)
  const items: IQuickPickItem[] = flatValues.map((v) => ({
    id: v.value,
    label: v.value === option.currentValue ? `${v.name} · ${currentLabel}` : v.name,
    ...(v.description != null ? { description: v.description } : {}),
  }))
  const picked = await quickInputService.pick(items, { placeholder })
  if (!picked || picked.id === option.currentValue) return
  // Switching a large session onto a smaller-context model silently compacts
  // it on the next prompt — confirm before applying.
  if (category === 'model') {
    const shrink = evaluateModelSwitchContextShrink(session.agentId, session.usage.get(), picked.id)
    if (shrink) {
      const targetLabel = findConfigOptionLabel(flatValues, picked.id)
      const ok = await confirmModelSwitchContextShrink(dialogService, shrink, targetLabel)
      if (!ok) return
    }
  }
  await applyConfigOption(session, option.id, picked.id, notificationService)
}

/**
 * SDK's `SessionConfigSelectOptions` is a union: either a flat array of
 * `SessionConfigSelectOption` or an array of `SessionConfigSelectGroup`. The
 * QuickPick UI doesn't support grouping today, so we flatten — group labels
 * are dropped, leaving just the leaf values.
 */
function flattenSelectOptions(
  options: readonly SessionConfigSelectOption[] | readonly SessionConfigSelectGroup[],
): readonly SessionConfigSelectOption[] {
  if (options.length === 0) return []
  const first = options[0]!
  if ('group' in first) {
    const groups = options as readonly SessionConfigSelectGroup[]
    return groups.flatMap((g) => g.options)
  }
  return options as readonly SessionConfigSelectOption[]
}

async function applyConfigOption(
  session: IAcpSession,
  configId: string,
  value: string,
  notificationService: INotificationService,
): Promise<void> {
  try {
    await session.setConfigOption(configId, value)
  } catch (err) {
    notificationService.notify({
      severity: Severity.Error,
      message: localize('agent.configOption.failed', 'Failed to apply option: {error}', {
        error: (err as Error).message,
      }),
    })
  }
}

export class SelectAgentModelAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectModel'
  constructor() {
    super({
      id: SelectAgentModelAction.ID,
      title: localize2('action.agent.selectModel', 'Select Agent Model…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await pickConfigOption(
      accessor,
      'model',
      localize('agent.selectModel.placeholder', 'Select model'),
      localize('agent.selectModel.notFound', "Active agent doesn't expose a model selector."),
    )
  }
}

export class SelectAgentModeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectMode'
  constructor() {
    super({
      id: SelectAgentModeAction.ID,
      title: localize2('action.agent.selectMode', 'Select Agent Mode…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await pickConfigOption(
      accessor,
      'mode',
      localize('agent.selectMode.placeholder', 'Select session mode'),
      localize('agent.selectMode.notFound', "Active agent doesn't expose session modes."),
    )
  }
}

export class SelectAgentThoughtLevelAction extends Action2 {
  static readonly ID = 'workbench.action.agent.selectThoughtLevel'
  constructor() {
    super({
      id: SelectAgentThoughtLevelAction.ID,
      title: localize2('action.agent.selectThoughtLevel', 'Select Agent Thinking Level…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    await pickConfigOption(
      accessor,
      'thought_level',
      localize('agent.selectThoughtLevel.placeholder', 'Select thinking depth'),
      localize(
        'agent.selectThoughtLevel.notFound',
        "Active agent doesn't expose a thinking-level switch.",
      ),
    )
  }
}
