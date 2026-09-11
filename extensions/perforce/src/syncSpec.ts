/**
 * Pure decision helpers for the `perforce.sync` revision picker, kept out of
 * `extension.ts` so they stay unit-testable (no extension-api import, hence no
 * host mock). The sync itself always runs through `runSync` — these only shape
 * its inputs, including the force-get confirmation body.
 */

import { localize } from './nls.js'

/** The four ways P4V lets you name a revision. Each is offered plain and forced. */
export type SyncSpecKind = 'head' | 'changelist' | 'date' | 'rev'

/**
 * Semantic `labelColor` id for the force rows. The renderer maps it to a
 * concrete color (`QuickInputPanel.labelColorClass`); an id nobody maps renders
 * silently uncolored, so the two live or die together.
 */
export const SYNC_FORCE_LABEL_COLOR = 'force'

export interface SyncPick {
  readonly kind: SyncSpecKind
  readonly force: boolean
  readonly label: string
  readonly description: string
  /** Only the force rows carry one: a plain get never rewrites a local copy. */
  readonly labelColor?: string
}

/**
 * The picker's rows in display order: the four plain ways, then the same four
 * as force-gets. The forced rows stay last on purpose — the list is picked with
 * the keyboard as often as the mouse, and a `#head -f` row that drifted to the
 * top would be what a stray Enter destroys local work with.
 */
export function syncPickItems(): SyncPick[] {
  return [
    {
      kind: 'head',
      force: false,
      label: localize('perforce.syncPick.head', 'Latest revision'),
      description: '#head',
    },
    {
      kind: 'changelist',
      force: false,
      label: localize('perforce.syncPick.changelist', 'As of a changelist…'),
      description: '@12345',
    },
    {
      kind: 'date',
      force: false,
      label: localize('perforce.syncPick.date', 'As of a date…'),
      description: '@2026/08/01',
    },
    {
      kind: 'rev',
      force: false,
      label: localize('perforce.syncPick.rev', 'A specific revision…'),
      description: '#4',
    },
    {
      kind: 'head',
      force: true,
      label: localize('perforce.syncPick.forceHead', 'Force-get: latest revision'),
      description: '#head -f',
      labelColor: SYNC_FORCE_LABEL_COLOR,
    },
    {
      kind: 'changelist',
      force: true,
      label: localize('perforce.syncPick.forceChangelist', 'Force-get: as of a changelist…'),
      description: '@12345 -f',
      labelColor: SYNC_FORCE_LABEL_COLOR,
    },
    {
      kind: 'date',
      force: true,
      label: localize('perforce.syncPick.forceDate', 'Force-get: as of a date…'),
      description: '@2026/08/01 -f',
      labelColor: SYNC_FORCE_LABEL_COLOR,
    },
    {
      kind: 'rev',
      force: true,
      label: localize('perforce.syncPick.forceRev', 'Force-get: a specific revision…'),
      description: '#4 -f',
      labelColor: SYNC_FORCE_LABEL_COLOR,
    },
  ]
}

interface ValuePrompt {
  readonly prompt: string
  readonly placeHolder: string
}

/** Keyed by the kinds that need a value, so a new kind cannot be added without
 *  either a prompt here or an explicit placement in {@link syncPromptOf}. */
const VALUE_PROMPTS: Readonly<Record<Exclude<SyncSpecKind, 'head'>, ValuePrompt>> = {
  changelist: {
    prompt: localize('perforce.syncPrompt.changelist', 'Changelist number'),
    placeHolder: '12345',
  },
  date: {
    prompt: localize('perforce.syncPrompt.date', 'Date (yyyy/mm/dd, optionally with time)'),
    placeHolder: '2026/08/01',
  },
  rev: {
    prompt: localize('perforce.syncPrompt.rev', 'Revision number'),
    placeHolder: '4',
  },
}

/** The input box a row asks for, or undefined when the row needs no value —
 *  which is also the only reason a pick runs without an input box. */
export function syncPromptOf(kind: SyncSpecKind): ValuePrompt | undefined {
  return kind === 'head' ? undefined : VALUE_PROMPTS[kind]
}

/**
 * The p4 revision suffix a row resolves to. `#head` is the one value nobody
 * types, so it ignores `raw` entirely.
 *
 * A leading sigil the user typed themselves is honoured rather than doubled:
 * `@` selects "the state as of", `#` a numbered revision. That also means a
 * value can name a different shape than its row did (`#4` typed into the
 * changelist row runs `#4`) — the confirmation names the spec that will
 * actually run, so the substitution is never silent.
 */
export function syncSpecOf(kind: SyncSpecKind, raw: string | undefined): string | undefined {
  if (kind === 'head') return '#head'
  const value = raw?.trim()
  if (!value) return undefined
  if (/^[@#]/.test(value)) return value
  return kind === 'rev' ? `#${value}` : `@${value}`
}

/**
 * The filespecs a sync with this scope really covers: an explicit non-empty
 * scope, else the client's configured one. Mirrors `PerforceClient._syncTargets`
 * (where an empty array falls back just like an absent one), so the
 * confirmation names the range p4 is about to get.
 */
export function effectiveSyncScope(
  scope: readonly string[] | undefined,
  fallback: readonly string[],
): readonly string[] {
  return scope !== undefined && scope.length > 0 ? scope : fallback
}

/** Longest scope text the confirmation spells out before truncating. */
const SCOPE_TEXT_MAX = 300

/**
 * Render a scope for a dialog. Readable but bounded: a merged-history tab can
 * carry dozens of paths and a wall of them buries the facts the dialog exists to
 * deliver (where it goes, how wide it is). The count rides along only when it
 * adds information — "(1 filespecs)" is noise on the single-path case.
 */
export function scopeTextOf(filespecs: readonly string[]): string {
  const list = filespecs.join(', ')
  if (list.length <= SCOPE_TEXT_MAX) return list
  return `${list.slice(0, SCOPE_TEXT_MAX)}…${
    filespecs.length > 1 ? ` (${filespecs.length} filespecs)` : ''
  }`
}

/**
 * The force-get confirmation body. Every force path — the picker's four forced
 * rows, the post-refusal remedy, the graph rows — runs through this one string,
 * so the wording is also the contract a user learns once.
 *
 * `{0}` is deliberately named "target" rather than "changelist": the spec can be
 * `@4521`, `@2026/08/01`, `#4` or `#head`, and a body that called `#4` a
 * changelist would be telling the user something false about what is running.
 */
export function forceConfirmMessage(spec: string, scopeText: string): string {
  return localize(
    'perforce.sync.forceConfirm',
    'Force-get overwrites local files even when Perforce thinks they are current — uncollected changes in them (including untracked same-name files) will be lost. Target: {0}; files that are not open for edit are reset to that revision. Scope: {1}. This cannot be undone.',
    { 0: spec, 1: scopeText },
  )
}
