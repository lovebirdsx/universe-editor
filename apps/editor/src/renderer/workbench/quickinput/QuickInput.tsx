/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host wrapper: subscribes to IQuickInputService, traps focus and portals the
 *  presentational QuickInputPanel (from workbench-ui), injecting the workbench's
 *  icon resolvers.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IQuickInputService, markAsSingleton } from '@universe-editor/platform'
import { FocusScopeOverlay, QuickInputPanel } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { resolveAgentIcon } from '../agents/agentIcon.js'
import { resolveSessionStatusIcon } from '../agents/sessionStatusIcon.js'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import { FileIcon } from '../files/fileIconTheme.js'
import { parseResourceIconId } from '../../services/quickInput/quickPickResourceIcon.js'
import { resolveSymbolKindIcon } from './symbolKindIcon.js'
import {
  QuickInputService,
  type QuickPickState,
} from '../../services/quickInput/QuickInputService.js'
import styles from './QuickInput.module.css'

function resolveQuickInputIcon(iconId: string) {
  return resolveSymbolKindIcon(iconId) ?? resolveHeaderIcon(iconId) ?? resolveAgentIcon(iconId)
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

  if (!panelState) return null

  const close = () => svc.hide()

  return createPortal(
    <FocusScopeOverlay visible onEscape={close}>
      <div className={styles['overlay']} onClick={close} data-testid="quick-input-overlay">
        <div onClick={(e) => e.stopPropagation()}>
          <QuickInputPanel
            state={panelState}
            onClose={close}
            renderIcon={(id, size, className) => {
              const resource = parseResourceIconId(id)
              if (resource) {
                return (
                  <FileIcon
                    resource={resource}
                    isDirectory={false}
                    size={size}
                    className={className}
                  />
                )
              }
              const Icon = resolveQuickInputIcon(id)
              return <Icon size={size} className={className} />
            }}
            renderStatusIcon={(id, size, className) => {
              const Icon = resolveSessionStatusIcon(id)
              return <Icon size={size} className={className} />
            }}
          />
        </div>
      </div>
    </FocusScopeOverlay>,
    document.body,
  )
}
