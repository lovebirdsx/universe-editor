/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HtmlPreviewEditor — renders an HtmlPreviewInput's source file inside a live
 *  iframe. The iframe navigates straight at the file over the `universe-app://`
 *  resource protocol, so the page's own relative assets (css / js / images)
 *  resolve to the document's directory the way a browser would. Scripts run
 *  (sandbox allows them); this is our on-demand equivalent of VSCode's Live
 *  Preview, not a sanitising renderer.
 *
 *  Origin/CSP notes are the same as WebviewElement's: local resources are served
 *  from the single `universe-app://root` origin, which a secure custom scheme
 *  treats as same-origin — so navigating the iframe there lets its sub-resource
 *  requests through. We grant read access to the document's dir + workspace root
 *  BEFORE setting src, so the first asset requests aren't 403'd by the allow-list.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import {
  IFileWatcherService,
  IWorkspaceService,
  markAsSingleton,
  type IEditorInput,
} from '@universe-editor/platform'
import { IResourceAccessService } from '../../../shared/ipc/resourceAccessService.js'
import { HtmlPreviewInput } from '../../services/editor/HtmlPreviewInput.js'
import { dirnameOfResource } from '../files/resourceInfo.js'
import { toResourceUrl } from '../markdown/resourceUri.js'
import { useOptionalService } from '../useService.js'
import styles from './HtmlPreviewEditor.module.css'

export function HtmlPreviewEditor({ input }: { input: IEditorInput }) {
  const resourceAccess = useOptionalService(IResourceAccessService)
  const watcher = useOptionalService(IFileWatcherService)
  const workspaceFolder = useOptionalService(IWorkspaceService)?.current?.folder

  const sourceUri = (input as HtmlPreviewInput).sourceUri
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  // A cache-buster bumped on save / external change so the iframe reloads.
  const [reloadToken, setReloadToken] = useState(0)
  const [ready, setReady] = useState(false)

  // Grant the app protocol read access to the document's directory and the
  // workspace root, THEN mark ready so the iframe src is set (mirrors
  // WebviewElement's grant-before-load ordering to avoid 403 races on the
  // page's own relative assets).
  useEffect(() => {
    let cancelled = false
    const roots = [dirnameOfResource(sourceUri), workspaceFolder?.fsPath].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    )
    const grant = async (): Promise<void> => {
      if (resourceAccess && roots.length > 0) await resourceAccess.allowRoots(roots)
      if (!cancelled) setReady(true)
    }
    void grant()
    return () => {
      cancelled = true
    }
  }, [resourceAccess, sourceUri, workspaceFolder])

  // Reload the preview when the underlying file changes on disk (a save from the
  // source editor, or an external edit). We also bump when the live Monaco model
  // fires a content change *and the file has since been saved* — but tracking
  // save state adds little for the common case, so watch the filesystem only.
  useEffect(() => {
    if (!watcher) return
    const key = sourceUri.toString()
    const d = markAsSingleton(
      watcher.onDidChangeFiles((events) => {
        if (events.some((e) => e.resource.toString() === key)) {
          setReloadToken((t) => t + 1)
        }
      }),
    )
    return () => d.dispose()
  }, [watcher, sourceUri])

  const src = ready ? withReloadToken(toResourceUrl(sourceUri.fsPath), reloadToken) : undefined

  return (
    <div className={styles['htmlPreviewRoot']} data-testid="html-preview">
      {src !== undefined && (
        <iframe
          ref={iframeRef}
          className={styles['htmlPreviewFrame']}
          src={src}
          // allow-same-origin so the page's `universe-app://root` sub-resources
          // load; allow-scripts so the page's own JS runs (Live-Preview parity).
          sandbox="allow-scripts allow-same-origin"
          title={(input as HtmlPreviewInput).getName()}
        />
      )}
    </div>
  )
}

/** Append a cache-busting query so re-setting src forces the iframe to reload. */
function withReloadToken(url: string, token: number): string {
  if (token === 0) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_t=${token}`
}
