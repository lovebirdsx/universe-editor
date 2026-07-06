/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renders the icon-button row driven by the given menu. The ContextKeyService
 *  passed in is owned by the parent (ViewPane / ViewContainerHeader / SideBar)
 *  and carries the `view` key, so a `when: 'view == ...'` clause makes the
 *  action follow its view wherever the view is rendered.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, IContextKeyService, MenuId } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { useViewTitleActions } from './useViewTitleActions.js'
import { resolveHeaderIcon } from './icon-map.js'
import styles from './ViewTitleActions.module.css'

interface Props {
  menuId: MenuId
  contextKeyService: IContextKeyService
  group?: string
  actionArg?: unknown
}

export function ViewTitleActions({ menuId, contextKeyService, group, actionArg }: Props) {
  const commandService = useService(ICommandService)
  const actions = useViewTitleActions(menuId, contextKeyService, group)

  if (actions.length === 0) return null

  const viewId = contextKeyService.get('view')
  const arg = actionArg ?? viewId

  return (
    <>
      {actions.map((a) => {
        const Icon = resolveHeaderIcon(a.icon)
        const tooltip = a.shortcut ? `${a.label} (${a.shortcut})` : a.label
        return (
          <button
            key={a.command}
            className={styles['actionBtn']}
            onClick={() => void commandService.executeCommand(a.command, arg)}
            title={tooltip}
            aria-label={tooltip}
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
