/**
 * Maps parsed git status into SCM resource states + file decorations. Pure
 * transforms (status → rows) split out of repository.ts; no git I/O here.
 */
import { join } from 'node:path'
import type { SourceControlResourceState } from '@universe-editor/extension-api'
import type { GitFileStatus } from './statusParser.js'

interface Decoration {
  readonly color: string
  readonly tooltip: string
}

const DECORATIONS: Record<string, Decoration> = {
  M: { color: '#e2c08d', tooltip: 'Modified' },
  A: { color: '#73c991', tooltip: 'Added' },
  D: { color: '#c74e39', tooltip: 'Deleted' },
  R: { color: '#e2c08d', tooltip: 'Renamed' },
  C: { color: '#e2c08d', tooltip: 'Copied' },
  U: { color: '#c74e39', tooltip: 'Conflict' },
  '?': { color: '#73c991', tooltip: 'Untracked' },
}

function toResourceState(
  root: string,
  path: string,
  letter: string,
  mergeEditor: boolean,
): SourceControlResourceState {
  const decoration = DECORATIONS[letter] ?? { color: '#cccccc', tooltip: letter }
  // Conflicted (unmerged) files open the 3-way merge editor when enabled;
  // everything else opens a working-tree diff.
  const command =
    letter === 'U' && mergeEditor
      ? { command: 'git.openMergeEditor', title: 'Resolve in Merge Editor' }
      : { command: 'git.openChange', title: 'Open Changes' }
  return {
    resourceUri: join(root, path),
    contextValue: letter,
    decorations: { tooltip: decoration.tooltip, color: decoration.color },
    command,
  }
}

export function stagedStates(
  root: string,
  files: readonly GitFileStatus[],
  mergeEditor: boolean,
): SourceControlResourceState[] {
  return files
    .filter((f) => f.kind === 'tracked' && f.index !== '.')
    .map((f) => toResourceState(root, f.path, f.index, mergeEditor))
}

export function workingStates(
  root: string,
  files: readonly GitFileStatus[],
  mergeEditor: boolean,
): SourceControlResourceState[] {
  return files
    .filter((f) => f.workingTree !== '.')
    .map((f) => toResourceState(root, f.path, f.workingTree, mergeEditor))
}
