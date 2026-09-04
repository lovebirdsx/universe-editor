/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmDecorationsService — derives a by-URI lookup of SCM status decorations from
 *  the SCM model. Each provider pushes one resource per change (with a status
 *  letter and a VSCode-matching colour); this service folds those into two maps:
 *  `files` (the file's own status) and `folders` (status propagated up to every
 *  ancestor directory, so a changed file tints its enclosing folders). Both the
 *  Explorer rows and the editor tabs consume it to colour file names.
 *
 *  Decorations reflect only the repo the SCM view currently shows
 *  (`scmViewState.selectedRepo`; the first registered source control is the
 *  fallback when nothing is selected or the selection matches no provider) —
 *  in a mixed workspace where git and perforce report the same path, the
 *  unselected provider's decoration is dropped instead of overlaying the
 *  selected one's. Consumers read the snapshot through
 *  `useObservable(decorations)`, so they follow repo switches automatically.
 *
 *  Both maps are keyed by SCM-host path, so `getFile`/`getFolder` are the only
 *  supported lookup path: they resolve the resource host-scopedly (see
 *  scmHostPath) and miss for off-host resources. Do not key into `decorations`
 *  with a hand-built path — a remote window also holds local `file:` editors.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  derived,
  IWorkspaceService,
  observableValue,
  type IObservable,
  type URI,
} from '@universe-editor/platform'
import { IScmService, resolveSelectedSourceControl } from '../extensions/ScmService.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import { scmHostPath } from './scmHostPath.js'
// services → workbench reverse import: scmViewState is module-level observable
// state with no view dependency, so a service may read it (precedent:
// services/acp/commitRefPicker.ts).
import { scmViewState } from '../../workbench/scm/scmViewState.js'

export interface IScmDecoration {
  readonly color: string
  readonly tooltip?: string
  readonly strikeThrough?: boolean
  /** Single status letter shown as a badge (files only; folders omit it). */
  readonly letter?: string
}

/**
 * A file's server-side condition, pushed by the provider outside any resource
 * group (see `SourceControlSupplementaryDecoration`). Rendered as trailing grey
 * text on the Explorer row.
 *
 * Deliberately a separate map from `files` rather than extra fields on
 * IScmDecoration: supplementary answers "what the server says", and a
 * clean-but-behind file must not count as locally changed (see `hasChanges`).
 */
export interface IScmSupplementary {
  readonly description: string
  readonly tooltip?: string
}

export interface IScmDecorationsSnapshot {
  readonly files: ReadonlyMap<string, IScmDecoration>
  readonly folders: ReadonlyMap<string, IScmDecoration>
  readonly supplementary: ReadonlyMap<string, IScmSupplementary>
}

export interface IScmDecorationsService {
  readonly _serviceBrand: undefined
  readonly decorations: IObservable<IScmDecorationsSnapshot>
  getFile(resource: URI): IScmDecoration | undefined
  getFolder(resource: URI): IScmDecoration | undefined
  getSupplementary(resource: URI): IScmSupplementary | undefined
  /**
   * Whether ANY provider reports the resource as changed — deliberately not
   * scoped to the selected repo. The decorations above are selection-scoped
   * (display), but "does this file have local changes" gates behaviour
   * (dirty-diff open-changes, the editor-title compare icon) that must keep
   * working for a file owned by an unselected provider.
   */
  hasChanges(resource: URI): boolean
}

export const IScmDecorationsService =
  createDecorator<IScmDecorationsService>('scmDecorationsService')

/**
 * Case-insensitive, separator-agnostic path key, matching the SCM view's keying.
 *
 * This is a self-contained SCM-domain key (like MonacoModelRegistry's model key):
 * the decoration Map and every lookup go through this one function, so it only has
 * to agree with itself, never with filesystem identity elsewhere. It is therefore
 * intentionally NOT routed through IUriIdentityService — keep all SCM keying here.
 */

export function scmPathKey(p: string): string {
  // eslint-disable-next-line no-restricted-syntax -- centralized SCM-domain key (see doc above)
  return p.replace(/\\/g, '/').toLowerCase()
}

/** Weight of a deleting change — the strongest non-conflict state. */
const LETTER_WEIGHT_DELETE = 4

/** Higher wins when several changes fold into one folder colour. */
const LETTER_WEIGHT: Record<string, number> = {
  U: 5, // conflict / unmerged
  D: LETTER_WEIGHT_DELETE, // deleted
  M: 4, // modified
  R: 4, // renamed
  C: 4, // copied
  A: 2, // added
  RC: 2, // on disk but not opened in any changelist (perforce working-tree drift)
  '?': 1, // untracked
}

/** The badge letter shown to the user; untracked reads as "U" like VSCode. */
export function badgeLetter(contextValue: string): string {
  return contextValue === '?' ? 'U' : contextValue
}

export class ScmDecorationsService extends Disposable implements IScmDecorationsService {
  declare readonly _serviceBrand: undefined

  readonly decorations: IObservable<IScmDecorationsSnapshot>
  /** Paths any provider reports as changed, selected repo or not (see `hasChanges`). */
  private readonly _anyProviderChanges: IObservable<ReadonlySet<string>>

  constructor(
    @IScmService private readonly _scm: IScmService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
  ) {
    super()
    // `_key` resolves the host imperatively, so switching workspaces silently
    // changes what every lookup answers. Feed that into `decorations` so a
    // consumer subscribed to it re-runs its lookups — without this the snapshot
    // is unchanged (same providers) and stale colours stick until the next
    // resourceStates push.
    const workspaceEpoch = observableValue<number>('scmDecorationsWorkspaceEpoch', 0)
    this._register(
      this._workspace.onDidChangeWorkspace(() =>
        workspaceEpoch.set(workspaceEpoch.get() + 1, undefined),
      ),
    )
    this.decorations = derived((reader) => {
      workspaceEpoch.read(reader)
      const sourceControls = this._scm.sourceControls.read(reader)
      // Decorations mirror the repo the SCM view is showing, not the workspace
      // sum: in a mixed workspace where git and perforce report the same path,
      // the unselected provider's decoration is dropped instead of overlaying
      // the selected one's.
      const selected = resolveSelectedSourceControl(
        sourceControls,
        scmViewState.selectedRepo.read(reader),
      )
      const files = new Map<string, IScmDecoration>()
      // Track the winning weight per folder so a stronger descendant overrides.
      const folders = new Map<string, IScmDecoration>()
      const folderWeight = new Map<string, number>()
      const supplementary = new Map<string, IScmSupplementary>()

      for (const sc of sourceControls) {
        if (sc !== selected) continue
        const root = sc.rootUri !== undefined ? scmPathKey(sc.rootUri) : undefined
        for (const group of sc.groups.read(reader)) {
          for (const res of group.resources.read(reader)) {
            const letter = res.contextValue ?? 'M'
            const color = res.decorations?.color ?? '#cccccc'
            const key = scmPathKey(res.resourceUri)
            // A provider can mark a row struck-through without its letter saying
            // `D`: perforce files every reconcile action under the single letter
            // `RC`, so the delete case is only visible here.
            const strikeThrough = res.decorations?.strikeThrough === true || letter === 'D'
            // Later groups (working tree) override earlier ones (staged), so the
            // file shows its most user-relevant state.
            files.set(key, {
              color,
              letter: badgeLetter(letter),
              ...(res.decorations?.tooltip !== undefined
                ? { tooltip: res.decorations.tooltip }
                : {}),
              ...(strikeThrough ? { strikeThrough: true } : {}),
            })

            // A deletion outranks any non-deleting change of the same letter
            // class — without this an `RC` delete's red would lose the folder to
            // whichever `RC` edit the iteration happened to reach first. `max`
            // rather than assignment so it can only ever raise (a struck-through
            // conflict keeps its higher weight).
            const base = LETTER_WEIGHT[letter] ?? 3
            const weight = strikeThrough ? Math.max(base, LETTER_WEIGHT_DELETE) : base
            for (const dir of ancestors(key, root)) {
              const prev = folderWeight.get(dir)
              if (prev === undefined || weight > prev) {
                folderWeight.set(dir, weight)
                folders.set(dir, {
                  color,
                  ...(res.decorations?.tooltip !== undefined
                    ? { tooltip: res.decorations.tooltip }
                    : {}),
                })
              }
            }
          }
        }

        // Supplementary lives alongside the group-derived maps, never merged
        // into them: the two answer different questions ("what I did" vs "what
        // the server says"), and both can be true for the same file. Folders get
        // nothing — grey text is a per-file hint and would be meaningless
        // aggregated up a tree.
        for (const deco of sc.supplementary.read(reader).values()) {
          supplementary.set(scmPathKey(deco.resourceUri), {
            description: deco.description,
            ...(deco.tooltip !== undefined ? { tooltip: deco.tooltip } : {}),
          })
        }
      }

      return { files, folders, supplementary }
    })
    this._anyProviderChanges = derived((reader) => {
      const keys = new Set<string>()
      for (const sc of this._scm.sourceControls.read(reader)) {
        for (const group of sc.groups.read(reader)) {
          for (const res of group.resources.read(reader)) {
            keys.add(scmPathKey(res.resourceUri))
          }
        }
      }
      return keys
    })
  }

  getFile(resource: URI): IScmDecoration | undefined {
    const key = this._key(resource)
    return key !== undefined ? this.decorations.get().files.get(key) : undefined
  }

  getFolder(resource: URI): IScmDecoration | undefined {
    const key = this._key(resource)
    return key !== undefined ? this.decorations.get().folders.get(key) : undefined
  }

  getSupplementary(resource: URI): IScmSupplementary | undefined {
    const key = this._key(resource)
    return key !== undefined ? this.decorations.get().supplementary.get(key) : undefined
  }

  hasChanges(resource: URI): boolean {
    const key = this._key(resource)
    return key !== undefined && this._anyProviderChanges.get().has(key)
  }

  /** Decoration key for a resource, or undefined when it is off the SCM host. */
  private _key(resource: URI): string | undefined {
    const fsPath = scmHostPath(resource, currentRemoteAuthority(this._workspace.current))
    return fsPath !== undefined ? scmPathKey(fsPath) : undefined
  }
}

/** Ancestor folder keys of `fileKey`, stopping at (and excluding) `root` when known. */
function ancestors(fileKey: string, root: string | undefined): string[] {
  const out: string[] = []
  let dir = parentDir(fileKey)
  while (dir && (root === undefined || dir.length >= root.length)) {
    out.push(dir)
    if (root !== undefined && dir === root) break
    const next = parentDir(dir)
    if (next === dir) break
    dir = next
  }
  return out
}

/** Parent directory of an {@link scmPathKey key}, '' once the path top is reached. */
export function parentDir(key: string): string {
  const i = key.lastIndexOf('/')
  return i <= 0 ? '' : key.slice(0, i)
}
