/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AiMcpServersPanel — the "MCP Servers" category of the AI settings editor.
 *  Visual editor for `acp.mcpServers`, rendered as ONE merged list: each
 *  server appears exactly once, annotated with badge(s) for every source
 *  defining it:
 *    • user            — <userData>/settings.json            (editable)
 *    • workspace       — .universe-editor/settings.json      (editable)
 *    • .mcp.json       — workspace root, Claude-Code format  (read-only file)
 *    • vscode layers   — .vscode/settings.json compat        (read-only files)
 *    • extension       — declarative contributes.mcpServers  (runtime only)
 *  Sources compose per server name (mcpJson > workspace > vscodeWorkspace >
 *  user > vscodeUser > extension): the winning badge renders normally,
 *  shadowed ones are dimmed and say so in their tooltip. Clicking a badge
 *  opens that source (edit dialog for writable ones, the file otherwise).
 *  Edit/Remove act on the highest-priority writable definition
 *  (workspace > user) and say which in their tooltip.
 *
 *  The per-server default on/off lives in IMcpServerEnablementService
 *  (storage, GLOBAL/WORKSPACE scopes, workspace wins) and is edited through
 *  the shared McpEnablementToggles: the user-level switch appears only for
 *  names with a user-level definition; the workspace switch is always there
 *  and is three-state (inherit → on → off → inherit). The "disabled" badge
 *  always shows the EFFECTIVE state.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { FileJson, FolderOpen, Pencil, Plug, Plus, Trash2, TriangleAlert, User } from 'lucide-react'
import {
  ConfigurationTarget,
  ICommandService,
  IConfigurationService,
  IDialogService,
  IEditorResolverService,
  IUserDataFilesService,
  IWorkspaceService,
  StorageScope,
  UserDataFile,
  URI,
  localize,
} from '@universe-editor/platform'
import { AnchoredSurface, Badge, Button, IconButton } from '@universe-editor/workbench-ui'
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
} from '../../services/acp/session/acpSessionService.js'
import {
  mcpServerRawToRecord,
  validateMcpServerEntry,
  writeMcpServerEntry,
  type McpServerEntryValidation,
} from '../../services/acp/acpMcpServers.js'
import { McpServerEditDialog, type McpServerScope } from './McpServerEditDialog.js'
import { McpEnablementToggles } from '../agents/McpEnablementToggles.js'
import { IExtensionMcpServersService } from '../../services/extensions/extensionMcpServersService.js'
import { IMcpServerEnablementService } from '../../services/acp/mcpServerEnablementService.js'
import shellStyles from './AiSettingsEditor.module.css'
import styles from './AiMcpServersPanel.module.css'

const CONFIG_KEY = 'acp.mcpServers'

type SourceId = 'user' | 'workspace' | 'vscodeWorkspace' | 'vscodeUser' | 'mcpJson' | 'extension'

interface SourceDef {
  readonly id: SourceId
  /** Entries can be added/edited/removed through the dialog. */
  readonly writable: boolean
  readonly target?: ConfigurationTarget
  readonly file?: UserDataFile
  readonly openCommand?: string
}

const SOURCE_DEFS: ReadonlyArray<SourceDef> = [
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
  { id: 'extension', writable: false },
]

const SOURCE_LABELS: Record<SourceId, () => string> = {
  user: () => localize('aiMcp.scope.user', 'User (global)'),
  workspace: () => localize('aiMcp.scope.workspace', 'Workspace'),
  mcpJson: () => '.mcp.json',
  vscodeWorkspace: () => localize('aiMcp.scope.vscodeWorkspace', 'VSCode workspace (read-only)'),
  vscodeUser: () => localize('aiMcp.scope.vscodeUser', 'VSCode user (read-only)'),
  extension: () => localize('aiMcp.scope.extension', 'Extensions (read-only)'),
}

/** Short badge captions shown inline per source. */
const SOURCE_BADGE_LABELS: Record<SourceId, string> = {
  user: 'user',
  workspace: 'workspace',
  mcpJson: '.mcp.json',
  vscodeWorkspace: 'vscode-ws',
  vscodeUser: 'vscode-user',
  extension: 'ext',
}

/** Shadow priority, lowest first — the last source defining a name wins it. */
const SHADOW_ORDER: readonly SourceId[] = [
  'extension',
  'vscodeUser',
  'user',
  'vscodeWorkspace',
  'workspace',
  'mcpJson',
]

/** Sources that count as "user-level" for the user-level enablement toggle. */
const USER_LEVEL_SOURCES: ReadonlySet<SourceId> = new Set(['user', 'vscodeUser', 'extension'])

interface SourcePresence {
  readonly id: SourceId
  readonly raw: unknown
  readonly validation: McpServerEntryValidation
  readonly isWinner: boolean
}

interface MergedRow {
  readonly name: string
  readonly winner: SourcePresence
  /** Present sources in SHADOW_ORDER (winner last-ish per priority). */
  readonly sources: readonly SourcePresence[]
  readonly hasUserLevelDefinition: boolean
  /** Effective default state (workspace override wins) — drives the badge. */
  readonly effective: boolean
}

interface ConfigFileMenuItem {
  readonly id: SourceId
  readonly icon: ReactNode
  readonly label: string
  readonly detail: string
}

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
  const extensionMcp = useOptionalService(IExtensionMcpServersService)
  const enablement = useService(IMcpServerEnablementService)

  const [version, setVersion] = useState(0)
  const [mcpJsonRaw, setMcpJsonRaw] = useState<Record<string, unknown>>({})
  const [configMenuAnchor, setConfigMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const [editTarget, setEditTarget] = useState<{
    readonly mode: 'add' | 'edit'
    readonly scope: McpServerScope
    readonly name?: string
    readonly entry?: unknown
    readonly enabled?: boolean
  } | null>(null)

  const workspaceFolder = workspace.current?.folder

  useEventSubscription(
    () => [
      config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_KEY)) setVersion((v) => v + 1)
      }),
      workspace.onDidChangeWorkspace(() => setVersion((v) => v + 1)),
      enablement.onDidChange(() => setVersion((v) => v + 1)),
      ...(extensionMcp ? [extensionMcp.onDidChange(() => setVersion((v) => v + 1))] : []),
    ],
    [config, workspace, enablement, extensionMcp],
  )

  // `.mcp.json` has no file watcher (same as the session picker) — re-read it
  // whenever the panel (re)mounts, the workspace changes, or a refresh picks
  // up a newer copy.
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

  const rows = useMemo((): readonly MergedRow[] => {
    void version // recompute on config / workspace / enablement changes
    const rawBySource = new Map<SourceId, Record<string, unknown>>()
    for (const def of SOURCE_DEFS) {
      if (def.target !== undefined) {
        rawBySource.set(
          def.id,
          mcpServerRawToRecord(config.getLayerSnapshot(def.target)[CONFIG_KEY]),
        )
      }
    }
    rawBySource.set('mcpJson', mcpServerRawToRecord(mcpJsonRaw))
    rawBySource.set('extension', { ...(extensionMcp?.rawRecord ?? {}) })

    const winnerByName = new Map<string, SourceId>()
    for (const id of SHADOW_ORDER) {
      for (const name of Object.keys(rawBySource.get(id) ?? {})) winnerByName.set(name, id)
    }

    const out: MergedRow[] = []
    for (const [name, winnerId] of winnerByName) {
      const sources: SourcePresence[] = []
      for (const id of SHADOW_ORDER) {
        const raw = rawBySource.get(id)?.[name]
        if (raw === undefined) continue
        sources.push({
          id,
          raw,
          validation: validateMcpServerEntry(name, raw),
          isWinner: id === winnerId,
        })
      }
      const winner = sources.find((s) => s.isWinner)
      if (!winner) continue
      out.push({
        name,
        winner,
        sources,
        hasUserLevelDefinition: sources.some((s) => USER_LEVEL_SOURCES.has(s.id)),
        effective: enablement.isEnabled(name),
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }, [config, enablement, extensionMcp, mcpJsonRaw, version])

  const writeEntry = useCallback(
    (target: ConfigurationTarget, name: string, entry: unknown | undefined) => {
      const raw = config.getLayerSnapshot(target)[CONFIG_KEY]
      config.update(CONFIG_KEY, writeMcpServerEntry(raw, name, entry), target)
    },
    [config],
  )

  /** Highest-priority writable definition (workspace > user), if any. */
  const editableSource = useCallback(
    (row: MergedRow): SourcePresence | undefined =>
      row.sources.find((s) => s.id === 'workspace') ?? row.sources.find((s) => s.id === 'user'),
    [],
  )

  const openEditorFor = useCallback(
    (row: MergedRow, presence: SourcePresence) => {
      const scope: McpServerScope = presence.id === 'user' ? 'user' : 'workspace'
      setEditTarget({
        mode: 'edit',
        scope,
        name: row.name,
        entry: presence.raw,
        enabled:
          enablement.getOverride(
            row.name,
            scope === 'user' ? StorageScope.GLOBAL : StorageScope.WORKSPACE,
          ) ?? enablement.isEnabled(row.name),
      })
    },
    [enablement],
  )

  const openFile = useCallback(
    async (id: SourceId) => {
      const def = SOURCE_DEFS.find((d) => d.id === id)
      if (def?.openCommand) {
        await commands.executeCommand(def.openCommand)
        return
      }
      if (def?.file !== undefined) {
        const uri = await userData.getFileUri(def.file)
        if (uri) await editorResolver.openEditor(uri, { pinned: true })
        return
      }
      if (id === 'mcpJson' && workspaceFolder) {
        await editorResolver.openEditor(URI.joinPath(workspaceFolder, '.mcp.json'), {
          pinned: true,
        })
      }
    },
    [commands, editorResolver, userData, workspaceFolder],
  )

  const onSourceBadgeClick = useCallback(
    (row: MergedRow, presence: SourcePresence) => {
      if (presence.id === 'user' || presence.id === 'workspace') {
        openEditorFor(row, presence)
      } else if (presence.id !== 'extension') {
        void openFile(presence.id)
      }
    },
    [openEditorFor, openFile],
  )

  const onEdit = useCallback(
    (row: MergedRow) => {
      const target = editableSource(row)
      if (target) openEditorFor(row, target)
    },
    [editableSource, openEditorFor],
  )

  const onRemove = useCallback(
    async (row: MergedRow) => {
      const target = editableSource(row)
      if (!target) return
      const def = SOURCE_DEFS.find((d) => d.id === target.id)
      if (!def?.target) return
      const { confirmed } = await dialog.confirm({
        message: localize('aiMcp.remove.confirm', 'Remove MCP server {name} from {scope}?', {
          name: row.name,
          scope: SOURCE_LABELS[target.id](),
        }),
        primaryButton: localize('aiMcp.remove.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      writeEntry(def.target, row.name, undefined)
    },
    [dialog, editableSource, writeEntry],
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

  const workspaceAvailable = workspaceFolder !== undefined
  const hasMcpJson = Object.keys(mcpServerRawToRecord(mcpJsonRaw)).length > 0
  const layerNonEmpty = useCallback(
    (target: ConfigurationTarget): boolean =>
      Object.keys(mcpServerRawToRecord(config.getLayerSnapshot(target)[CONFIG_KEY])).length > 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, version],
  )

  const configFileItems = useMemo((): readonly ConfigFileMenuItem[] => {
    const items: ConfigFileMenuItem[] = [
      {
        id: 'user',
        icon: <User size={14} strokeWidth={1.75} />,
        label: localize('aiMcp.openJson.user.label', 'User settings.json'),
        detail: localize('aiMcp.openJson.user.detail', 'Global — applies to every workspace'),
      },
    ]
    if (workspaceAvailable) {
      items.push({
        id: 'workspace',
        icon: <FolderOpen size={14} strokeWidth={1.75} />,
        label: localize('aiMcp.openJson.workspace.label', 'Workspace settings.json'),
        detail: '.universe-editor/settings.json',
      })
    }
    if (hasMcpJson) {
      items.push({
        id: 'mcpJson',
        icon: <FileJson size={14} strokeWidth={1.75} />,
        label: '.mcp.json',
        detail: localize('aiMcp.openJson.mcpJson.detail', 'Workspace root, Claude Code format'),
      })
    }
    if (layerNonEmpty(ConfigurationTarget.VSCodeUser)) {
      items.push({
        id: 'vscodeUser',
        icon: <User size={14} strokeWidth={1.75} />,
        label: localize('aiMcp.openJson.vscodeUser.label', 'VSCode user settings.json'),
        detail: localize('aiMcp.openJson.readonly', 'Read-only import'),
      })
    }
    if (layerNonEmpty(ConfigurationTarget.VSCodeWorkspace)) {
      items.push({
        id: 'vscodeWorkspace',
        icon: <FolderOpen size={14} strokeWidth={1.75} />,
        label: localize('aiMcp.openJson.vscodeWorkspace.label', 'VSCode workspace settings.json'),
        detail: localize('aiMcp.openJson.readonly', 'Read-only import'),
      })
    }
    return items
  }, [workspaceAvailable, hasMcpJson, layerNonEmpty])

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
        <span className={shellStyles['spacer']} />
        <IconButton
          label={localize('aiMcp.openJson.trigger', 'Open a configuration file')}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setConfigMenuAnchor({ x: rect.left, y: rect.bottom })
          }}
        >
          <FileJson size={15} strokeWidth={1.75} />
        </IconButton>
      </div>

      {rows.length === 0 ? (
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
        <ul className={styles['serverList']} data-testid="ai-mcp-list">
          {rows.map((row) => (
            <ServerRow
              key={row.name}
              row={row}
              sessionService={sessionService}
              editableSource={editableSource(row)}
              onSourceBadgeClick={onSourceBadgeClick}
              onEdit={() => onEdit(row)}
              onRemove={() => void onRemove(row)}
            />
          ))}
        </ul>
      )}

      {configMenuAnchor && (
        <AnchoredSurface
          x={configMenuAnchor.x}
          y={configMenuAnchor.y}
          offset={4}
          onClose={() => setConfigMenuAnchor(null)}
        >
          <ul role="menu" className={styles['menu']} data-testid="ai-mcp-config-menu">
            {configFileItems.map((item) => (
              <li
                key={item.id}
                role="menuitem"
                className={styles['menuItem']}
                onClick={() => {
                  setConfigMenuAnchor(null)
                  void openFile(item.id)
                }}
              >
                <span className={styles['menuItemIcon']} aria-hidden="true">
                  {item.icon}
                </span>
                <span className={styles['menuItemText']}>
                  <span>{item.label}</span>
                  <span className={styles['menuItemDetail']}>{item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </AnchoredSurface>
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
            ...(editTarget.enabled !== undefined ? { initialEnabled: editTarget.enabled } : {}),
          }}
          onClose={() => setEditTarget(null)}
          onSave={(scope, name, entry, enabled) => {
            writeEntry(
              scope === 'user' ? ConfigurationTarget.User : ConfigurationTarget.Project,
              name,
              entry,
            )
            void enablement.setEnabled(
              name,
              enabled,
              scope === 'user' ? StorageScope.GLOBAL : StorageScope.WORKSPACE,
            )
            setEditTarget(null)
          }}
        />
      )}
    </div>
  )
}

function ServerRow({
  row,
  sessionService,
  editableSource,
  onSourceBadgeClick,
  onEdit,
  onRemove,
}: {
  readonly row: MergedRow
  readonly sessionService: IAcpSessionServiceType | undefined
  readonly editableSource: SourcePresence | undefined
  readonly onSourceBadgeClick: (row: MergedRow, presence: SourcePresence) => void
  readonly onEdit: () => void
  readonly onRemove: () => void
}) {
  const winnerValid = row.winner.validation.valid
  return (
    <li
      className={styles['serverRow']}
      data-disabled={!row.effective}
      data-testid="ai-mcp-row"
      data-name={row.name}
    >
      <McpEnablementToggles
        name={row.name}
        showUserToggle={row.hasUserLevelDefinition}
        disabled={!winnerValid}
      />
      <div className={styles['serverMain']}>
        <div className={styles['serverNameRow']}>
          <span className={styles['serverName']}>{row.name}</span>
          {winnerValid && (
            <span className={styles['transportBadge']}>{row.winner.validation.transport}</span>
          )}
          {!row.effective && <Badge>{localize('aiMcp.row.disabled', 'disabled')}</Badge>}
          {row.sources.map((p) => (
            <SourceBadge
              key={p.id}
              presence={p}
              winnerLabel={SOURCE_LABELS[row.winner.id]()}
              onClick={() => onSourceBadgeClick(row, p)}
            />
          ))}
        </div>
        {winnerValid ? (
          summarizeEntry(row.winner.raw) && (
            <span className={styles['serverSummary']}>{summarizeEntry(row.winner.raw)}</span>
          )
        ) : (
          <span className={styles['invalidNote']}>
            <TriangleAlert size={12} strokeWidth={2} />
            {localize('aiMcp.row.invalid', 'Skipped at runtime: {reason}', {
              reason: row.winner.validation.valid ? '' : row.winner.validation.reason,
            })}
          </span>
        )}
      </div>
      <div className={styles['rowActions']}>
        {sessionService && <ActiveSessionStatus service={sessionService} name={row.name} />}
        {editableSource && (
          <>
            <IconButton
              label={localize('aiMcp.row.editScope', 'Edit {scope} definition', {
                scope: SOURCE_LABELS[editableSource.id](),
              })}
              onClick={onEdit}
            >
              <Pencil size={14} strokeWidth={1.75} />
            </IconButton>
            <IconButton label={localize('aiMcp.row.remove', 'Remove')} onClick={onRemove}>
              <Trash2 size={14} strokeWidth={1.75} />
            </IconButton>
          </>
        )}
      </div>
    </li>
  )
}

function SourceBadge({
  presence,
  winnerLabel,
  onClick,
}: {
  readonly presence: SourcePresence
  readonly winnerLabel: string
  readonly onClick: () => void
}) {
  const label = SOURCE_LABELS[presence.id]()
  const title = presence.isWinner
    ? label
    : `${label} — ${localize('aiMcp.row.shadowed', 'overridden by {scope}', {
        scope: winnerLabel,
      })}${presence.validation.valid ? '' : ` — ${presence.validation.reason}`}`
  return (
    <button
      type="button"
      className={styles['sourceBadge']}
      data-shadowed={!presence.isWinner || undefined}
      data-invalid={!presence.validation.valid || undefined}
      title={title}
      onClick={onClick}
      data-testid="ai-mcp-source-badge"
      data-source={presence.id}
    >
      {SOURCE_BADGE_LABELS[presence.id]}
    </button>
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
