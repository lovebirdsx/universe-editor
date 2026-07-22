/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renders the icon-button row driven by the given menu. The ContextKeyService
 *  passed in is owned by the parent (ViewPane / ViewContainerHeader / SideBar)
 *  and carries the `view` key, so a `when: 'view == ...'` clause makes the
 *  action follow its view wherever the view is rendered.
 *
 *  A clicked button stays disabled with its own icon spinning until the
 *  command's promise settles (the git syncing idiom), so a long-running action
 *  like a view refresh can't be re-triggered mid-flight and the progress hint
 *  sits right where the user clicked.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
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
  /** Commands currently in flight, driving each button's disabled + spin state. */
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())

  if (actions.length === 0) return null

  const viewId = contextKeyService.get('view')
  const arg = actionArg ?? viewId

  const runAction = (command: string): void => {
    setPending((prev) => (prev.has(command) ? prev : new Set(prev).add(command)))
    void commandService
      .executeCommand(command, arg)
      // CommandService already logs the failure; the button must recover either way.
      .catch(() => undefined)
      .finally(() =>
        setPending((prev) => {
          if (!prev.has(command)) return prev
          const next = new Set(prev)
          next.delete(command)
          return next
        }),
      )
  }

  return (
    <>
      {actions.map((a) => {
        const Icon = resolveHeaderIcon(a.icon)
        const busy = pending.has(a.command)
        // A busy button keeps its own icon spinning; a command without an icon
        // falls back to a generic spinner so some feedback remains.
        const Glyph = busy ? (Icon ?? Loader2) : Icon
        const tooltip = a.shortcut ? `${a.label} (${a.shortcut})` : a.label
        return (
          <button
            key={a.command}
            className={styles['actionBtn']}
            disabled={busy}
            onClick={() => runAction(a.command)}
            title={tooltip}
            aria-label={tooltip}
            data-testid={`view-title-action-${a.command}`}
          >
            {Glyph ? (
              <Glyph
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                {...(busy
                  ? { className: styles['spin'], 'data-testid': 'view-title-action-spin' }
                  : {})}
              />
            ) : (
              <span className={styles['actionFallback']}>{a.label.slice(0, 2)}</span>
            )}
          </button>
        )
      })}
    </>
  )
}
