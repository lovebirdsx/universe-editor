/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmDecorationsService — derives a by-URI lookup of git status decorations from
 *  the SCM model. The git extension pushes one resource per change (with a status
 *  letter and a VSCode-matching colour); this service folds those into two maps:
 *  `files` (the file's own status) and `folders` (status propagated up to every
 *  ancestor directory, so a changed file tints its enclosing folders). Both the
 *  Explorer rows and the editor tabs consume it to colour file names.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  derived,
  type IObservable,
  type URI,
} from '@universe-editor/platform'
import type { IScmService } from '../extensions/ScmService.js'

export interface IScmDecoration {
  readonly color: string
  readonly tooltip?: string
  readonly strikeThrough?: boolean
  /** Single status letter shown as a badge (files only; folders omit it). */
  readonly letter?: string
}

export interface IScmDecorationsSnapshot {
  readonly files: ReadonlyMap<string, IScmDecoration>
  readonly folders: ReadonlyMap<string, IScmDecoration>
}

export interface IScmDecorationsService {
  readonly _serviceBrand: undefined
  readonly decorations: IObservable<IScmDecorationsSnapshot>
  getFile(resource: URI): IScmDecoration | undefined
  getFolder(resource: URI): IScmDecoration | undefined
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

/** Higher wins when several changes fold into one folder colour. */
const LETTER_WEIGHT: Record<string, number> = {
  U: 5, // conflict / unmerged
  D: 4, // deleted
  M: 4, // modified
  R: 4, // renamed
  C: 4, // copied
  A: 2, // added
  '?': 1, // untracked
}

/** The badge letter shown to the user; untracked reads as "U" like VSCode. */
export function badgeLetter(contextValue: string): string {
  return contextValue === '?' ? 'U' : contextValue
}

export class ScmDecorationsService extends Disposable implements IScmDecorationsService {
  declare readonly _serviceBrand: undefined

  readonly decorations: IObservable<IScmDecorationsSnapshot>

  constructor(private readonly _scm: IScmService) {
    super()
    this.decorations = derived((reader) => {
      const files = new Map<string, IScmDecoration>()
      // Track the winning weight per folder so a stronger descendant overrides.
      const folders = new Map<string, IScmDecoration>()
      const folderWeight = new Map<string, number>()

      for (const sc of this._scm.sourceControls.read(reader)) {
        const root = sc.rootUri !== undefined ? scmPathKey(sc.rootUri) : undefined
        for (const group of sc.groups.read(reader)) {
          for (const res of group.resources.read(reader)) {
            const letter = res.contextValue ?? 'M'
            const color = res.decorations?.color ?? '#cccccc'
            const key = scmPathKey(res.resourceUri)
            // Later groups (working tree) override earlier ones (staged), so the
            // file shows its most user-relevant state.
            files.set(key, {
              color,
              letter: badgeLetter(letter),
              ...(res.decorations?.tooltip !== undefined
                ? { tooltip: res.decorations.tooltip }
                : {}),
              ...(letter === 'D' ? { strikeThrough: true } : {}),
            })

            const weight = LETTER_WEIGHT[letter] ?? 3
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
      }

      return { files, folders }
    })
  }

  getFile(resource: URI): IScmDecoration | undefined {
    return this.decorations.get().files.get(scmPathKey(resource.fsPath))
  }

  getFolder(resource: URI): IScmDecoration | undefined {
    return this.decorations.get().folders.get(scmPathKey(resource.fsPath))
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

function parentDir(key: string): string {
  const i = key.lastIndexOf('/')
  return i <= 0 ? '' : key.slice(0, i)
}
