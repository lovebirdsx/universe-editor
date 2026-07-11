/**
 * Maps opened files into SCM resource states + decorations. Pure transforms
 * (opened file → row); no p4 I/O here. Mirrors git's repositoryDecoration.ts.
 *
 * `contextValue` is a single status letter (E/A/D/B/I/M, or U for unresolved),
 * matching how the host renders the row badge AND how menu `when` clauses select
 * rows (e.g. `scmResourceState == U` for a resolve action). Reconcile (not-yet-
 * opened) rows use `RC`, shelved rows use `S`. The full p4 action is kept in the
 * tooltip for humans.
 */
import type { SourceControlResourceState } from '@universe-editor/extension-api'
import type { OpenedFile, P4Action } from './changelist.js'
import type { ReconcileFile } from './reconcileParser.js'
import type { ShelvedFile } from './shelveParser.js'

interface ActionStyle {
  readonly letter: string
  readonly color: string
  readonly tooltip: string
  readonly strikeThrough?: boolean
}

/** Visual style per p4 action. Colours mirror git's palette for consistency. */
const ACTION_STYLE: Record<P4Action, ActionStyle> = {
  edit: { letter: 'E', color: '#e2c08d', tooltip: 'Edit' },
  add: { letter: 'A', color: '#73c991', tooltip: 'Add' },
  delete: { letter: 'D', color: '#c74e39', tooltip: 'Delete', strikeThrough: true },
  branch: { letter: 'B', color: '#73c991', tooltip: 'Branch' },
  integrate: { letter: 'I', color: '#e2c08d', tooltip: 'Integrate' },
  'move/add': { letter: 'M', color: '#73c991', tooltip: 'Move (add)' },
  'move/delete': { letter: 'M', color: '#c74e39', tooltip: 'Move (delete)', strikeThrough: true },
  import: { letter: 'I', color: '#73c991', tooltip: 'Import' },
  archive: { letter: 'R', color: '#e2c08d', tooltip: 'Archive' },
  purge: { letter: 'R', color: '#c74e39', tooltip: 'Purge' },
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
 * shelved), and clicking is a no-op (there's no useful local diff).
 */
export function toShelvedResourceState(file: ShelvedFile): SourceControlResourceState {
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
  }
}

export function toShelvedResourceStates(
  files: readonly ShelvedFile[],
): SourceControlResourceState[] {
  return files.map(toShelvedResourceState)
}

/**
 * A "changes to reconcile" row: a file whose working-tree state diverged from the
 * depot but that isn't opened yet (from `p4 reconcile -n`). The `RC` context
 * value lets menu `when` clauses target these rows (e.g. the inline "collect"
 * action) distinctly from opened rows. Clicking shows the have-vs-local diff for
 * edit/delete, or just opens the file for add (no depot base yet).
 */
export function toReconcileResourceState(
  file: ReconcileFile,
): SourceControlResourceState | undefined {
  if (!file.clientFile) return undefined
  const style = ACTION_STYLE[file.action]
  return {
    resourceUri: file.clientFile,
    contextValue: 'RC',
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

export function toReconcileResourceStates(
  files: readonly ReconcileFile[],
): SourceControlResourceState[] {
  const out: SourceControlResourceState[] = []
  for (const f of files) {
    const state = toReconcileResourceState(f)
    if (state) out.push(state)
  }
  return out
}
