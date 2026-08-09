/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  graphOutline — shared Go to Symbol / Outline bridge for the Git Graph and
 *  Perforce Graph editors. Both are plain React trees (no Monaco), so
 *  OutlineService can't reach them through FileEditorRegistry; the registry
 *  here is the equivalent handle, mirroring AcpSessionOutlineRegistry.
 *
 *  The mounted graph editor registers a controller exposing its loaded commit
 *  list as an observable plus select/scroll operations. OutlineService turns
 *  the commits into a flat DocumentSymbol tree (one symbol per commit, a
 *  pseudo-line per row) via graphCommitsToOutline, so the '@' quick pick and
 *  the Outline sidebar list commits like symbols. Accepting a symbol selects
 *  the commit with full row-click semantics (pushing COMMIT CHANGES);
 *  live-preview only scrolls.
 *
 *  Shared by both graphs (like graphLayout.ts): the registry is keyed by the
 *  editor input's TYPE_ID, since each graph editor is a singleton.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type IObservable } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

/** Language ids published on the OutlineModel so symbolIcon can special-case rows. */
export const GIT_GRAPH_OUTLINE_LANGUAGE_ID = 'gitGraph'
export const PERFORCE_GRAPH_OUTLINE_LANGUAGE_ID = 'perforceGraph'

/** Graph outline kinds encode the row type, avoiding Monaco's 0-based SymbolKind
 *  range (0–25); symbolIcon.tsx maps them to codicons via the same SYMBOL_ICONS
 *  table the regular kinds use. */
export const GRAPH_COMMIT_KIND = 200
export const GRAPH_PENDING_KIND = 201

/** One row of a graph editor, as the outline sees it. */
export interface GraphOutlineCommit {
  /** Commit hash (git) or changelist id (p4); the controller's select/scroll key. */
  readonly hash: string
  /** Row label — the commit subject / changelist title. */
  readonly label: string
  /** Secondary text shown as the pick description and used as a search keyword. */
  readonly detail: string
  /** Uncommitted / pending-changelist row (renders with GRAPH_PENDING_KIND). */
  readonly pending?: boolean
}

export interface IGraphOutlineController {
  /** The graph's loaded rows, in display order. */
  readonly commits: IObservable<readonly GraphOutlineCommit[]>
  /** Accept semantics: select the commit as a row click would (pushing COMMIT
   *  CHANGES), scroll it into view and move focus back to the graph. */
  selectCommit(hash: string): void
  /** Live preview: scroll the commit into view WITHOUT selecting it or
   *  fetching its changes payload. */
  scrollToCommit(hash: string): void
  /** The singly-selected row's hash, or undefined when nothing / a range is selected. */
  getSelectedHash(): string | undefined
  /** Fires when the graph's selection may have changed. */
  readonly onDidChangeSelection: Emitter<void>['event']
}

export type GraphOutlineKind =
  | typeof GIT_GRAPH_OUTLINE_LANGUAGE_ID
  | typeof PERFORCE_GRAPH_OUTLINE_LANGUAGE_ID

class GraphOutlineRegistryImpl {
  private readonly _map = new Map<GraphOutlineKind, IGraphOutlineController[]>()
  private readonly _onDidChange = new Emitter<GraphOutlineKind>()
  readonly onDidChange = this._onDidChange.event

  register(kind: GraphOutlineKind, controller: IGraphOutlineController): void {
    const list = this._map.get(kind) ?? []
    list.push(controller)
    this._map.set(kind, list)
    this._onDidChange.fire(kind)
  }

  unregister(kind: GraphOutlineKind, controller: IGraphOutlineController): void {
    const list = this._map.get(kind)
    if (!list) return
    const index = list.indexOf(controller)
    if (index === -1) return
    list.splice(index, 1)
    if (list.length === 0) this._map.delete(kind)
    this._onDidChange.fire(kind)
  }

  get(kind: GraphOutlineKind): IGraphOutlineController | undefined {
    const list = this._map.get(kind)
    if (!list || list.length === 0) return undefined
    return list[list.length - 1]
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const GraphOutlineRegistry = new GraphOutlineRegistryImpl()

export interface GraphOutline {
  readonly roots: monaco.languages.DocumentSymbol[]
  /** Pseudo-line (1-based) → commit hash, for turning a symbol into a reveal target. */
  readonly keyByLine: ReadonlyMap<number, string>
  /** Commit hash → pseudo-line, for turning the selected row into an active symbol. */
  readonly lineByKey: ReadonlyMap<string, number>
}

function lineRange(line: number): monaco.IRange {
  return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }
}

/**
 * Build a flat DocumentSymbol tree from the graph's rows: one symbol per commit
 * in display order, each on its own pseudo-line, with hash↔line maps bridging
 * the line-based outline and the hash-based graph (same trick as
 * timelineToOutline, minus the nesting).
 */
export function graphCommitsToOutline(commits: readonly GraphOutlineCommit[]): GraphOutline {
  const keyByLine = new Map<number, string>()
  const lineByKey = new Map<string, number>()
  const roots: monaco.languages.DocumentSymbol[] = commits.map((commit, i) => {
    const line = i + 1
    keyByLine.set(line, commit.hash)
    lineByKey.set(commit.hash, line)
    return {
      name: commit.label,
      detail: commit.detail,
      kind: (commit.pending
        ? GRAPH_PENDING_KIND
        : GRAPH_COMMIT_KIND) as monaco.languages.SymbolKind,
      tags: [],
      range: lineRange(line),
      selectionRange: lineRange(line),
      children: [],
    }
  })
  return { roots, keyByLine, lineByKey }
}
