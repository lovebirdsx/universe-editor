/**
 * Classify a Revert selection by p4 open state and format the confirm message.
 *
 * One command covers both `p4 revert` (opened: unopen + discard) and `p4 clean`
 * (unopened working-tree drift). Confirming over a mixed selection must name
 * every file that will leave a changelist — `p4 revert` is silent on unopened
 * files, and listing those that *are* opened is the only way to keep the
 * promise honest. Pure so the combinations stay covered by unit tests.
 */
import { localize } from './nls.js'
import { norm } from './pathUtil.js'

export type OpenedTarget = {
  path: string
  /** `'default'` or a numbered id; omitted when opened but the CL is unknown. */
  changelist?: string
}

export type RevertPlan = {
  opened: OpenedTarget[]
  unopened: string[]
  /** Directory target (trailing slashes already stripped). */
  directory?: string
  /**
   * Directory live `p4 opened` failed and the cache was empty. Treat as "may
   * have opened files" — never confirm as uncollected-only.
   */
  openedUnknown?: boolean
}

export const REVERT_LIST_CAP = 10

/** `'default'` or a numbered id; anything else is unknown (omit from the confirm). */
export function knownChangelist(id: string | undefined): string | undefined {
  if (id === 'default') return 'default'
  if (id !== undefined && /^\d+$/.test(id)) return id
  return undefined
}

export type RevertActions = {
  /** Paths (or `dir/...`) to `p4 revert`. Empty → skip. */
  revert: string[]
  /** Paths (or `dir/...`) to `p4 clean` (`revertReconcile`). Empty → skip. */
  clean: string[]
}

/**
 * Map a confirmed plan onto the two p4 primitives. Directory targets always
 * clean `dir/...` (unopened drift is not enumerated); revert of the same spec
 * only when the tree has opened files or the opened query failed open.
 */
export function revertActionsOf(plan: RevertPlan): RevertActions {
  if (plan.directory !== undefined) {
    const spec = `${plan.directory}/...`
    return {
      revert: plan.opened.length > 0 || plan.openedUnknown ? [spec] : [],
      clean: [spec],
    }
  }
  return {
    revert: plan.opened.map((f) => f.path),
    clean: [...plan.unopened],
  }
}

function displayName(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? path
  )
}

export function classifyRevertTargets(
  paths: readonly string[],
  openState: ReadonlyMap<string, string | undefined>,
  opts?: { directory?: string; openedUnknown?: boolean },
): RevertPlan {
  const opened: OpenedTarget[] = []
  const unopened: string[] = []
  for (const path of paths) {
    const key = norm(path)
    if (openState.has(key)) {
      const changelist = knownChangelist(openState.get(key))
      opened.push(changelist === undefined ? { path } : { path, changelist })
    } else {
      unopened.push(path)
    }
  }
  return {
    opened,
    unopened,
    ...(opts?.directory !== undefined ? { directory: opts.directory.replace(/[/\\]+$/, '') } : {}),
    ...(opts?.openedUnknown ? { openedUnknown: true } : {}),
  }
}

function changelistLabel(changelist: string): string {
  if (changelist === 'default') return localize('perforce.group.defaultShort', 'Default')
  return changelist.startsWith('#') ? changelist : `#${changelist}`
}

function formatOpenedLine(file: OpenedTarget): string {
  const name = displayName(file.path)
  if (file.changelist === undefined) return name
  return localize('perforce.revert.leaveClLine', '{0}  ({1})', {
    0: name,
    1: changelistLabel(file.changelist),
  })
}

function formatOpenedList(opened: readonly OpenedTarget[], cap: number): string {
  const shown = opened.slice(0, cap)
  const lines = shown.map(formatOpenedLine)
  const extra = opened.length - shown.length
  if (extra > 0) {
    lines.push(localize('perforce.revert.leaveClMore', '…and {0} more', { 0: String(extra) }))
  }
  return lines.join('\n')
}

export function formatRevertConfirm(plan: RevertPlan, opts?: { listCap?: number }): string {
  const cap = opts?.listCap ?? REVERT_LIST_CAP
  const onlyUnopened = plan.opened.length === 0 && !plan.openedUnknown
  if (onlyUnopened) {
    if (plan.directory) {
      return localize(
        'perforce.revert.discardDir',
        "Discard working-tree changes under '{0}'? This cannot be undone.",
        { 0: displayName(plan.directory) },
      )
    }
    if (plan.unopened.length === 1) {
      return localize(
        'perforce.revert.discardOne',
        "Discard working-tree changes for '{0}'? This cannot be undone.",
        { 0: displayName(plan.unopened[0]!) },
      )
    }
    return localize(
      'perforce.revert.discardMany',
      'Discard working-tree changes for {0} files? This cannot be undone.',
      { 0: String(plan.unopened.length) },
    )
  }

  const parts: string[] = []
  if (plan.openedUnknown && plan.opened.length === 0) {
    parts.push(
      localize(
        'perforce.revert.dirOpenedUnknown',
        'Opened files in this directory will leave their changelist (the list could not be determined). Local changes will be lost.',
      ),
    )
  } else {
    parts.push(
      localize(
        'perforce.revert.leaveClHeader',
        'These files will leave their changelist. Local changes will be lost.',
      ),
    )
    if (plan.opened.length > 0) parts.push(formatOpenedList(plan.opened, cap))
  }
  if (plan.directory) {
    parts.push(
      localize(
        'perforce.revert.alsoDirUnopened',
        'Unopened working-tree changes under this directory will also be discarded.',
      ),
    )
  } else if (plan.unopened.length > 0) {
    parts.push(
      localize(
        'perforce.revert.alsoUnopened',
        'Working-tree changes on {0} unopened file(s) will also be discarded.',
        { 0: String(plan.unopened.length) },
      ),
    )
  }
  return parts.join('\n')
}
