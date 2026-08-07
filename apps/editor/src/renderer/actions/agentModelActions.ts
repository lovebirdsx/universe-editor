/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session config option pickers (model / mode / thought level). These three
 *  actions all do the same thing: locate the active session's ConfigOption for a
 *  given category, show a QuickPick of its values, then apply the choice through
 *  `session.setConfigOption()`.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ConfigurationTarget,
  IConfigurationService,
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
  AI_FIX_AGENT_ID_KEY,
  AI_FIX_MODE_KEY,
  AI_FIX_MODEL_KEY,
  AI_FIX_THOUGHT_LEVEL_KEY,
  readAiFixSettings,
} from '../services/acp/aiFixConfig.js'
import { IAcpAgentRegistry } from '../services/acp/acpAgentRegistry.js'
import { IAcpConfigOptionsCacheService } from '../services/acp/session/acpConfigOptionsCache.js'
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

/**
 * Dedicated-parameter picker for the "Fix with AI" quick fix: pick the agent,
 * then its model / thinking depth / mode. Each pick writes one `acp.aiFix.*`
 * setting (User target); picking the leading "(default)" entry clears that
 * setting so the session follows the per-agent default. Cancelling any step
 * keeps the values written so far.
 */
export class ConfigureAiFixAction extends Action2 {
  static readonly ID = 'workbench.action.agent.configureAiFix'
  constructor() {
    super({
      id: ConfigureAiFixAction.ID,
      title: localize2('action.agent.configureAiFix', 'Configure AI Fix…'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // Snapshot every service before the first await (the accessor dies there).
    const registry = accessor.get(IAcpAgentRegistry)
    const config = accessor.get(IConfigurationService)
    const cache = accessor.get(IAcpConfigOptionsCacheService)
    const quickInput = accessor.get(IQuickInputService)
    const notification = accessor.get(INotificationService)

    const settings = readAiFixSettings(config)
    const currentLabel = localize('agent.configOption.current', 'current')
    const defaultItemLabel = localize(
      'agent.configureAiFix.followDefault',
      '(Default) Follow the agent default',
    )

    // Step 1: the agent. The current choice is annotated.
    const agents = registry.list()
    const agentItems: IQuickPickItem[] = agents.map((a) => ({
      id: a.id,
      label: a.id === settings.agentId ? `${a.name} · ${currentLabel}` : a.name,
    }))
    const pickedAgent = await quickInput.pick(agentItems, {
      placeholder: localize('agent.configureAiFix.pickAgent', 'Select the AI Fix agent'),
    })
    if (!pickedAgent || pickedAgent.id === undefined) return
    const agentId = pickedAgent.id
    if (agentId !== settings.agentId) {
      await config.update(AI_FIX_AGENT_ID_KEY, agentId, ConfigurationTarget.User)
    }

    // Steps 2-4: model / thinking depth / mode, resolved by category against
    // the agent's last-known bag. A cold cache (agent never ran here) or a
    // missing category skips that step with a hint.
    const bag = cache.get(agentId)
    const noCacheWarned = { value: false }
    const steps: ReadonlyArray<{
      readonly category: SessionConfigOptionCategory
      readonly settingKey: string
      readonly currentValue: string
      readonly placeholder: string
    }> = [
      {
        category: 'model',
        settingKey: AI_FIX_MODEL_KEY,
        currentValue: agentId === settings.agentId ? settings.model : '',
        placeholder: localize('agent.selectModel.placeholder', 'Select model'),
      },
      {
        category: 'thought_level',
        settingKey: AI_FIX_THOUGHT_LEVEL_KEY,
        currentValue: agentId === settings.agentId ? settings.thoughtLevel : '',
        placeholder: localize('agent.selectThoughtLevel.placeholder', 'Select thinking depth'),
      },
      {
        category: 'mode',
        settingKey: AI_FIX_MODE_KEY,
        currentValue: agentId === settings.agentId ? settings.mode : '',
        placeholder: localize('agent.selectMode.placeholder', 'Select session mode'),
      },
    ]
    for (const step of steps) {
      const option = bag.find((o) => o.type === 'select' && o.category === step.category)
      if (!option || option.type !== 'select') {
        if (!noCacheWarned.value) {
          noCacheWarned.value = true
          notification.notify({
            severity: Severity.Info,
            message: localize(
              'agent.configureAiFix.noOptions',
              'No cached config options for this agent yet — open one session with it first, then configure model / thinking depth / mode here.',
            ),
          })
        }
        continue
      }
      const flatValues = flattenSelectOptions(option.options)
      const items: IQuickPickItem[] = [
        {
          id: '',
          label:
            step.currentValue === '' ? `${defaultItemLabel} · ${currentLabel}` : defaultItemLabel,
        },
        ...flatValues.map((v) => ({
          id: v.value,
          label: v.value === step.currentValue ? `${v.name} · ${currentLabel}` : v.name,
          ...(v.description != null ? { description: v.description } : {}),
        })),
      ]
      const picked = await quickInput.pick(items, { placeholder: step.placeholder })
      if (!picked || picked.id === undefined) return
      if (picked.id !== step.currentValue) {
        await config.update(step.settingKey, picked.id, ConfigurationTarget.User)
      }
    }
  }
}
