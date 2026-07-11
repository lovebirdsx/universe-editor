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
import { parentOf } from '../../services/explorer/explorerTreeUtils.js'
import {
  IScmService,
  encodeScmProviderIds,
  resolveScmProviderIds,
  type IScmSourceControlModel,
} from '../../services/extensions/ScmService.js'
import { useObservable, useOptionalService } from '../useService.js'

const EMPTY_SOURCE_CONTROLS: IObservable<readonly IScmSourceControlModel[]> = observableValue(
  'emptyScmProviders',
  [],
)

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
  // Delete, OpenWithDefaultApp), plus `parent` (NewFile, NewFolder): when the
  // clicked node is a directory use it directly; otherwise strip the filename.
  const resource = target.resource
  const isDirectory = target.isDirectory
  const parent = target.isDirectory ? target.resource : (parentOf(target.resource) ?? rootResource)
  const isRoot = tree?.isRoot(resource) ?? resource.toString() === rootResource.toString()
  const hasClipboard = tree?.hasClipboard ?? false
  const hasCutItems = tree?.hasCutItems ?? false
  const resourceScheme = resource.scheme

  // Which SCM provider(s) own this resource — so provider-specific Explorer
  // actions (e.g. Perforce checkout) only show inside that provider's workspace,
  // not for any file. A resource can belong to several providers at once (a git
  // repo nested in a Perforce workspace), so encode all owners and gate menus
  // with a membership regex. Mirrors the dirty-diff / blame host generalization:
  // the app core stays free of any single SCM's name.
  const scmService = useOptionalService(IScmService)
  const sourceControls = useObservable(scmService?.sourceControls ?? EMPTY_SOURCE_CONTROLS)
  const resourceScmProvider =
    resourceScheme === 'file'
      ? encodeScmProviderIds(resolveScmProviderIds(sourceControls, resource.fsPath))
      : ''

  const scopedContext = useMemo(
    () =>
      contextKeyService
        ? markAsSingleton(
            contextKeyService.createScoped({
              explorerResourceIsFolder: isDirectory,
              explorerResourceIsRoot: isRoot,
              resourceScheme,
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
      resourceScheme,
      resourceScmProvider,
      hasClipboard,
      hasCutItems,
    ],
  )

  useEffect(() => () => scopedContext?.dispose(), [scopedContext])

  return (
    <ContextMenu
      menuId={MenuId.ExplorerContext}
      anchor={{ x: state.x, y: state.y }}
      args={[
        {
          target: resource,
          resource: resource,
          parent,
          isDirectory,
        },
      ]}
      commandService={commandService}
      {...(scopedContext ? { contextKeyService: scopedContext } : {})}
      onClose={onClose}
    />
  )
}
