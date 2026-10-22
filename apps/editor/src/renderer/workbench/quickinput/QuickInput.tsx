/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host wrapper: subscribes to IQuickInputService, traps focus and portals the
 *  presentational QuickInputPanel (from workbench-ui), injecting the workbench's
 *  icon resolvers.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IQuickInputService, markAsSingleton } from '@universe-editor/platform'
import {
  FocusScopeOverlay,
  OwnerDocumentProvider,
  QuickInputPanel,
  useBackdropDismiss,
} from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { getActiveWorkbenchDocument } from '../../services/windows/workbenchDocuments.js'
import { resolveAgentIcon } from '../agents/agentIcon.js'
import { resolveSessionStatusIcon } from '../agents/sessionStatusIcon.js'
import { resolveIcon } from '../icons/icon-map.js'
import { FileIcon } from '../files/fileIconTheme.js'
import { parseResourceIconId } from '../../services/quickInput/quickPickResourceIcon.js'
import { renderSymbolIconById } from '../symbols/symbolIcon.js'
import {
  QuickInputService,
  type QuickPickState,
} from '../../services/quickInput/QuickInputService.js'
import styles from './QuickInput.module.css'

function resolveFallbackIcon(iconId: string) {
  return resolveIcon(iconId) ?? resolveAgentIcon(iconId)
}

/** Portal that renders Quick Pick / Input Box over the entire workbench. */
export function QuickInputPortal() {
  const quickInputService = useService(IQuickInputService)
  const svc = quickInputService as QuickInputService
  const [panelState, setPanelState] = useState<QuickPickState | null>(svc.currentState)

  useEffect(() => {
    const d = markAsSingleton(svc.onDidChangeState((s) => setPanelState(s)))
    setPanelState(svc.currentState)
    return () => d.dispose()
  }, [svc])

  const close = () => {
    // A renderer dialog stacks above the picker (e.g. a delete confirmation
    // raised from one of its rows). Both overlays listen for Escape on the same
    // document, and the picker's listener runs first, so without this guard the
    // dialog's Escape would also close the list the dialog is asking about.
    const ownerDocument = svc.currentDocument ?? document
    if (ownerDocument.querySelector('[data-renderer-dialog]')) return
    svc.hide()
  }

  // Dismiss on backdrop click, but survive a drag whose press starts inside the
  // panel (e.g. selecting text in the path input) and releases over the backdrop.
  // A plain onClick would close in that case since the click's target is the
  // common ancestor of press/release — the backdrop.
  const backdropHandlers = useBackdropDismiss(close)

  if (!panelState) return null

  const targetDocument = svc.currentDocument ?? document
  return createPortal(
    <OwnerDocumentProvider targetDocument={targetDocument}>
      <FocusScopeOverlay
        visible
        onEscape={close}
        targetDocument={targetDocument}
        // An accepted item may reveal an editor in another workbench window and
        // move activation there before React unmounts this overlay; restoring
        // focus into this (now inactive) document would activate it right back.
        shouldRestoreFocus={() => getActiveWorkbenchDocument() === targetDocument}
      >
        <div className={styles['overlay']} data-testid="quick-input-overlay" {...backdropHandlers}>
          <QuickInputPanel
            state={panelState}
            onClose={close}
            targetDocument={targetDocument}
            renderIcon={(id, size, className) => {
              const parsed = parseResourceIconId(id)
              if (parsed) {
                return (
                  <FileIcon
                    resource={parsed.resource}
                    isDirectory={parsed.isDirectory}
                    size={size}
                    className={className}
                  />
                )
              }
              const symbolIcon = renderSymbolIconById(id, size)
              if (symbolIcon) return symbolIcon
              const Icon = resolveFallbackIcon(id)
              return <Icon size={size} className={className} />
            }}
            renderStatusIcon={(id, size, className) => {
              const Icon = resolveSessionStatusIcon(id)
              return <Icon size={size} className={className} />
            }}
            renderTitleButton={(id, size, className) => {
              const Icon = resolveFallbackIcon(id)
              return <Icon size={size} className={className} />
            }}
          />
        </div>
      </FocusScopeOverlay>
    </OwnerDocumentProvider>,
    targetDocument.body,
  )
}
