/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  McpServerEditDialog — focus-trapped modal for adding / editing one MCP
 *  server entry inside `acp.mcpServers`. Add mode also picks the target scope
 *  (user-global or workspace); edit mode keeps name + scope fixed (a rename is
 *  delete + add). The dialog only shapes the entry object plus the desired
 *  default-enabled flag — persistence of both goes through the caller's onSave
 *  (the definition lands in settings; enablement lands in storage via
 *  IMcpServerEnablementService).
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import {
  Button,
  Checkbox,
  FocusScopeOverlay,
  IconButton,
  Input,
} from '@universe-editor/workbench-ui'
import { mcpServerPairs } from '../../services/acp/acpMcpServers.js'
import shellStyles from './AiSettingsEditor.module.css'
import styles from './AiMcpServersPanel.module.css'

export type McpServerScope = 'user' | 'workspace'

export interface McpServerEditTarget {
  readonly mode: 'add' | 'edit'
  /** Scope the entry is written to; only selectable in add mode. */
  readonly scope: McpServerScope
  /** Workspace target is unavailable without an open folder. */
  readonly workspaceAvailable: boolean
  /** Names already defined per scope (duplicate detection in add mode). */
  readonly existingNames: Readonly<Record<McpServerScope, readonly string[]>>
  readonly initialName?: string
  readonly initialEntry?: unknown
  /** Initial state of the "Enabled by default" checkbox (defaults to true). */
  readonly initialEnabled?: boolean
}

interface McpServerEditDialogProps {
  readonly target: McpServerEditTarget
  readonly onClose: () => void
  readonly onSave: (
    scope: McpServerScope,
    name: string,
    entry: Record<string, unknown>,
    enabled: boolean,
  ) => void
}

interface KvPair {
  readonly name: string
  readonly value: string
}

export function McpServerEditDialog({ target, onClose, onSave }: McpServerEditDialogProps) {
  const prefill = useMemo(() => prefillFromRaw(target.initialEntry), [target.initialEntry])
  const [scope, setScope] = useState<McpServerScope>(target.scope)
  const [name, setName] = useState(target.initialName ?? '')
  const [type, setType] = useState<'stdio' | 'http' | 'sse'>(prefill.type)
  const [command, setCommand] = useState(prefill.command)
  const [args, setArgs] = useState(prefill.args)
  const [url, setUrl] = useState(prefill.url)
  const [env, setEnv] = useState<readonly KvPair[]>(prefill.env)
  const [headers, setHeaders] = useState<readonly KvPair[]>(prefill.headers)
  const [enabled, setEnabled] = useState(target.initialEnabled ?? true)

  const trimmedName = name.trim()
  const nameError = useMemo(() => {
    if (trimmedName.length === 0) return localize('aiMcp.dialog.nameEmpty', 'Name is required.')
    if (target.mode === 'add' && target.existingNames[scope].includes(trimmedName))
      return localize('aiMcp.dialog.nameExists', 'That server already exists in this scope.')
    return undefined
  }, [trimmedName, target, scope])

  const shadowHint = useMemo(() => {
    if (target.mode !== 'add' || nameError) return undefined
    const other: McpServerScope = scope === 'user' ? 'workspace' : 'user'
    if (target.existingNames[other].includes(trimmedName)) {
      return scope === 'workspace'
        ? localize(
            'aiMcp.dialog.shadowsGlobal',
            'This overrides the user-global server of the same name.',
          )
        : localize(
            'aiMcp.dialog.shadowedByWorkspace',
            'A workspace server with this name takes precedence over it.',
          )
    }
    return undefined
  }, [target, scope, trimmedName, nameError])

  const transportError = useMemo(() => {
    if (type === 'stdio') {
      if (command.trim().length === 0)
        return localize('aiMcp.dialog.commandEmpty', 'Command is required for stdio servers.')
    } else if (url.trim().length === 0) {
      return localize('aiMcp.dialog.urlEmpty', 'URL is required for http/sse servers.')
    }
    return undefined
  }, [type, command, url])

  const save = (): void => {
    if (nameError || transportError) return
    const entry: Record<string, unknown> = {}
    if (type === 'stdio') {
      entry.command = command.trim()
      const argList = args
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => l.trim().length > 0)
      if (argList.length > 0) entry.args = argList
      const envRecord = pairsToRecord(env)
      if (Object.keys(envRecord).length > 0) entry.env = envRecord
    } else {
      entry.type = type
      entry.url = url.trim()
      const headerRecord = pairsToRecord(headers)
      if (Object.keys(headerRecord).length > 0) entry.headers = headerRecord
    }
    onSave(scope, trimmedName, entry, enabled)
  }

  return (
    <FocusScopeOverlay visible onEscape={onClose}>
      <div className={shellStyles['dialogBackdrop']} onClick={onClose} />
      <div className={shellStyles['dialog']} role="dialog" aria-modal="true">
        <h2 className={shellStyles['dialogTitle']}>
          {target.mode === 'add'
            ? localize('aiMcp.dialog.addTitle', 'Add MCP Server')
            : localize('aiMcp.dialog.editTitle', 'Edit MCP Server')}
        </h2>

        <div className={shellStyles['dialogBody']}>
          <div className={shellStyles['field']}>
            <label className={shellStyles['label']}>
              {localize('aiMcp.dialog.scope', 'Save to')}
            </label>
            <select
              className={shellStyles['control']}
              value={scope}
              aria-label={localize('aiMcp.dialog.scope', 'Save to')}
              disabled={target.mode === 'edit'}
              onChange={(e) => setScope(e.target.value as McpServerScope)}
            >
              <option value="user">{localize('aiMcp.scope.user', 'User (global)')}</option>
              <option value="workspace" disabled={!target.workspaceAvailable}>
                {localize('aiMcp.scope.workspace', 'Workspace')}
              </option>
            </select>
          </div>

          <div className={shellStyles['field']}>
            <label className={shellStyles['label']}>{localize('aiMcp.dialog.name', 'Name')}</label>
            <Input
              value={name}
              invalid={nameError !== undefined && trimmedName.length > 0}
              disabled={target.mode === 'edit'}
              placeholder="filesystem"
              onChange={(e) => setName(e.target.value)}
            />
            {nameError && trimmedName.length > 0 && (
              <span className={shellStyles['dialogFieldError']}>{nameError}</span>
            )}
            {shadowHint && <span className={styles['scopeHint']}>{shadowHint}</span>}
          </div>

          <div className={shellStyles['field']}>
            <label className={shellStyles['label']}>{localize('aiMcp.dialog.type', 'Type')}</label>
            <select
              className={shellStyles['control']}
              value={type}
              aria-label={localize('aiMcp.dialog.type', 'Type')}
              onChange={(e) => setType(e.target.value as 'stdio' | 'http' | 'sse')}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </div>

          {type === 'stdio' ? (
            <>
              <div className={shellStyles['field']}>
                <label className={shellStyles['label']}>
                  {localize('aiMcp.dialog.command', 'Command')}
                </label>
                <Input
                  value={command}
                  invalid={transportError !== undefined && command.trim().length === 0}
                  placeholder="npx"
                  onChange={(e) => setCommand(e.target.value)}
                />
                {transportError && command.trim().length === 0 && (
                  <span className={shellStyles['dialogFieldError']}>{transportError}</span>
                )}
              </div>
              <div className={shellStyles['field']}>
                <label className={shellStyles['label']}>
                  {localize('aiMcp.dialog.args', 'Arguments (one per line)')}
                </label>
                <textarea
                  className={styles['argsArea']}
                  value={args}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n.'}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </div>
              <KvEditor
                label={localize('aiMcp.dialog.env', 'Environment variables')}
                pairs={env}
                onChange={setEnv}
              />
            </>
          ) : (
            <>
              <div className={shellStyles['field']}>
                <label className={shellStyles['label']}>
                  {localize('aiMcp.dialog.url', 'URL')}
                </label>
                <Input
                  value={url}
                  invalid={transportError !== undefined && url.trim().length === 0}
                  placeholder="https://example.com/mcp"
                  onChange={(e) => setUrl(e.target.value)}
                />
                {transportError && url.trim().length === 0 && (
                  <span className={shellStyles['dialogFieldError']}>{transportError}</span>
                )}
              </div>
              <KvEditor
                label={localize('aiMcp.dialog.headers', 'Headers')}
                pairs={headers}
                onChange={setHeaders}
              />
            </>
          )}

          <label className={styles['enabledRow']}>
            <Checkbox checked={enabled} onChange={setEnabled} />
            {localize('aiMcp.dialog.enabled', 'Enabled by default')}
          </label>
        </div>

        <div className={shellStyles['dialogActions']}>
          <Button variant="ghost" onClick={onClose}>
            {localize('aiMcp.dialog.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={nameError !== undefined || transportError !== undefined}
            onClick={save}
          >
            {localize('aiMcp.dialog.save', 'Save')}
          </Button>
        </div>
      </div>
    </FocusScopeOverlay>
  )
}

function KvEditor({
  label,
  pairs,
  onChange,
}: {
  readonly label: string
  readonly pairs: readonly KvPair[]
  readonly onChange: (next: readonly KvPair[]) => void
}) {
  const update = (index: number, patch: Partial<KvPair>): void =>
    onChange(pairs.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  return (
    <div className={shellStyles['field']}>
      <label className={shellStyles['label']}>{label}</label>
      <div className={styles['kvList']}>
        {pairs.map((pair, index) => (
          <div key={index} className={styles['kvRow']}>
            <Input
              value={pair.name}
              placeholder={localize('aiMcp.dialog.kvName', 'Name')}
              onChange={(e) => update(index, { name: e.target.value })}
            />
            <Input
              value={pair.value}
              placeholder={localize('aiMcp.dialog.kvValue', 'Value')}
              onChange={(e) => update(index, { value: e.target.value })}
            />
            <IconButton
              label={localize('aiMcp.dialog.kvRemove', 'Remove')}
              onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            >
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange([...pairs, { name: '', value: '' }])}
          >
            <Plus size={13} strokeWidth={2} />
            {localize('aiMcp.dialog.kvAdd', 'Add')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function pairsToRecord(pairs: readonly KvPair[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs) {
    const key = p.name.trim()
    if (key) out[key] = p.value
  }
  return out
}

interface Prefill {
  readonly type: 'stdio' | 'http' | 'sse'
  readonly command: string
  readonly args: string
  readonly url: string
  readonly env: readonly KvPair[]
  readonly headers: readonly KvPair[]
}

/** Best-effort form prefill from a raw entry (tolerates entries that would fail validation). */
function prefillFromRaw(raw: unknown): Prefill {
  const o =
    raw != null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const type = o.type === 'http' || o.type === 'sse' ? o.type : 'stdio'
  return {
    type,
    command: typeof o.command === 'string' ? o.command : '',
    args: Array.isArray(o.args)
      ? o.args.filter((a): a is string => typeof a === 'string').join('\n')
      : '',
    url: typeof o.url === 'string' ? o.url : '',
    env: mcpServerPairs(o.env),
    headers: mcpServerPairs(o.headers),
  }
}
