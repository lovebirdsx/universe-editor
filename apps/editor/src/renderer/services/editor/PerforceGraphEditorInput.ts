/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Perforce Graph editor input. Optional path scope: a scoped input
 *  bakes its scope into `resource` (and therefore `id`), so each path opens in
 *  its own tab and deserialises back to the same tab on window restore. See
 *  memory `editor-input-identity-isolation`.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, localize } from '@universe-editor/platform'
import { getPerforceGraphViewState } from '../perforceGraph/perforceGraphViewState.js'

export interface PerforceGraphScope {
  /** SCM 主机上的路径（已由 scmHostPath 解析过，是裸路径不是 URI）。 */
  path: string
  isDirectory: boolean
  /** tab 与工具栏展示用的短名（basename）。 */
  label: string
}

interface ISerializedPerforceGraphScope {
  readonly path: string
  readonly isDirectory: boolean
  readonly label: string
}

const PERFORCE_GRAPH_URI = URI.from({ scheme: 'universe', path: '/perforceGraph' })

/** Deterministic query encoding: the key order is fixed by this literal, so the
 *  same scope always yields the same query string — otherwise the same tab
 *  would open repeatedly instead of deduping by id. */
function encodeScope(scope: PerforceGraphScope): string {
  return JSON.stringify({
    path: scope.path,
    isDirectory: scope.isDirectory,
    label: scope.label,
  })
}

export class PerforceGraphEditorInput extends EditorInput {
  static readonly TYPE_ID = 'perforceGraph'

  constructor(private readonly _scope?: PerforceGraphScope) {
    super()
  }

  get scope(): PerforceGraphScope | undefined {
    return this._scope
  }

  static deserialize(data: unknown): PerforceGraphEditorInput | null {
    // 旧格式（无 scope）：undefined / null / 空对象 → 无 scope 实例。
    if (data === undefined || data === null) return new PerforceGraphEditorInput()
    if (typeof data !== 'object' || Array.isArray(data)) return null
    const d = data as Record<string, unknown>
    const { path, isDirectory, label } = d
    if (path === undefined && isDirectory === undefined && label === undefined) {
      return new PerforceGraphEditorInput()
    }
    if (typeof path !== 'string' || typeof isDirectory !== 'boolean' || typeof label !== 'string') {
      return null
    }
    return new PerforceGraphEditorInput({ path, isDirectory, label })
  }

  get typeId(): string {
    return PerforceGraphEditorInput.TYPE_ID
  }

  get resource(): URI {
    if (!this._scope) return PERFORCE_GRAPH_URI
    return URI.from({ scheme: 'universe', path: '/perforceGraph', query: encodeScope(this._scope) })
  }

  getName(): string {
    if (!this._scope) return 'Perforce Graph'
    return localize('perforceGraph.scopedTitle', 'History: {label}', { label: this._scope.label })
  }

  override serialize(): ISerializedPerforceGraphScope | undefined {
    if (!this._scope) return undefined
    return {
      path: this._scope.path,
      isDirectory: this._scope.isDirectory,
      label: this._scope.label,
    }
  }

  /** Route focus into the graph's row list (not the editor-group body) so
   *  arrow-key navigation works as soon as the tab opens — the graph is a
   *  plain React tree with no Monaco registration. */
  override focus(): boolean {
    const focusRows = getPerforceGraphViewState(this.id).focusRows
    if (!focusRows) return false
    focusRows()
    return true
  }
}
