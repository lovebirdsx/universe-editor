/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CustomEditorHost — renders a CustomEditorInput by opening a webview panel via
 *  the WebviewService (which asks the owning extension to resolve it) and mounting
 *  the resulting iframe. The panel is opened once per mounted editor and closed
 *  when the tab unmounts, so the host-side document/webview are torn down too.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { localize, type IEditorInput } from '@universe-editor/platform'
import { customEditorActivationEvent } from '@universe-editor/extensions-common'
import { useService } from '../useService.js'
import {
  IWebviewService,
  type IWebviewPanelModel,
} from '../../services/extensions/WebviewService.js'
import { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'
import { CustomEditorInput } from '../../services/editor/CustomEditorInput.js'
import { WebviewElement } from '../webview/WebviewElement.js'
import styles from './CustomEditorHost.module.css'

export function CustomEditorHost({ input }: { input: IEditorInput }) {
  const customInput = input as CustomEditorInput
  const webviewService = useService(IWebviewService)
  const extensionHost = useService(IExtensionHostClientService)
  const [panel, setPanel] = useState<IWebviewPanelModel | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let opened: IWebviewPanelModel | undefined
    setFailed(false)
    setPanel(null)

    // Make sure the owning extension is activated. On a normal open the editor
    // resolver factory fires `onCustomEditor:<viewType>` for us, but a window
    // restore deserializes the CustomEditorInput directly (bypassing the resolver)
    // — without this the extension never activates, no provider registers, and the
    // restored tab stays blank. Activation is idempotent, so the normal path is
    // unaffected. The provider then arrives via onDidChangeProviders (retry below).
    void extensionHost.activateByEvent(customEditorActivationEvent(customInput.viewType))

    // The provider registers asynchronously: opening the file fires the
    // `onCustomEditor:` activation event, the extension activates in the host,
    // and its provider registration round-trips back over RPC. So try now and
    // retry whenever the provider set changes, giving up only if the extension
    // never registers a provider for this viewType.
    const tryOpen = (): boolean => {
      opened = webviewService.openPanel(customInput.viewType, customInput.resource)
      if (opened) {
        setPanel(opened)
        return true
      }
      return false
    }

    let sub: { dispose(): void } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!tryOpen()) {
      sub = webviewService.onDidChangeProviders(() => {
        if (opened) return
        if (tryOpen()) clearTimeout(timer)
      })
      // If no provider ever registers (extension missing/broken), surface a
      // message rather than a permanent blank.
      timer = setTimeout(() => {
        if (!opened) setFailed(true)
      }, 15000)
    }

    return () => {
      sub?.dispose()
      clearTimeout(timer)
      if (opened) webviewService.closePanel(opened.panelHandle)
      setPanel(null)
    }
  }, [webviewService, extensionHost, customInput])

  return (
    <div className={styles['customEditorRoot']} data-testid="custom-editor">
      {failed ? (
        <div className={styles['customEditorMessage']}>
          {localize('customEditor.noProvider', 'No extension is available to open this file.')}
        </div>
      ) : panel ? (
        <WebviewElement key={panel.panelHandle} panel={panel} />
      ) : null}
    </div>
  )
}
