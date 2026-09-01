/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerContextMenu — thin wrapper that delegates to the workbench-ui ContextMenu.
 *  Items come from MenuRegistry (ExplorerMenuContribution registers them at BlockStartup).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo } from 'react'
import {
  markAsSingleton,
  observableValue,
  type ICommandService,
  type IContextKeyService,
  MenuId,
} from '@universe-editor/platform'
import { ContextMenu } from '@universe-editor/workbench-ui'
import type { IObservable, URI } from '@universe-editor/platform'
import type { ExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
import { parentOf, relativeTo, sameUri } from '../../services/explorer/explorerTreeUtils.js'
import { IFocusScopeService } from '../../services/focus/FocusScopeService.js'
import {
  IScmService,
  encodeScmProviderIds,
  resolveScmProviderIds,
  type IScmSourceControlModel,
} from '../../services/extensions/ScmService.js'
import { scmHostPath } from '../../services/scm/scmHostPath.js'
import { useRemoteAuthority } from '../useRemoteAuthority.js'
import { useObservable, useOptionalService } from '../useService.js'

const EMPTY_SOURCE_CONTROLS: IObservable<readonly IScmSourceControlModel[]> = observableValue(
  'emptyScmProviders',
  [],
)

/** The resource's extension incl. leading dot, lowercased (`.xlsx`), or '' when
 *  none — matches VSCode's `resourceExtname` context key. */
function extnameOf(resource: URI): string {
  const path = resource.path
  const slash = path.lastIndexOf('/')
  const base = slash >= 0 ? path.slice(slash + 1) : path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

export interface ContextMenuState {
  readonly x: number
  readonly y: number
  /** Null when the user right-clicked an empty area; commands fall back to root. */
  readonly target: { resource: URI; isDirectory: boolean } | null
}

interface Props {
  readonly state: ContextMenuState
  readonly rootResource: URI
  readonly commandService: ICommandService
  readonly contextKeyService?: IContextKeyService
  readonly tree?: ExplorerTreeService
  readonly onClose: () => void
}

export function ExplorerContextMenu({
  state,
  rootResource,
  commandService,
  contextKeyService,
  tree,
  onClose,
}: Props) {
  const target = state.target ?? { resource: rootResource, isDirectory: true }

  // Expose both `resource` (RevealInOSExplorer, Refresh) and `target` (Rename,
  // Delete, OpenWithDefaultApp); `parent` (NewFile, NewFolder) is derived in
  // the args memo below.
  const resource = target.resource
  const isDirectory = target.isDirectory
  const isRoot = tree?.isRoot(resource) ?? resource.toString() === rootResource.toString()
  const hasClipboard = tree?.hasClipboard ?? false
  const hasCutItems = tree?.hasCutItems ?? false
  const resourceScheme = resource.scheme
  // The clicked file's extension incl. leading dot, lowercased (VSCode's
  // `resourceExtname`), so extensions can gate Explorer menus by file type.
  const resourceExtname = extnameOf(resource)

  // Which SCM provider(s) own this resource — so provider-specific Explorer
  // actions (e.g. Perforce checkout) only show inside that provider's workspace,
  // not for any file. A resource can belong to several providers at once (a git
  // repo nested in a Perforce workspace), so encode all owners and gate menus
  // with a membership regex. Mirrors the dirty-diff / blame host generalization:
  // the app core stays free of any single SCM's name.
  const scmService = useOptionalService(IScmService)
  const sourceControls = useObservable(scmService?.sourceControls ?? EMPTY_SOURCE_CONTROLS)
  const remoteAuthority = useRemoteAuthority()
  const scmPath = scmHostPath(resource, remoteAuthority)
  const resourceScmProvider =
    scmPath !== undefined
      ? encodeScmProviderIds(resolveScmProviderIds(sourceControls, scmPath))
      : ''

  // Whether the clicked directory is itself a configured focus folder — swaps
  // the "Focus on This Folder" / "Add to Focus" entries for "Remove from Focus".
  const focusScopeService = useOptionalService(IFocusScopeService)
  const explorerResourceIsFocusFolder =
    isDirectory &&
    !isRoot &&
    (focusScopeService?.isFocusFolder(relativeTo(rootResource, resource)) ?? false)

  // Multi-select support (SCM parity): the second arg mirrors ScmView's
  // `(primary, selection)` convention — an array of `{ resource, isDirectory }`
  // so extension commands fan out over the whole selection. Only materialized
  // for row right-clicks: the empty-area menu acts on the root alone.
  const contextSelection = useMemo(() => {
    const t = state.target
    if (!t) return undefined
    const primary = t.resource
    const operations = tree?.getContextResourceOperations(primary) ?? [
      { resource: primary, isDirectory: t.isDirectory },
    ]
    return (
      operations
        // The workspace root is never included (resolveContextOperations parity):
        // the tree auto-selects it on focus, and `<root>/...` would fan a
        // file-selection command out over the whole workspace.
        .filter((op) => !tree?.isRoot(op.resource))
        .map((op) => {
          // The clicked row's own flag is authoritative (compact-folder middle
          // segments are not resolvable via tree.isDirectory()), mirroring
          // resolveContextOperations.
          const isDirectory = sameUri(op.resource, primary) ? t.isDirectory : op.isDirectory
          return isDirectory
            ? { resource: op.resource, isDirectory: true }
            : { resource: op.resource }
        })
    )
  }, [tree, state.target])

  const scopedContext = useMemo(
    () =>
      contextKeyService
        ? markAsSingleton(
            contextKeyService.createScoped({
              explorerResourceIsFolder: isDirectory,
              explorerResourceIsRoot: isRoot,
              explorerResourceIsFocusFolder,
              resourceScheme,
              resourceExtname,
              resourceScmProvider,
              fileCopied: hasClipboard,
              explorerResourceCut: hasCutItems,
            }),
          )
        : undefined,
    [
      contextKeyService,
      isDirectory,
      isRoot,
      explorerResourceIsFocusFolder,
      resourceScheme,
      resourceExtname,
      resourceScmProvider,
      hasClipboard,
      hasCutItems,
    ],
  )

  useEffect(() => () => scopedContext?.dispose(), [scopedContext])

  const args = useMemo(() => {
    // `parent` (NewFile, NewFolder): when the clicked node is a directory use
    // it directly; otherwise strip the filename. Computed inside the memo —
    // `parentOf` returns a fresh URI each call, which would defeat the memo.
    const parent = isDirectory ? resource : (parentOf(resource) ?? rootResource)
    return [
      { target: resource, resource, parent, isDirectory },
      ...(contextSelection ? [contextSelection] : []),
    ]
  }, [resource, rootResource, isDirectory, contextSelection])

  return (
    <ContextMenu
      menuId={MenuId.ExplorerContext}
      anchor={{ x: state.x, y: state.y }}
      args={args}
      commandService={commandService}
      {...(scopedContext ? { contextKeyService: scopedContext } : {})}
      onClose={onClose}
    />
  )
}
