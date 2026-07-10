/**
 * Perforce changelist domain model + pure grouping logic. No p4 I/O here — the
 * client feeds parsed records in and consumes the grouped result. Kept pure so
 * the default/numbered grouping is unit-testable against fixtures.
 *
 * Perforce structure differs fundamentally from git: instead of a fixed
 * staged/working split, a file belongs to exactly one *pending changelist* — the
 * "default" one, or a numbered one. So the SCM view shows one dynamic group per
 * changelist (see §2.2 of the design), not git's two fixed groups.
 */

/** A p4 open action (`p4 opened` "action" field). `unresolved` is layered on
 *  separately in contextValue when a file needs `p4 resolve`. */
export type P4Action =
  | 'edit'
  | 'add'
  | 'delete'
  | 'branch'
  | 'integrate'
  | 'move/add'
  | 'move/delete'
  | 'import'
  | 'archive'
  | 'purge'

/** One opened file, as surfaced by `p4 opened`. */
export interface OpenedFile {
  /** Depot path, e.g. `//depot/main/foo.txt`. */
  readonly depotFile: string
  /** Local filesystem path (absolute), when known (from `clientFile`). */
  readonly clientFile: string | undefined
  /** The changelist this file is open in: 'default' or a numbered id as string. */
  readonly changelist: string
  readonly action: P4Action
  /** Have/head revision number, when reported. */
  readonly rev: string | undefined
  /** True when the file needs `p4 resolve` (unresolved integration/merge). */
  readonly unresolved: boolean
}

/** A pending changelist's metadata (from `p4 changes -s pending`). */
export interface PendingChangelist {
  /** Numbered id as string (e.g. `'12345'`). */
  readonly id: string
  /** Description (may be multi-line; first line is used for the label). */
  readonly description: string
}

/** A grouped changelist ready to become a SCM ResourceGroup. */
export interface ChangelistGroup {
  /** Group id: 'default' or `cl:<n>`. */
  readonly id: string
  /** Human label for the group header. */
  readonly label: string
  /** Whether this is the default changelist (always shown, even when empty). */
  readonly isDefault: boolean
  readonly files: readonly OpenedFile[]
}

export const DEFAULT_GROUP_ID = 'default'

/** Build the `cl:<n>` group id for a numbered changelist. */
export function numberedGroupId(id: string): string {
  return `cl:${id}`
}

/** Build the `shelved:<n>` group id for a changelist's shelved files. */
export function shelvedGroupId(id: string): string {
  return `shelved:${id}`
}

/** True for a `shelved:<n>` group id. */
export function isShelvedGroupId(groupId: string): boolean {
  return groupId.startsWith('shelved:')
}

/**
 * Reverse of {@link numberedGroupId}: pull the numbered changelist id out of a
 * group id. Returns `'default'` for the default group (whose "id" on the p4 CLI
 * is the literal `default`), or the number string for a `cl:<n>` /
 * `shelved:<n>` group. Used to route group-scoped commands (submit / revert /
 * shelve a whole changelist) to the right changelist target.
 */
export function changelistIdFromGroupId(groupId: string): string {
  if (groupId === DEFAULT_GROUP_ID) return DEFAULT_GROUP_ID
  if (groupId.startsWith('cl:')) return groupId.slice(3)
  if (groupId.startsWith('shelved:')) return groupId.slice('shelved:'.length)
  return groupId
}

/** First non-empty line of a changelist description, trimmed. */
export function descriptionFirstLine(desc: string): string {
  for (const line of desc.split('\n')) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/**
 * Group opened files by changelist into ordered groups: the default changelist
 * first (always present), then numbered changelists sorted ascending by id.
 * `labelFor` renders each group's header label so callers control localization.
 *
 * A numbered changelist with no metadata (present in `opened` but missing from
 * the `changes` list — rare, e.g. a race) still gets a group, labelled by id.
 */
export function groupChangelists(
  opened: readonly OpenedFile[],
  pending: readonly PendingChangelist[],
  labelFor: {
    default: () => string
    numbered: (id: string, firstLine: string) => string
  },
): ChangelistGroup[] {
  const byChangelist = new Map<string, OpenedFile[]>()
  for (const file of opened) {
    let bucket = byChangelist.get(file.changelist)
    if (!bucket) {
      bucket = []
      byChangelist.set(file.changelist, bucket)
    }
    bucket.push(file)
  }

  const descById = new Map(pending.map((c) => [c.id, c.description]))

  const groups: ChangelistGroup[] = []

  // Default group is always present, even when empty.
  groups.push({
    id: DEFAULT_GROUP_ID,
    label: labelFor.default(),
    isDefault: true,
    files: byChangelist.get(DEFAULT_GROUP_ID) ?? [],
  })

  // Union of numbered ids seen in either opened files or the pending list, so a
  // pending changelist with no open files still shows (e.g. a shelved-only CL),
  // and an opened file in an unlisted CL isn't dropped.
  const numberedIds = new Set<string>()
  for (const id of byChangelist.keys()) {
    if (id !== DEFAULT_GROUP_ID) numberedIds.add(id)
  }
  for (const c of pending) numberedIds.add(c.id)

  const sorted = [...numberedIds].sort((a, b) => Number(a) - Number(b))
  for (const id of sorted) {
    const firstLine = descriptionFirstLine(descById.get(id) ?? '')
    groups.push({
      id: numberedGroupId(id),
      label: labelFor.numbered(id, firstLine),
      isDefault: false,
      files: byChangelist.get(id) ?? [],
    })
  }

  return groups
}

/**
 * Total opened files across pending groups (default + numbered). This is the
 * SCM badge count — "how many files you have open" — and excludes shelved files.
 */
export function countOpened(groups: readonly ChangelistGroup[]): number {
  return groups.reduce((total, g) => total + g.files.length, 0)
}
