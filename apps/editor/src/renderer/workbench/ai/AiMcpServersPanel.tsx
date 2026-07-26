/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiMcpServersPanel — the "MCP Servers" category of the AI settings editor.
 *  Visual editor for `acp.mcpServers`, grouped by the scope each definition
 *  lives in:
 *    • User (global)   — <userData>/settings.json            (editable)
 *    • Workspace       — .universe-editor/settings.json      (editable)
 *    • .mcp.json       — workspace root, Claude-Code format  (read-only)
 *    • VSCode layers   — .vscode/settings.json compat        (read-only)
 *  Scopes compose per server name (higher scope wins the same name); rows
 *  shadowed by a higher scope say so instead of silently disappearing, and
 *  entries the wire path would skip surface their validation error. Writes go
 *  through IConfigurationService.update, so UserSettingsSync persists them
 *  back to the owning file with comments/formatting intact.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileJson, Pencil, Plug, Plus, Trash2, TriangleAlert } from 'lucide-react'
import {
  ConfigurationTarget,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorResolverService,
  IUserDataFilesService,
  IWorkspaceService,
  UserDataFile,
  URI,
  localize,
} from '@universe-editor/platform'
import { Badge, Button, Checkbox, IconButton } from '@universe-editor/workbench-ui'
import {
  useEventSubscription,
  useObservable,
  useOptionalService,
  useService,
} from '../useService.js'
import {
  IAcpSessionService,
  type IAcpSession,
  type IAcpSessionService as IAcpSessionServiceType,
} from '../../services/acp/acpSessionService.js'
import {
  mcpServerRawToRecord,
  validateMcpServerEntry,
  writeMcpServerEntry,
  type McpServerEntryValidation,
} from '../../services/acp/acpMcpServers.js'
import { McpServerEditDialog, type McpServerScope } from './McpServerEditDialog.js'
import shellStyles from './AiSettingsEditor.module.css'
import styles from './AiMcpServersPanel.module.css'

const CONFIG_KEY = 'acp.mcpServers'

type GroupId = 'user' | 'workspace' | 'vscodeWorkspace' | 'vscodeUser' | 'mcpJson'

interface PanelRow {
  readonly name: string
  readonly raw: unknown
  readonly validation: McpServerEntryValidation
  readonly disabled: boolean
  readonly summary: string
  /** Label of the higher-priority group overriding this name, if any. */
  readonly shadowedBy?: string
}

interface PanelGroup {
  readonly id: GroupId
  readonly label: string
  readonly writable: boolean
  readonly target?: ConfigurationTarget
  readonly file?: UserDataFile
  readonly openCommand?: string
  readonly rows: readonly PanelRow[]
  readonly note?: string
}

/** Groups in display order. Priority for shadow resolution is mcpJson > workspace > vscodeWorkspace > user > vscodeUser. */
const GROUP_DEFS: ReadonlyArray<{
  readonly id: GroupId
  readonly writable: boolean
  readonly target?: ConfigurationTarget
  readonly file?: UserDataFile
  readonly openCommand?: string
}> = [
  {
    id: 'user',
    writable: true,
    target: ConfigurationTarget.User,
    file: UserDataFile.Settings,
    openCommand: 'workbench.action.openSettingsJson',
  },
  {
    id: 'workspace',
    writable: true,
    target: ConfigurationTarget.Project,
    file: UserDataFile.ProjectSettings,
    openCommand: 'workbench.action.openWorkspaceSettingsJson',
  },
  { id: 'mcpJson', writable: false },
  {
    id: 'vscodeWorkspace',
    writable: false,
    target: ConfigurationTarget.VSCodeWorkspace,
    file: UserDataFile.VSCodeSettings,
  },
  {
    id: 'vscodeUser',
    writable: false,
    target: ConfigurationTarget.VSCodeUser,
    file: UserDataFile.VSCodeUserSettings,
  },
]

const GROUP_LABELS: Record<GroupId, () => string> = {
  user: () => localize('aiMcp.scope.user', 'User (global)'),
  workspace: () => localize('aiMcp.scope.workspace', 'Workspace'),
  mcpJson: () => '.mcp.json',
  vscodeWorkspace: () => localize('aiMcp.scope.vscodeWorkspace', 'VSCode workspace (read-only)'),
  vscodeUser: () => localize('aiMcp.scope.vscodeUser', 'VSCode user (read-only)'),
}

/** Shadow priority, lowest first — the last group defining a name wins it. */
const SHADOW_ORDER: readonly GroupId[] = [
  'vscodeUser',
  'user',
  'vscodeWorkspace',
  'workspace',
  'mcpJson',
]

export function AiMcpServersPanel() {
  const sessionService = useOptionalService(IAcpSessionService)
  return <AiMcpServersPanelInner sessionService={sessionService} />
}

function AiMcpServersPanelInner({
  sessionService,
}: {
  readonly sessionService: IAcpSessionServiceType | undefined
}) {
  const config = useService(IConfigurationService)
  const workspace = useService(IWorkspaceService)
  const userData = useService(IUserDataFilesService)
  const commands = useService(ICommandService)
  const editorResolver = useService(IEditorResolverService)
  const dialog = useService(IDialogService)

  const [version, setVersion] = useState(0)
  const [mcpJsonRaw, setMcpJsonRaw] = useState<Record<string, unknown>>({})
  const [filePaths, setFilePaths] = useState<Readonly<Partial<Record<GroupId, string>>>>({})
  const [editTarget, setEditTarget] = useState<{
    readonly mode: 'add' | 'edit'
    readonly scope: McpServerScope
    readonly name?: string
    readonly entry?: unknown
  } | null>(null)

  const workspaceFolder = workspace.current?.folder

  useEventSubscription(
    () => [
      config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_KEY)) setVersion((v) => v + 1)
      }),
      workspace.onDidChangeWorkspace(() => setVersion((v) => v + 1)),
    ],
    [config, workspace],
  )

  // `.mcp.json` has no file watcher (same as the session picker) — re-read it
  // whenever the panel (re)mounts, the workspace changes, or the pool refresh
  // picks up a newer copy.
  useEffect(() => {
    let active = true
    if (!sessionService) {
      setMcpJsonRaw({})
      return
    }
    void sessionService.readProjectMcpJson().then((raw) => {
      if (active) setMcpJsonRaw(raw)
    })
    return () => {
      active = false
    }
  }, [sessionService, workspaceFolder, version])

  useEffect(() => {
    let active = true
    void (async () => {
      const entries: Array<readonly [GroupId, UserDataFile | undefined, URI | undefined]> = []
      for (const def of GROUP_DEFS) {
        if (def.file !== undefined) {
          entries.push([def.id, def.file, (await userData.getFileUri(def.file)) ?? undefined])
        }
      }
      if (workspaceFolder)
        entries.push(['mcpJson', undefined, URI.joinPath(workspaceFolder, '.mcp.json')])
      if (!active) return
      const next: Partial<Record<GroupId, string>> = {}
      for (const [id, , uri] of entries) {
        if (uri) next[id] = uri.fsPath
      }
      setFilePaths(next)
    })()
    return () => {
      active = false
    }
  }, [userData, workspaceFolder, version])

  const groups = useMemo((): readonly PanelGroup[] => {
    void version // recompute on config / workspace changes
    const rawByGroup = new Map<GroupId, Record<string, unknown>>()
    for (const def of GROUP_DEFS) {
      if (def.target !== undefined) {
        rawByGroup.set(
          def.id,
          mcpServerRawToRecord(config.getLayerSnapshot(def.target)[CONFIG_KEY]),
        )
      }
    }
    rawByGroup.set('mcpJson', mcpServerRawToRecord(mcpJsonRaw))

    const winnerByName = new Map<string, GroupId>()
    for (const id of SHADOW_ORDER) {
      for (const name of Object.keys(rawByGroup.get(id) ?? {})) winnerByName.set(name, id)
    }

    const hasWorkspace = workspaceFolder !== undefined
    const result: PanelGroup[] = []
    for (const def of GROUP_DEFS) {
      const raw = rawByGroup.get(def.id) ?? {}
      // Compat layers stay hidden unless they actually define something.
      if (
        (def.id === 'vscodeWorkspace' || def.id === 'vscodeUser') &&
        Object.keys(raw).length === 0
      )
        continue
      if (def.id === 'mcpJson' && Object.keys(raw).length === 0) continue
      const rows: PanelRow[] = Object.entries(raw).map(([name, entry]) => {
        const winner = winnerByName.get(name)
        return {
          name,
          raw: entry,
          validation: validateMcpServerEntry(name, entry),
          disabled: isDisabledEntry(entry),
          summary: summarizeEntry(entry),
          ...(winner !== undefined && winner !== def.id
            ? { shadowedBy: GROUP_LABELS[winner]() }
            : {}),
        }
      })
      result.push({
        id: def.id,
        label: GROUP_LABELS[def.id](),
        writable: def.writable,
        ...(def.target !== undefined ? { target: def.target } : {}),
        ...(def.file !== undefined ? { file: def.file } : {}),
        ...(def.openCommand !== undefined ? { openCommand: def.openCommand } : {}),
        rows,
        ...(def.id === 'workspace' && !hasWorkspace
          ? { note: localize('aiMcp.noWorkspace', 'Open a folder to configure workspace servers.') }
          : {}),
      })
    }
    return result
  }, [config, mcpJsonRaw, version, workspaceFolder])

  const writeEntry = useCallback(
    (target: ConfigurationTarget, name: string, entry: unknown | undefined) => {
      const raw = config.getLayerSnapshot(target)[CONFIG_KEY]
      config.update(CONFIG_KEY, writeMcpServerEntry(raw, name, entry), target)
    },
    [config],
  )

  const toggleDisabled = useCallback(
    (group: PanelGroup, row: PanelRow) => {
      if (!group.writable || group.target === undefined) return
      if (row.raw == null || typeof row.raw !== 'object' || Array.isArray(row.raw)) return
      const next: Record<string, unknown> = { ...(row.raw as Record<string, unknown>) }
      if (row.disabled) delete next.disabled
      else next.disabled = true
      writeEntry(group.target, row.name, next)
    },
    [writeEntry],
  )

  const removeEntry = useCallback(
    async (group: PanelGroup, row: PanelRow) => {
      if (!group.writable || group.target === undefined) return
      const { confirmed } = await dialog.confirm({
        message: localize('aiMcp.remove.confirm', 'Remove MCP server {name} from {scope}?', {
          name: row.name,
          scope: group.label,
        }),
        primaryButton: localize('aiMcp.remove.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      writeEntry(group.target, row.name, undefined)
    },
    [dialog, writeEntry],
  )

  const openFile = useCallback(
    async (group: PanelGroup) => {
      if (group.openCommand) {
        await commands.executeCommand(group.openCommand)
        return
      }
      if (group.file !== undefined) {
        const uri = await userData.getFileUri(group.file)
        if (uri) await editorResolver.openEditor(uri, { pinned: true })
        return
      }
      if (group.id === 'mcpJson' && workspaceFolder) {
        await editorResolver.openEditor(URI.joinPath(workspaceFolder, '.mcp.json'), {
          pinned: true,
        })
      }
    },
    [commands, editorResolver, userData, workspaceFolder],
  )

  const existingNames = useMemo(
    (): Readonly<Record<McpServerScope, readonly string[]>> => ({
      user: Object.keys(
        mcpServerRawToRecord(config.getLayerSnapshot(ConfigurationTarget.User)[CONFIG_KEY]),
      ),
      workspace: Object.keys(
        mcpServerRawToRecord(config.getLayerSnapshot(ConfigurationTarget.Project)[CONFIG_KEY]),
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, version],
  )

  const totalServers = groups.reduce((n, g) => n + g.rows.length, 0)
  const workspaceAvailable = workspaceFolder !== undefined

  return (
    <div className={shellStyles['panel']} data-testid="ai-mcp-panel">
      <div className={shellStyles['panelToolbar']}>
        <Button
          onClick={() =>
            setEditTarget({ mode: 'add', scope: workspaceAvailable ? 'workspace' : 'user' })
          }
        >
          <Plus size={14} strokeWidth={2} className={shellStyles['btnIcon']} />
          {localize('aiMcp.add', 'Add Server')}
        </Button>
      </div>

      {totalServers === 0 ? (
        <div className={shellStyles['emptyState']}>
          <Plug size={40} strokeWidth={1.25} className={shellStyles['emptyIcon']} />
          <div className={shellStyles['emptyTitle']}>
            {localize('aiMcp.empty.title', 'No MCP servers configured')}
          </div>
          <div className={shellStyles['emptyDesc']}>
            {localize(
              'aiMcp.empty.desc',
              'MCP servers give agents extra tools (filesystem, docs, …). Add one to make it available to new sessions.',
            )}
          </div>
          <Button
            onClick={() =>
              setEditTarget({ mode: 'add', scope: workspaceAvailable ? 'workspace' : 'user' })
            }
          >
            <Plus size={14} strokeWidth={2} className={shellStyles['btnIcon']} />
            {localize('aiMcp.add', 'Add Server')}
          </Button>
        </div>
      ) : (
        groups.map((group) => (
          <section
            key={group.id}
            className={styles['groupSection']}
            data-testid={`ai-mcp-group-${group.id}`}
          >
            <div className={styles['groupHeader']}>
              <span className={styles['groupTitle']}>{group.label}</span>
              {filePaths[group.id] && (
                <span className={styles['groupPath']}>{filePaths[group.id]}</span>
              )}
              {group.note && <span className={styles['groupNote']}>{group.note}</span>}
              <span className={shellStyles['spacer']} />
              {group.writable &&
                group.id !== 'mcpJson' &&
                (group.id !== 'workspace' || workspaceAvailable) && (
                  <IconButton
                    label={localize('aiMcp.addToScope', 'Add server here')}
                    onClick={() =>
                      setEditTarget({
                        mode: 'add',
                        scope: group.id === 'user' ? 'user' : 'workspace',
                      })
                    }
                  >
                    <Plus size={15} strokeWidth={2} />
                  </IconButton>
                )}
              <IconButton
                label={localize('aiMcp.openJson', 'Open JSON')}
                onClick={() => void openFile(group)}
              >
                <FileJson size={15} strokeWidth={1.75} />
              </IconButton>
            </div>
            {group.rows.length > 0 && (
              <ul className={styles['serverList']}>
                {group.rows.map((row) => (
                  <ServerRow
                    key={row.name}
                    group={group}
                    row={row}
                    sessionService={sessionService}
                    onToggle={() => toggleDisabled(group, row)}
                    onEdit={() =>
                      setEditTarget({
                        mode: 'edit',
                        scope: group.id === 'user' ? 'user' : 'workspace',
                        name: row.name,
                        entry: row.raw,
                      })
                    }
                    onRemove={() => void removeEntry(group, row)}
                  />
                ))}
              </ul>
            )}
          </section>
        ))
      )}

      {editTarget && (
        <McpServerEditDialog
          target={{
            mode: editTarget.mode,
            scope: editTarget.scope,
            workspaceAvailable,
            existingNames,
            ...(editTarget.name !== undefined ? { initialName: editTarget.name } : {}),
            ...(editTarget.entry !== undefined ? { initialEntry: editTarget.entry } : {}),
          }}
          onClose={() => setEditTarget(null)}
          onSave={(scope, name, entry) => {
            writeEntry(
              scope === 'user' ? ConfigurationTarget.User : ConfigurationTarget.Project,
              name,
              entry,
            )
            setEditTarget(null)
          }}
        />
      )}
    </div>
  )
}

function ServerRow({
  group,
  row,
  sessionService,
  onToggle,
  onEdit,
  onRemove,
}: {
  readonly group: PanelGroup
  readonly row: PanelRow
  readonly sessionService: IAcpSessionServiceType | undefined
  readonly onToggle: () => void
  readonly onEdit: () => void
  readonly onRemove: () => void
}) {
  const editable = group.writable && row.validation.valid
  return (
    <li
      className={styles['serverRow']}
      data-disabled={row.disabled}
      data-testid="ai-mcp-row"
      data-name={row.name}
    >
      {group.writable ? (
        <Checkbox
          checked={!row.disabled}
          disabled={!editable}
          onChange={onToggle}
          data-testid="ai-mcp-row-toggle"
        />
      ) : (
        sessionService && <ActiveSessionStatus service={sessionService} name={row.name} />
      )}
      <div className={styles['serverMain']}>
        <div className={styles['serverNameRow']}>
          <span className={styles['serverName']}>{row.name}</span>
          {row.validation.valid && (
            <span className={styles['transportBadge']}>{row.validation.transport}</span>
          )}
          {row.disabled && <Badge>{localize('aiMcp.row.disabled', 'disabled')}</Badge>}
          {row.shadowedBy && (
            <span className={styles['shadowNote']}>
              {localize('aiMcp.row.shadowed', 'overridden by {scope}', { scope: row.shadowedBy })}
            </span>
          )}
        </div>
        {row.validation.valid ? (
          row.summary && <span className={styles['serverSummary']}>{row.summary}</span>
        ) : (
          <span className={styles['invalidNote']}>
            <TriangleAlert size={12} strokeWidth={2} />
            {localize('aiMcp.row.invalid', 'Skipped at runtime: {reason}', {
              reason: row.validation.reason,
            })}
          </span>
        )}
      </div>
      {group.writable && (
        <div className={styles['rowActions']}>
          {sessionService && <ActiveSessionStatus service={sessionService} name={row.name} />}
          <IconButton label={localize('aiMcp.row.edit', 'Edit')} onClick={onEdit}>
            <Pencil size={14} strokeWidth={1.75} />
          </IconButton>
          <IconButton label={localize('aiMcp.row.remove', 'Remove')} onClick={onRemove}>
            <Trash2 size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
      )}
    </li>
  )
}

function ActiveSessionStatus({
  service,
  name,
}: {
  readonly service: IAcpSessionServiceType
  readonly name: string
}) {
  const session = useObservable(service.activeSession)
  if (!session) return null
  return <SessionStatusDot session={session} name={name} />
}

function SessionStatusDot({
  session,
  name,
}: {
  readonly session: IAcpSession
  readonly name: string
}) {
  const servers = useObservable(session.mcpServers)
  const status = servers.find((s) => s.name === name)?.status
  if (!status) return null
  return (
    <span className={styles['statusDot']} data-status={status} title={status} aria-hidden="true" />
  )
}

function isDisabledEntry(raw: unknown): boolean {
  return (
    raw != null && typeof raw === 'object' && (raw as Record<string, unknown>).disabled === true
  )
}

function summarizeEntry(raw: unknown): string {
  if (raw == null || typeof raw !== 'object') return ''
  const o = raw as Record<string, unknown>
  if (typeof o.command === 'string') {
    const args = Array.isArray(o.args)
      ? o.args.filter((a): a is string => typeof a === 'string')
      : []
    return [o.command, ...args].join(' ')
  }
  return typeof o.url === 'string' ? o.url : ''
}
