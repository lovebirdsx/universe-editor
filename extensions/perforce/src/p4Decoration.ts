/**
 * Maps opened files into SCM resource states + decorations. Pure transforms
 * (opened file → row); no p4 I/O here. Mirrors git's repositoryDecoration.ts.
 *
 * `contextValue` is the git-aligned status letter (M/A/D), or U for unresolved,
 * matching how the host renders the row badge AND how menu `when` clauses select
 * rows (e.g. `scmResourceState == U` for a resolve action). Shelved rows use `S`.
 * Reconcile (not-yet-opened) rows reuse the same action letter but with an `R`
 * prefix (`RM`/`RA`/`RD`) so they read as the git letter family while staying
 * distinguishable from opened rows for menu gating (`scmResourceState != RC`
 * no longer works once the letters align — the group id is the discriminator).
 * The full p4 action is kept in the tooltip for humans.
 */
import type { SourceControlResourceState } from '@universe-editor/extension-api'
import type { WorkingTreeChangeDto } from '@universe-editor/extensions-common'
import type { OpenedFile, P4Action } from './changelist.js'
import type { ReconcileFile } from './reconcileParser.js'
import type { ShelvedFile } from './shelveParser.js'

interface ActionStyle {
  readonly letter: string
  readonly color: string
  readonly tooltip: string
  readonly strikeThrough?: boolean
}

/** Visual style per p4 action. Letters and colours mirror git's palette. */
const ACTION_STYLE: Record<P4Action, ActionStyle> = {
  edit: { letter: 'M', color: '#e2c08d', tooltip: 'Edit' },
  add: { letter: 'A', color: '#73c991', tooltip: 'Add' },
  delete: { letter: 'D', color: '#c74e39', tooltip: 'Delete', strikeThrough: true },
  branch: { letter: 'A', color: '#73c991', tooltip: 'Branch' },
  integrate: { letter: 'M', color: '#e2c08d', tooltip: 'Integrate' },
  'move/add': { letter: 'A', color: '#73c991', tooltip: 'Move (add)' },
  'move/delete': { letter: 'D', color: '#c74e39', tooltip: 'Move (delete)', strikeThrough: true },
  import: { letter: 'A', color: '#73c991', tooltip: 'Import' },
  archive: { letter: 'M', color: '#e2c08d', tooltip: 'Archive' },
  purge: { letter: 'M', color: '#c74e39', tooltip: 'Purge' },
}

const UNRESOLVED_STYLE: ActionStyle = {
  letter: 'U',
  color: '#c74e39',
  tooltip: 'Needs resolve',
}

/** The status letter / `scmResourceState` value for a row. */
export function resourceContextValue(file: OpenedFile): string {
  return (file.unresolved ? UNRESOLVED_STYLE : ACTION_STYLE[file.action]).letter
}

export function toResourceState(file: OpenedFile): SourceControlResourceState | undefined {
  // Without a local path we can't anchor the row to a file; skip (rare).
  if (!file.clientFile) return undefined
  const style = file.unresolved ? UNRESOLVED_STYLE : ACTION_STYLE[file.action]
  return {
    resourceUri: file.clientFile,
    contextValue: style.letter,
    decorations: {
      tooltip: style.tooltip,
      color: style.color,
      ...(style.strikeThrough ? { strikeThrough: true } : {}),
    },
    // Clicking a row opens the local-vs-have diff; add rows have no depot base
    // yet so they just open the file.
    command:
      file.action === 'add'
        ? { command: 'perforce.openFile', title: 'Open File' }
        : { command: 'perforce.openChange', title: 'Open Changes' },
  }
}

/** Build resource states for one changelist group's files (skipping any without
 *  a local path). */
export function toResourceStates(files: readonly OpenedFile[]): SourceControlResourceState[] {
  const out: SourceControlResourceState[] = []
  for (const f of files) {
    const state = toResourceState(f)
    if (state) out.push(state)
  }
  return out
}

/**
 * A shelved file row. Shelved files live only in the depot, so the row is
 * anchored to the depot path (no local file exists to open). The `S` context
 * value lets menu `when` clauses target shelved rows (e.g. unshelve / delete
 * shelved). Clicking opens a diff of the shelved content against its base
 * revision (`perforce.openShelvedFile`), carrying the owning changelist +
 * depot path + base revision as command arguments so the handler can resolve
 * the revisions without a local file to anchor to.
 */
export function toShelvedResourceState(
  file: ShelvedFile,
  changelist: string,
): SourceControlResourceState {
  const style = ACTION_STYLE[file.action]
  return {
    resourceUri: file.depotFile,
    contextValue: 'S',
    decorations: {
      tooltip: `Shelved · ${style.tooltip}`,
      color: style.color,
      faded: true,
      ...(style.strikeThrough ? { strikeThrough: true } : {}),
    },
    command: {
      command: 'perforce.openShelvedFile',
      title: 'Open Shelved Changes',
      arguments: [{ changelist, depotFile: file.depotFile, rev: file.rev, action: file.action }],
    },
  }
}

export function toShelvedResourceStates(
  files: readonly ShelvedFile[],
  changelist: string,
): SourceControlResourceState[] {
  return files.map((f) => toShelvedResourceState(f, changelist))
}

/**
 * A file whose working-tree state diverged from the depot but that isn't opened
 * yet (from `p4 reconcile -n`). Its `contextValue` reuses the git-aligned action
 * letter with an `R` prefix (`RM`/`RA`/`RD`) so the row reads in git's letter
 * family yet stays distinguishable from an opened row for menu gating — opened
 * rows must not show "move out of changelist" / shelve, and reconcile rows must
 * not. Feeds the Explorer working-tree hint (see {@link toWorkingTreeHint});
 * clicking shows the have-vs-local diff for edit/delete, or just opens the file
 * for add (no depot base yet).
 */
export function toReconcileResourceState(
  file: ReconcileFile,
): SourceControlResourceState | undefined {
  if (!file.clientFile) return undefined
  const style = ACTION_STYLE[file.action]
  return {
    resourceUri: file.clientFile,
    contextValue: `R${style.letter}`,
    decorations: {
      tooltip: `Not opened · ${style.tooltip}`,
      color: style.color,
      ...(style.strikeThrough ? { strikeThrough: true } : {}),
    },
    command:
      file.action === 'add'
        ? { command: 'perforce.openFile', title: 'Open File' }
        : { command: 'perforce.openChange', title: 'Open Changes' },
  }
}

/**
 * The same reconcile divergence as an Explorer working-tree hint (the on-demand
 * channel the host queries per visible row, see `checkWorkingTree`).
 *
 * Derived from {@link toReconcileResourceState} rather than mapping the action a
 * second time, so the badge letter / colour / strike-through all live in one
 * place.
 */
export function toWorkingTreeHint(file: ReconcileFile): WorkingTreeChangeDto | undefined {
  const state = toReconcileResourceState(file)
  if (!state) return undefined
  const deco = state.decorations
  // No colour means no hint. Substituting a default here would put a badge on the
  // row in a colour the reconcile row would never use, contradicting the
  // single-source badge this hint derives from.
  if (deco?.color === undefined) return undefined
  return {
    path: state.resourceUri,
    letter: state.contextValue ?? 'RM',
    color: deco.color,
    ...(deco.tooltip !== undefined ? { tooltip: deco.tooltip } : {}),
    ...(deco.strikeThrough ? { strikeThrough: true } : {}),
  }
}
