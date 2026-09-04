/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side owner of the SCM model. Handles the host → renderer
 *  `mainThreadScm` channel (source controls, groups, resource states, input box)
 *  and exposes it as observables the built-in ScmView renders. Commit-box edits
 *  flow back to the host through the `extHostScm` proxy set on connect.
 *
 *  Source controls and groups are keyed by the host-allocated handle. Group
 *  handles are globally unique, so a flat handle → group map suffices for routing
 *  resource updates without walking every provider.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  observableValue,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'
import type {
  ICommandDto,
  IExtHostScm,
  IMainThreadScm,
  ISourceControlFeaturesDto,
  ISourceControlGroupFeaturesDto,
  ISourceControlResourceStateDto,
  ISupplementaryDecorationDeltaDto,
} from '@universe-editor/extensions-common'

export interface IScmGroupModel {
  readonly handle: number
  readonly id: string
  /** Id of the parent group this one nests under, when the provider set one. */
  readonly parentId: string | undefined
  readonly label: IObservable<string>
  readonly hideWhenEmpty: IObservable<boolean>
  readonly resources: IObservable<readonly ISourceControlResourceStateDto[]>
}

/**
 * A file's server-side condition as reported by the provider outside any
 * resource group (behind on this file / held open by someone else). Keyed by the
 * raw `resourceUri` the provider sent; the decorations service normalizes it.
 */
export interface IScmSupplementaryDecoration {
  readonly resourceUri: string
  readonly description: string
  readonly tooltip?: string
}

export interface IScmSourceControlModel {
  readonly handle: number
  readonly id: string
  readonly label: string
  readonly rootUri: string | undefined
  readonly inputValue: IObservable<string>
  readonly inputPlaceholder: IObservable<string>
  readonly count: IObservable<number | undefined>
  /** HEAD commit the provider reports, or undefined when it reports none. */
  readonly headRevision: IObservable<string | undefined>
  readonly acceptCommand: IObservable<ICommandDto | undefined>
  readonly acceptActions: IObservable<readonly ICommandDto[] | undefined>
  readonly groups: IObservable<readonly IScmGroupModel[]>
  /** Supplementary decorations, by `resourceUri` exactly as the provider sent it. */
  readonly supplementary: IObservable<ReadonlyMap<string, IScmSupplementaryDecoration>>
}

export interface IScmService {
  readonly _serviceBrand: undefined
  readonly sourceControls: IObservable<readonly IScmSourceControlModel[]>
  /** A user edit in the commit box: update the model and report it to the host. */
  changeInputBoxValue(handle: number, value: string): void
  /** Wire the host proxy once the extension host connection is up. */
  setExtHost(extHost: IExtHostScm): void
  /** Drop all registered source controls (called when the extension host tears down). */
  resetSourceControls(): void
}

export const IScmService = createDecorator<IScmService>('scmService')

/**
 * The source control the SCM view is currently showing: the one whose `rootUri`
 * equals `selectedRootUri`, falling back to the first registered one when the
 * selection is unset or points at a repo that isn't registered (yet). This is
 * the single arbitration shared by every "mirror the SCM view's repo" consumer
 * (activity badge, Explorer/tab decorations, active-repo broadcast).
 */
export function resolveSelectedSourceControl(
  sourceControls: readonly IScmSourceControlModel[],
  selectedRootUri: string | undefined,
): IScmSourceControlModel | undefined {
  return sourceControls.find((sc) => sc.rootUri === selectedRootUri) ?? sourceControls[0]
}

/**
 * Resolve which SCM provider owns `fsPath` — the source control whose `rootUri`
 * is the longest prefix of the path. Returns its provider id (e.g. `'git'` /
 * `'perforce'`), so host features (dirty-diff baseline, blame) can address the
 * owning provider's contributed commands as `<providerId>.<capability>` instead
 * of hardcoding one SCM. Returns undefined when no provider contains the path.
 *
 * When several providers own the path (e.g. a git repo nested inside a Perforce
 * workspace), the owner whose root equals `selectedRootUri` wins over the
 * longest-prefix heuristic; falls back to the longest prefix when the selection
 * matches none of the owners (or is absent).
 *
 * Keying goes through {@link scmProviderPathKey} (separator-agnostic, lower-cased)
 * — a self-contained SCM-domain key, deliberately not routed through
 * IUriIdentityService (mirrors ScmDecorationsService's scmPathKey rationale).
 */
export function resolveScmProviderId(
  sourceControls: readonly IScmSourceControlModel[],
  fsPath: string,
  selectedRootUri?: string,
): string | undefined {
  const target = scmProviderPathKey(fsPath)
  const selectedKey =
    selectedRootUri !== undefined ? scmProviderPathKey(selectedRootUri) : undefined
  let bestId: string | undefined
  let bestLen = -1
  let selectedId: string | undefined
  for (const sc of sourceControls) {
    if (sc.rootUri === undefined) continue
    const root = scmProviderPathKey(sc.rootUri)
    if (target !== root && !target.startsWith(`${root}/`)) continue
    if (root.length > bestLen) {
      bestId = sc.id
      bestLen = root.length
    }
    // Among the owners, the one whose root the SCM view has selected wins over
    // the longest-prefix heuristic (e.g. a git repo nested inside a Perforce
    // workspace, where the user picked the outer repo in the view). First hit
    // sticks when several providers share the same root (mirrors the
    // registration-order tie-break of the heuristic above).
    if (selectedId === undefined && selectedKey !== undefined && root === selectedKey) {
      selectedId = sc.id
    }
  }
  return selectedId ?? bestId
}

/**
 * {@link resolveScmProviderId}, restricted to owners satisfying `predicate`.
 * Same selected-wins → longest-prefix arbitration, but the longest-prefix
 * fallback only considers providers the predicate accepts — so a capable outer
 * provider (a Perforce workspace) beats a more specific but incapable nested one
 * (a git repo that never registered the capability in question). The selected
 * repo still wins regardless of the predicate: routing to a repo the user
 * explicitly picked is the intent even when that repo cannot answer, since the
 * SCM view is showing its slot and the others' are hidden.
 */
export function resolveScmProviderIdWhere(
  sourceControls: readonly IScmSourceControlModel[],
  fsPath: string,
  selectedRootUri: string | undefined,
  predicate: (providerId: string) => boolean,
): string | undefined {
  const target = scmProviderPathKey(fsPath)
  const selectedKey =
    selectedRootUri !== undefined ? scmProviderPathKey(selectedRootUri) : undefined
  let bestId: string | undefined
  let bestLen = -1
  let selectedId: string | undefined
  for (const sc of sourceControls) {
    if (sc.rootUri === undefined) continue
    const root = scmProviderPathKey(sc.rootUri)
    if (target !== root && !target.startsWith(`${root}/`)) continue
    if (selectedId === undefined && selectedKey !== undefined && root === selectedKey) {
      selectedId = sc.id
    }
    if (!predicate(sc.id)) continue
    if (root.length > bestLen) {
      bestId = sc.id
      bestLen = root.length
    }
  }
  return selectedId ?? bestId
}

/**
 * All SCM provider ids whose root contains `fsPath` — a resource can belong to
 * more than one provider at once (e.g. a git repo nested inside a Perforce
 * workspace, so files under it are tracked by both). Unlike
 * {@link resolveScmProviderId} (which picks the single most-specific owner for
 * dirty-diff / blame command routing), this returns every owner so menu gating
 * can ask "is provider X one of the owners?" — otherwise a nested git repo would
 * hide the outer Perforce actions.
 *
 * Deduplicated by provider id (multiple roots of the same provider count once),
 * preserving first-seen order.
 */
export function resolveScmProviderIds(
  sourceControls: readonly IScmSourceControlModel[],
  fsPath: string,
): string[] {
  const target = scmProviderPathKey(fsPath)
  const ids: string[] = []
  for (const sc of sourceControls) {
    if (sc.rootUri === undefined) continue
    const root = scmProviderPathKey(sc.rootUri)
    if ((target === root || target.startsWith(`${root}/`)) && !ids.includes(sc.id)) {
      ids.push(sc.id)
    }
  }
  return ids
}

/**
 * Encode the owning-provider ids as a `when`-clause-matchable context key value.
 * Pipe-delimited on both ends (`|git|perforce|`) so a menu can test membership
 * with a regex — `resourceScmProvider =~ /\|perforce\|/` — without a substring
 * matching e.g. `perforce` against a hypothetical `perforce-graph`. Empty string
 * when nothing owns the path.
 */
export function encodeScmProviderIds(ids: readonly string[]): string {
  return ids.length ? `|${ids.join('|')}|` : ''
}

/** Separator-agnostic, case-insensitive path key for provider routing. */
export function scmProviderPathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

class ScmGroupModel implements IScmGroupModel {
  readonly label: ISettableObservable<string>
  readonly hideWhenEmpty = observableValue<boolean>('scmGroupHideWhenEmpty', false)
  readonly resources = observableValue<readonly ISourceControlResourceStateDto[]>(
    'scmGroupResources',
    [],
  )

  constructor(
    readonly handle: number,
    readonly id: string,
    label: string,
    readonly parentId: string | undefined,
  ) {
    this.label = observableValue<string>('scmGroupLabel', label)
  }
}

class ScmSourceControlModel implements IScmSourceControlModel {
  readonly inputValue = observableValue<string>('scmInputValue', '')
  readonly inputPlaceholder = observableValue<string>('scmInputPlaceholder', '')
  readonly count = observableValue<number | undefined>('scmCount', undefined)
  readonly headRevision = observableValue<string | undefined>('scmHeadRevision', undefined)
  readonly acceptCommand = observableValue<ICommandDto | undefined>('scmAcceptCommand', undefined)
  readonly acceptActions = observableValue<readonly ICommandDto[] | undefined>(
    'scmAcceptActions',
    undefined,
  )
  readonly groups = observableValue<readonly IScmGroupModel[]>('scmGroups', [])
  readonly supplementary = observableValue<ReadonlyMap<string, IScmSupplementaryDecoration>>(
    'scmSupplementary',
    new Map(),
  )
  /** Live groups in registration order; `groups` observable mirrors this. */
  readonly groupOrder: ScmGroupModel[] = []

  constructor(
    readonly handle: number,
    readonly id: string,
    readonly label: string,
    readonly rootUri: string | undefined,
  ) {}
}

export class ScmService extends Disposable implements IScmService, IMainThreadScm {
  declare readonly _serviceBrand: undefined

  private readonly _sourceControls = observableValue<readonly IScmSourceControlModel[]>(
    'scmSourceControls',
    [],
  )
  private readonly _byHandle = new Map<number, ScmSourceControlModel>()
  private readonly _groupsByHandle = new Map<
    number,
    { sc: ScmSourceControlModel; group: ScmGroupModel }
  >()
  private _extHost: IExtHostScm | undefined

  get sourceControls(): IObservable<readonly IScmSourceControlModel[]> {
    return this._sourceControls
  }

  setExtHost(extHost: IExtHostScm): void {
    this._extHost = extHost
  }

  resetSourceControls(): void {
    this._byHandle.clear()
    this._groupsByHandle.clear()
    this._sourceControls.set([], undefined)
  }

  changeInputBoxValue(handle: number, value: string): void {
    this._byHandle.get(handle)?.inputValue.set(value, undefined)
    void this._extHost?.$onInputBoxValueChange(handle, value)
  }

  // --- IMainThreadScm (called from the host) ---

  $registerSourceControl(
    handle: number,
    id: string,
    label: string,
    rootUri?: string,
  ): Promise<void> {
    const model = new ScmSourceControlModel(handle, id, label, rootUri)
    this._byHandle.set(handle, model)
    this._sourceControls.set([...this._byHandle.values()], undefined)
    return Promise.resolve()
  }

  $updateSourceControl(handle: number, features: ISourceControlFeaturesDto): Promise<void> {
    const model = this._byHandle.get(handle)
    if (model) {
      if (features.count !== undefined) model.count.set(features.count, undefined)
      if (features.headRevision !== undefined) {
        model.headRevision.set(features.headRevision ?? undefined, undefined)
      }
      if (features.acceptInputCommand !== undefined) {
        model.acceptCommand.set(features.acceptInputCommand, undefined)
      }
      if (features.acceptInputActions !== undefined) {
        model.acceptActions.set(features.acceptInputActions, undefined)
      }
    }
    return Promise.resolve()
  }

  $unregisterSourceControl(handle: number): Promise<void> {
    const model = this._byHandle.get(handle)
    if (model) {
      for (const group of model.groupOrder) this._groupsByHandle.delete(group.handle)
      this._byHandle.delete(handle)
      this._sourceControls.set([...this._byHandle.values()], undefined)
    }
    return Promise.resolve()
  }

  $registerGroup(
    sourceControlHandle: number,
    groupHandle: number,
    id: string,
    label: string,
    parentId?: string,
  ): Promise<void> {
    const sc = this._byHandle.get(sourceControlHandle)
    if (sc) {
      const group = new ScmGroupModel(groupHandle, id, label, parentId)
      sc.groupOrder.push(group)
      sc.groups.set([...sc.groupOrder], undefined)
      this._groupsByHandle.set(groupHandle, { sc, group })
    }
    return Promise.resolve()
  }

  $updateGroup(groupHandle: number, features: ISourceControlGroupFeaturesDto): Promise<void> {
    const entry = this._groupsByHandle.get(groupHandle)
    if (entry) {
      if (features.label !== undefined) entry.group.label.set(features.label, undefined)
      if (features.hideWhenEmpty !== undefined) {
        entry.group.hideWhenEmpty.set(features.hideWhenEmpty, undefined)
      }
    }
    return Promise.resolve()
  }

  $updateGroupResourceStates(
    groupHandle: number,
    resources: ISourceControlResourceStateDto[],
  ): Promise<void> {
    this._groupsByHandle.get(groupHandle)?.group.resources.set(resources, undefined)
    return Promise.resolve()
  }

  $updateSupplementaryDecorations(
    sourceControlHandle: number,
    deltas: ISupplementaryDecorationDeltaDto[],
  ): Promise<void> {
    const model = this._byHandle.get(sourceControlHandle)
    if (model) {
      const next = new Map(model.supplementary.get())
      for (const delta of deltas) {
        if (delta.description === null) {
          next.delete(delta.resourceUri)
        } else {
          next.set(delta.resourceUri, {
            resourceUri: delta.resourceUri,
            description: delta.description,
            ...(delta.tooltip !== undefined ? { tooltip: delta.tooltip } : {}),
          })
        }
      }
      model.supplementary.set(next, undefined)
    }
    return Promise.resolve()
  }

  $unregisterGroup(groupHandle: number): Promise<void> {
    const entry = this._groupsByHandle.get(groupHandle)
    if (entry) {
      const { sc, group } = entry
      const index = sc.groupOrder.indexOf(group)
      if (index !== -1) sc.groupOrder.splice(index, 1)
      sc.groups.set([...sc.groupOrder], undefined)
      this._groupsByHandle.delete(groupHandle)
    }
    return Promise.resolve()
  }

  $setInputBoxValue(sourceControlHandle: number, value: string): Promise<void> {
    this._byHandle.get(sourceControlHandle)?.inputValue.set(value, undefined)
    return Promise.resolve()
  }

  $setInputBoxPlaceholder(sourceControlHandle: number, placeholder: string): Promise<void> {
    this._byHandle.get(sourceControlHandle)?.inputPlaceholder.set(placeholder, undefined)
    return Promise.resolve()
  }
}
