/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Perforce Graph editor input. Optional path scope: a scoped input
 *  bakes its scope into `resource` (and therefore `id`), so each path opens in
 *  its own tab and deserialises back to the same tab on window restore. See
 *  memory `editor-input-identity-isolation`.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, localize } from '@universe-editor/platform'
import { getPerforceGraphViewState } from '../perforceGraph/perforceGraphViewState.js'
import {
  normalizeGraphScopeSelection,
  scopePathKey,
  type GraphScopePath,
} from '../perforceGraph/graphScopeSelection.js'

export interface PerforceGraphScope {
  /**
   * SCM 主机上的路径集合（已由 scmHostPath 解析过，是裸路径不是 URI），**必须**
   * 经 `normalizeGraphScopeSelection` 规范化（去重 + 排序）——它是 tab 身份的一
   * 部分，未规范化会让同一选区按点击顺序开出多个 tab。多于一项 = 合并历史。
   */
  paths: readonly GraphScopePath[]
  /** tab 与工具栏展示用的短名（首项 basename，多选时带 `+N`）。 */
  label: string
}

interface ISerializedPerforceGraphScope {
  readonly paths: readonly GraphScopePath[]
}

const PERFORCE_GRAPH_URI = URI.from({ scheme: 'universe', path: '/perforceGraph' })

/** Deterministic query encoding: the key order is fixed by these literals, so the
 *  same scope always yields the same query string — otherwise the same tab
 *  would open repeatedly instead of deduping by id. `paths` is already sorted by
 *  `normalizeGraphScopeSelection`, and each path goes through `scopePathKey` so
 *  the id folds the same file reached by a differently-cased drive letter into one
 *  tab (the same key the selection is deduped by). `label` is derived state,
 *  encoded anyway so a restored tab shows its title before the graph loads. */
function encodeScope(scope: PerforceGraphScope): string {
  return JSON.stringify({
    paths: scope.paths.map((p) => ({ path: scopePathKey(p.path), isDirectory: p.isDirectory })),
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
    const paths = (data as Record<string, unknown>)['paths']
    if (paths === undefined) return new PerforceGraphEditorInput()
    if (!Array.isArray(paths)) return null
    const parsed: GraphScopePath[] = []
    for (const entry of paths) {
      if (entry === null || typeof entry !== 'object') return null
      const e = entry as Record<string, unknown>
      if (typeof e['path'] !== 'string' || e['path'] === '') return null
      if (typeof e['isDirectory'] !== 'boolean') return null
      parsed.push({ path: e['path'], isDirectory: e['isDirectory'] })
    }
    if (parsed.length === 0) return new PerforceGraphEditorInput()
    // Recompute the label rather than trusting the serialized one — it's derived
    // state, and the normalized order is what the id must match.
    return new PerforceGraphEditorInput(normalizeGraphScopeSelection(parsed))
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
      paths: this._scope.paths.map((p) => ({ path: p.path, isDirectory: p.isDirectory })),
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
