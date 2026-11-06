/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File/folder breadcrumb picker: an anchored tree of the parent directory.
 *  Folders expand lazily; clicking a file opens it in the same editor group.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef, useState, type FocusEvent, type HTMLAttributes } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  IContextKeyService,
  IEditorResolverService,
  IFileService,
  IUriIdentityService,
  IWorkspaceService,
  localize,
  URI,
} from '@universe-editor/platform'
import {
  AnchoredSurface,
  Tree,
  TreeModel,
  useOwnedTreeModel,
  useOwnerDocument,
} from '@universe-editor/workbench-ui'
import { useOptionalService } from '../../useService.js'
import { IExcludeService } from '../../../services/exclude/ExcludeService.js'
import { FileIcon } from '../../files/fileIconTheme.js'
import { focusEditorInput } from '../../../services/editor/editorFocus.js'
import { useEditorGroup } from '../EditorGroupContext.js'
import {
  BREADCRUMB_PICKER_ATTRIBUTE,
  computeBreadcrumbPickerLayout,
  type BreadcrumbPickerAnchor,
} from './breadcrumbPickerLayout.js'
import { FilePickerDataSource, type FilePickerEntry } from './filePickerModel.js'
import styles from './BreadcrumbsPicker.module.css'

interface FileBreadcrumbPickerProps {
  readonly anchor: BreadcrumbPickerAnchor
  readonly root: URI
  readonly focusResource: URI | undefined
  readonly onClose: () => void
  readonly onFocus?: () => void
  readonly onBlur?: (event: FocusEvent<HTMLDivElement>) => void
}

export function FileBreadcrumbPicker({
  anchor,
  root,
  focusResource,
  onClose,
  onFocus,
  onBlur,
}: FileBreadcrumbPickerProps) {
  const ownerDocument = useOwnerDocument()
  const group = useEditorGroup()
  const fileService = useOptionalService(IFileService)
  const uriIdentity = useOptionalService(IUriIdentityService)
  const workspaceService = useOptionalService(IWorkspaceService)
  const excludeService = useOptionalService(IExcludeService)
  const resolver = useOptionalService(IEditorResolverService)
  const contextKeyService = useOptionalService(IContextKeyService)
  const workspace = workspaceService?.current ?? null

  const dataSource = useMemo(() => {
    if (!fileService || !uriIdentity) return null
    return new FilePickerDataSource(
      root,
      focusResource,
      workspace,
      uriIdentity,
      fileService,
      excludeService,
    )
  }, [root, focusResource, workspace, uriIdentity, fileService, excludeService])

  const model = useOwnedTreeModel<FilePickerEntry>(() => {
    if (!dataSource) throw new Error('File breadcrumb picker requires IFileService')
    return new TreeModel<FilePickerEntry>({ dataSource })
  })

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [rootCount, setRootCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!dataSource) {
      setStatus('error')
      setError(localize('breadcrumbs.filePicker.error', 'Unable to load this folder.'))
      return
    }
    let cancelled = false
    setStatus('loading')
    setError(null)
    dataSource
      .loadRoot()
      .then(() => {
        if (cancelled) return
        model.refresh()
        const roots = dataSource.getRoots()
        setRootCount(roots.length)
        const focused = focusResource ? dataSource.findRootChild(focusResource) : undefined
        const initial = focused ?? roots[0]
        if (initial) model.setSelection([initial.id], initial.id)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setStatus('error')
        setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [dataSource, model, focusResource])

  useEffect(() => {
    if (status !== 'ready') return
    treeRef.current?.focus({ preventScroll: true })
  }, [status, rootCount])

  const layout = computeBreadcrumbPickerLayout(anchor, {
    width: ownerDocument?.defaultView?.innerWidth ?? window.innerWidth,
    height: ownerDocument?.defaultView?.innerHeight ?? window.innerHeight,
  })

  const openEntry = (entry: FilePickerEntry): void => {
    if (!group || !resolver) return
    const input = resolver.createEditorInput(entry.resource)
    group.openEditor(input, { activate: true, pinned: true })
    onClose()
    requestAnimationFrame(() => {
      if (contextKeyService) focusEditorInput(input, contextKeyService, group.id)
    })
  }

  return (
    <AnchoredSurface
      x={layout.x}
      y={layout.y}
      placement="bottom-start"
      onClose={onClose}
      surfaceProps={
        {
          className: styles['surface'],
          style: { width: layout.width },
          [BREADCRUMB_PICKER_ATTRIBUTE]: '',
          'data-testid': 'breadcrumbs-file-picker',
          role: 'dialog',
          'aria-label': localize('breadcrumbs.filePicker.ariaLabel', 'Select a file'),
          ...(onFocus ? { onFocusCapture: onFocus } : {}),
          ...(onBlur ? { onBlurCapture: onBlur } : {}),
        } as HTMLAttributes<HTMLDivElement>
      }
    >
      <div className={styles['body']} style={{ maxHeight: layout.maxHeight }}>
        {status === 'loading' && (
          <div className={styles['status']}>
            {localize('breadcrumbs.filePicker.loading', 'Loading…')}
          </div>
        )}
        {status === 'error' && (
          <div className={styles['status']}>
            {localize('breadcrumbs.filePicker.error', 'Unable to load this folder.')}
            {error ? ` ${error}` : ''}
          </div>
        )}
        {status === 'ready' && rootCount === 0 && (
          <div className={styles['status']}>
            {localize('breadcrumbs.filePicker.empty', 'No files found.')}
          </div>
        )}
        {status === 'ready' && rootCount > 0 && (
          <Tree
            model={model}
            rootRef={treeRef}
            className={styles['tree'] ?? ''}
            ariaLabel={localize('breadcrumbs.filePicker.ariaLabel', 'Select a file')}
            rowHeight={22}
            renderRow={({ node, isSelected, indentPadding, onToggle, style }) => {
              const entry = node.element
              return (
                <div
                  className={styles['row']}
                  style={{ ...style, paddingLeft: indentPadding }}
                  role="treeitem"
                  aria-selected={isSelected}
                  {...(node.hasChildren ? { 'aria-expanded': node.expanded } : {})}
                  data-selected={isSelected}
                  onClick={(e) => {
                    e.stopPropagation()
                    model.setSelection([entry.id], entry.id, { reveal: false })
                    if (entry.isDirectory || e.detail > 1) return
                    openEntry(entry)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (entry.isDirectory) void model.toggle(entry)
                  }}
                >
                  {node.hasChildren ? (
                    <button
                      type="button"
                      className={styles['twistie']}
                      tabIndex={-1}
                      aria-label={
                        node.expanded
                          ? localize('breadcrumbs.filePicker.collapse', 'Collapse folder')
                          : localize('breadcrumbs.filePicker.expand', 'Expand folder')
                      }
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggle()
                      }}
                    >
                      <ChevronRight
                        size={14}
                        style={{ transform: node.expanded ? 'rotate(90deg)' : undefined }}
                      />
                    </button>
                  ) : (
                    <span className={styles['twistieSpacer']} aria-hidden="true" />
                  )}
                  <span className={styles['icon']} aria-hidden="true">
                    <FileIcon
                      resource={entry.resource}
                      isDirectory={entry.isDirectory}
                      expanded={node.expanded}
                      size={14}
                    />
                  </span>
                  <span className={styles['label']}>{entry.name}</span>
                </div>
              )
            }}
            onActivate={(node) => {
              if (!node.element.isDirectory) openEntry(node.element)
            }}
          />
        )}
      </div>
    </AnchoredSurface>
  )
}
