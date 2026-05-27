/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renders the icon-button row driven by `MenuId.ViewContainerTitle`. The
 *  ContextKeyService passed in is owned by the parent ViewContainerHeader
 *  and carries `activeViewContainer` / `activeViewContainerLocation`, so a
 *  `when: 'activeViewContainer == ...'` clause makes the action follow its
 *  container across locations.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, IContextKeyService, MenuId } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { useViewTitleActions } from './useViewTitleActions.js'
import { resolveHeaderIcon } from './icon-map.js'
import styles from './ViewContainerHeader.module.css'

interface Props {
  contextKeyService: IContextKeyService
}

export function ViewTitleActions({ contextKeyService }: Props) {
  const commandService = useService(ICommandService)
  const actions = useViewTitleActions(MenuId.ViewContainerTitle, contextKeyService)

  if (actions.length === 0) return null

  return (
    <>
      {actions.map((a) => {
        const Icon = resolveHeaderIcon(a.icon)
        return (
          <button
            key={a.command}
            className={styles['actionBtn']}
            onClick={() => void commandService.executeCommand(a.command)}
            title={a.label}
            aria-label={a.label}
            data-testid={`view-title-action-${a.command}`}
          >
            {Icon ? (
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <span className={styles['actionFallback']}>{a.label.slice(0, 2)}</span>
            )}
          </button>
        )
      })}
    </>
  )
}
