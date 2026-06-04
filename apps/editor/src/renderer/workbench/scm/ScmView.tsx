/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ScmView — the built-in Source Control viewlet. It renders whatever
 *  SourceControl providers extensions register through the `scm` API (mirrored
 *  into IScmService): a commit box, the provider's title actions, and its
 *  resource groups with per-row inline actions.
 *
 *  The view owns no git knowledge — providers supply resource states, commands
 *  and decorations; menu contributions (scm/title, scm/resourceState/context)
 *  supply the actions. Clicking an action runs its command through the normal
 *  command flow (→ extension host).
 *--------------------------------------------------------------------------------------------*/

import { useMemo, type CSSProperties } from 'react'
import {
  CommandsRegistry,
  ContextKeyExpr,
  ICommandService,
  isSubmenuEntry,
  MenuId,
  MenuRegistry,
  localize,
  type IContext,
  type ContextKeyExpression,
} from '@universe-editor/platform'
import type {
  ICommandDto,
  ISourceControlResourceStateDto,
} from '@universe-editor/extensions-common'
import { useService, useObservable } from '../useService.js'
import {
  IScmService,
  type IScmGroupModel,
  type IScmSourceControlModel,
} from '../../services/extensions/ScmService.js'
import styles from './ScmView.module.css'

interface ActionItem {
  readonly id: string
  readonly title: string
  readonly command: string
}

function evalWhen(
  when: string | ContextKeyExpression | undefined,
  scope: Record<string, unknown>,
): boolean {
  if (!when) return true
  const expr = typeof when === 'string' ? ContextKeyExpr.deserialize(when) : when
  if (!expr) return true
  return expr.evaluate({ getValue: (key: string) => scope[key] } as IContext)
}

/** Menu items for a location filtered by `when`, resolved to {title, command}. */
function menuActions(menuId: MenuId, scope: Record<string, unknown>, group?: string): ActionItem[] {
  const out: ActionItem[] = []
  for (const entry of MenuRegistry.getMenuItems(menuId)) {
    if (isSubmenuEntry(entry)) continue
    if (group !== undefined && entry.group !== group) continue
    if (!evalWhen(entry.when, scope)) continue
    const cmd = CommandsRegistry.getCommand(entry.command)
    out.push({
      id: entry.command,
      title: entry.title ?? cmd?.metadata?.description ?? entry.command,
      command: entry.command,
    })
  }
  return out
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i === -1 ? path : path.slice(i + 1)
}

function decorationStyle(resource: ISourceControlResourceStateDto): CSSProperties {
  const d = resource.decorations
  if (!d) return {}
  return {
    ...(d.color !== undefined ? { color: d.color } : {}),
    ...(d.strikeThrough ? { textDecoration: 'line-through' } : {}),
    ...(d.faded ? { opacity: 0.6 } : {}),
  }
}

function ScmResourceRow({
  resource,
  scope,
}: {
  resource: ISourceControlResourceStateDto
  scope: Record<string, unknown>
}) {
  const commandService = useService(ICommandService)
  const rowScope = useMemo(
    () => ({ ...scope, scmResourceState: resource.contextValue }),
    [scope, resource.contextValue],
  )
  const inline = useMemo(
    () => menuActions(MenuId.ScmResourceStateContext, rowScope, 'inline'),
    [rowScope],
  )

  const run = (command: string): void => {
    void commandService.executeCommand(command, resource)
  }

  const openChange = (): void => {
    if (resource.command) void commandService.executeCommand(resource.command.command, resource)
  }

  return (
    <li
      className={styles['resource']}
      title={resource.decorations?.tooltip ?? resource.resourceUri}
      onClick={openChange}
    >
      <span className={styles['resourceLabel']} style={decorationStyle(resource)}>
        {basename(resource.resourceUri)}
      </span>
      <span className={styles['resourceActions']}>
        {inline.map((a) => (
          <button
            key={a.id}
            type="button"
            className={styles['actionButton']}
            title={a.title}
            onClick={(e) => {
              e.stopPropagation()
              run(a.command)
            }}
          >
            {a.title}
          </button>
        ))}
        {resource.contextValue !== undefined && (
          <span className={styles['statusLetter']}>{resource.contextValue}</span>
        )}
      </span>
    </li>
  )
}

function ScmGroupView({ group, scope }: { group: IScmGroupModel; scope: Record<string, unknown> }) {
  const label = useObservable(group.label)
  const hideWhenEmpty = useObservable(group.hideWhenEmpty)
  const resources = useObservable(group.resources)
  const groupScope = useMemo(() => ({ ...scope, scmResourceGroup: group.id }), [scope, group.id])

  if (resources.length === 0 && hideWhenEmpty) return null

  return (
    <div className={styles['group']}>
      <div className={styles['groupHeader']}>
        <span className={styles['groupLabel']}>{label}</span>
        <span className={styles['groupCount']}>{resources.length}</span>
      </div>
      <ul className={styles['resources']}>
        {resources.map((r) => (
          <ScmResourceRow key={r.resourceUri} resource={r} scope={groupScope} />
        ))}
      </ul>
    </div>
  )
}

function ScmProviderView({ model }: { model: IScmSourceControlModel }) {
  const scm = useService(IScmService)
  const commandService = useService(ICommandService)
  const inputValue = useObservable(model.inputValue)
  const placeholder = useObservable(model.inputPlaceholder)
  const count = useObservable(model.count)
  const acceptCommand = useObservable(model.acceptCommand)
  const groups = useObservable(model.groups)

  const scope = useMemo(() => ({ scmProvider: model.id }), [model.id])
  const titleActions = useMemo(() => menuActions(MenuId.ScmTitle, scope), [scope])

  const runCommand = (command: ICommandDto | string): void => {
    const id = typeof command === 'string' ? command : command.command
    void commandService.executeCommand(id, { sourceControlId: model.id })
  }

  return (
    <section className={styles['provider']}>
      <div className={styles['providerHeader']}>
        <span className={styles['providerLabel']}>{model.label}</span>
        {count !== undefined && <span className={styles['providerBadge']}>{count}</span>}
        <span className={styles['providerActions']}>
          {titleActions.map((a) => (
            <button
              key={a.id}
              type="button"
              className={styles['actionButton']}
              title={a.title}
              onClick={() => runCommand(a.command)}
            >
              {a.title}
            </button>
          ))}
        </span>
      </div>

      <textarea
        className={styles['commitInput']}
        value={inputValue}
        placeholder={placeholder}
        rows={1}
        onChange={(e) => scm.changeInputBoxValue(model.handle, e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && acceptCommand) {
            e.preventDefault()
            runCommand(acceptCommand)
          }
        }}
      />
      {acceptCommand && (
        <button
          type="button"
          className={styles['commitButton']}
          onClick={() => runCommand(acceptCommand)}
        >
          {acceptCommand.title}
        </button>
      )}

      {groups.map((g) => (
        <ScmGroupView key={g.handle} group={g} scope={scope} />
      ))}
    </section>
  )
}

export function ScmView() {
  const scm = useService(IScmService)
  const sourceControls = useObservable(scm.sourceControls)

  return (
    <div className={styles['scmView']} tabIndex={-1}>
      {sourceControls.length === 0 ? (
        <div className={styles['empty']}>
          {localize('scm.empty', 'No source control providers registered.')}
        </div>
      ) : (
        sourceControls.map((sc) => <ScmProviderView key={sc.handle} model={sc} />)
      )}
    </div>
  )
}
