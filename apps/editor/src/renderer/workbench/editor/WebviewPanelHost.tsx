/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WebviewPanelHost — renders a WebviewPanelInput (an extension-owned panel from
 *  `window.createWebviewPanel`). Unlike CustomEditorHost it does NOT open or
 *  resolve the panel: the WebviewService already holds the live model (the host
 *  created it over RPC); this view only mounts the shared WebviewElement for it.
 *
 *  The panel outlives this view — switching away to another tab unmounts us but
 *  keeps the model alive (the iframe's html/options are observable state, and the
 *  loader inside the frame re-accepts the html on remount), so a hidden panel
 *  keeps running. Only the user closing the tab (or the host disposing) tears it
 *  down, via the input's onWillDispose → WebviewService.closePanel.
 *
 *  View state (active/visible) is NOT reported from here: the WebviewService
 *  tracks the editor groups (active-group / active-editor changes) and reports
 *  transitions itself, so a preserveFocus-created panel never claims active and
 *  a group focus switch reaches the host even though this view never unmounted.
 *--------------------------------------------------------------------------------------------*/

import { useEffect } from 'react'
import type { IEditorInput } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { IWebviewService } from '../../services/extensions/WebviewService.js'
import { WebviewPanelInput } from '../../services/editor/WebviewPanelInput.js'
import { WebviewFocusRegistry } from '../../services/editor/WebviewFocusRegistry.js'
import { WebviewElement } from '../webview/WebviewElement.js'

export function WebviewPanelHost({ input }: { input: IEditorInput }) {
  const webviewService = useService(IWebviewService)
  const panelInput = input as WebviewPanelInput
  const panel = webviewService.getPanel(panelInput.panelHandle)

  useEffect(() => {
    // Move keyboard focus into the iframe once its controller registers (it does
    // so on the WebviewElement mount below; the registry queues this if late).
    WebviewFocusRegistry.requestFocus(panelInput.viewType, panelInput.focusResource)
  }, [panelInput])

  return panel ? <WebviewElement key={panel.panelHandle} panel={panel} /> : null
}
