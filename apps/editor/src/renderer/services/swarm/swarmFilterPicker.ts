/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Interactive configuration for the "Needs My Action" list filter. Opens a small
 *  QuickPick menu (set author set / toggle approvable-only) and, for the author
 *  set, a toggle-style multi-select picker (the QuickInput layer has no native
 *  multi-select, so selection is driven by re-rendering rows with a check mark and
 *  confirming with the OK button). Writes results back to settings.json via
 *  IConfigurationService so they persist and re-render the view through
 *  onDidChangeConfiguration.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  localize,
  type IConfigurationService,
  type IQuickInputService,
  type IQuickPickItem,
} from '@universe-editor/platform'
import { SwarmFilterConfigKeys, type SwarmReviewFilterConfig } from './swarmReviewFilter.js'

interface AuthorPickItem extends IQuickPickItem {
  selected: boolean
}

/**
 * Toggle-style multi-select over the candidate authors. Clicking a row flips its
 * check mark (the panel stays open); the OK button resolves the chosen set. Cancel
 * (Esc / dismiss) resolves undefined so the caller leaves the config untouched.
 */
function pickAuthors(
  quickInput: IQuickInputService,
  candidates: readonly string[],
  current: readonly string[],
): Promise<string[] | undefined> {
  const selected = new Set(current)
  const qp = quickInput.createQuickPick<AuthorPickItem>()
  qp.title = localize('swarm.filter.authors.title', 'Filter "Needs My Action" by author')
  qp.placeholder = localize(
    'swarm.filter.authors.placeholder',
    'Toggle authors to include, then press OK (empty = all authors)',
  )
  qp.keepOpenOnAccept = true
  qp.okLabel = localize('common.ok', 'OK')

  const render = (): void => {
    qp.items = candidates.map((author) => ({
      id: author,
      label: author,
      selected: selected.has(author),
      ...(selected.has(author) ? { statusIconId: 'check' } : {}),
      description: selected.has(author)
        ? localize('swarm.filter.authors.selected', 'included')
        : '',
    }))
  }
  render()

  return new Promise<string[] | undefined>((resolve) => {
    let done = false
    const finish = (value: string[] | undefined): void => {
      if (done) return
      done = true
      resolve(value)
      qp.dispose()
    }
    qp.onDidAccept((items) => {
      const item = items[0]
      if (!item) return
      if (selected.has(item.id)) selected.delete(item.id)
      else selected.add(item.id)
      render()
    })
    qp.onDidTriggerOk(() => finish([...selected]))
    qp.onDidHide(() => finish(undefined))
    qp.show()
  })
}

/**
 * Entry point for the "Needs My Action" filter gear. `dashboardAuthors` are the
 * authors currently visible in that group; combined with the already-configured
 * set they form the candidate list, so a configured author survives even when no
 * matching review is loaded.
 */
export async function configureNeedsActionFilter(
  quickInput: IQuickInputService,
  configuration: IConfigurationService,
  config: SwarmReviewFilterConfig,
  dashboardAuthors: readonly string[],
): Promise<void> {
  const SET_AUTHORS = 'setAuthors'
  const TOGGLE_APPROVABLE = 'toggleApprovable'

  const authorSummary =
    config.needsActionAuthors.length > 0
      ? config.needsActionAuthors.join(', ')
      : localize('swarm.filter.allAuthors', 'all authors')

  const choice = await quickInput.pick<IQuickPickItem>(
    [
      {
        id: SET_AUTHORS,
        label: localize('swarm.filter.setAuthors', 'Set author filter…'),
        description: authorSummary,
      },
      {
        id: TOGGLE_APPROVABLE,
        label: config.needsActionApprovableOnly
          ? localize('swarm.filter.approvable.off', 'Show all (not just approvable)')
          : localize('swarm.filter.approvable.on', 'Show only reviews I can approve'),
        ...(config.needsActionApprovableOnly ? { statusIconId: 'check' } : {}),
      },
    ],
    {
      placeholder: localize('swarm.filter.needsAction.placeholder', 'Configure "Needs My Action"'),
    },
  )
  if (!choice) return

  if (choice.id === TOGGLE_APPROVABLE) {
    configuration.update(
      SwarmFilterConfigKeys.needsActionApprovableOnly,
      !config.needsActionApprovableOnly,
      ConfigurationTarget.User,
    )
    return
  }

  const candidates = [...new Set([...config.needsActionAuthors, ...dashboardAuthors])].sort()
  const picked = await pickAuthors(quickInput, candidates, config.needsActionAuthors)
  if (picked === undefined) return
  configuration.update(SwarmFilterConfigKeys.needsActionAuthors, picked, ConfigurationTarget.User)
}
