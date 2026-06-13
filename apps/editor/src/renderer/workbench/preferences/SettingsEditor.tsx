/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Form-driven settings editor. Renders one section per registered
 *  ConfigurationNode; control type is chosen from the JSON-schema entry.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react'
import {
  ConfigurationRegistry,
  ConfigurationTarget,
  IConfigurationService,
  INotificationService,
  IWorkspaceService,
  Severity,
  localize,
  type IConfigurationNode,
  type IConfigurationPropertySchema,
  type IEditorInput,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import {
  SETTINGS_EDITOR_FOCUS_SEARCH_EVENT,
  SETTINGS_EDITOR_SWITCH_TARGET_EVENT,
} from './preferencesFocus.js'
import { SettingsEditorInput } from '../../services/editor/SettingsEditorInput.js'
import styles from './SettingsEditor.module.css'

function originLabel(origin: ConfigurationTarget | undefined): string {
  switch (origin) {
    case ConfigurationTarget.Project:
      return localize('settings.origin.workspace', 'Workspace')
    case ConfigurationTarget.VSCodeWorkspace:
      return localize('settings.origin.vscodeWorkspace', 'VSCode Workspace')
    case ConfigurationTarget.User:
      return localize('settings.origin.user', 'User')
    case ConfigurationTarget.VSCodeUser:
      return localize('settings.origin.vscodeUser', 'VSCode User')
    case ConfigurationTarget.Memory:
      return localize('settings.origin.memory', 'Runtime')
    case ConfigurationTarget.Default:
      return localize('settings.origin.default', 'Default')
    default:
      return localize('settings.origin.default', 'Default')
  }
}

// The form only renders scalar settings (boolean / number / string / single
// enum). Object / array / union (type[]) / anyOf settings have no good form
// control — they remain fully editable in settings.json (which gets the complete
// schema for completion + validation). This keeps the form usable instead of
// showing dozens of "not editable" rows.
function isScalarSchema(schema: IConfigurationPropertySchema): boolean {
  if (schema.anyOf !== undefined) return false
  // Union types (e.g. boolean | string) have no clean single control even when
  // they carry an enum, so keep them in settings.json only.
  if (Array.isArray(schema.type)) return false
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return true
  const t = schema.type
  return t === 'boolean' || t === 'number' || t === 'integer' || t === 'string'
}

interface RowProps {
  configKey: string
  schema: IConfigurationPropertySchema
  value: unknown
  origin: ConfigurationTarget | undefined
  onChange: (value: unknown) => void
}

function PropertyRow({ configKey, schema, value, origin, onChange }: RowProps) {
  let control: JSX.Element

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    control = (
      <select
        className={styles['control']}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {schema.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>
            {schema.enumItemLabels?.[String(opt)] ?? String(opt)}
          </option>
        ))}
      </select>
    )
  } else if (schema.type === 'boolean') {
    control = (
      <input
        className={styles['checkbox']}
        type="checkbox"
        checked={Boolean(value)}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  } else if (schema.type === 'number' || schema.type === 'integer') {
    control = (
      <input
        className={styles['control']}
        type="number"
        value={Number(value ?? 0)}
        {...(schema.minimum !== undefined ? { min: schema.minimum } : {})}
        {...(schema.maximum !== undefined ? { max: schema.maximum } : {})}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isNaN(n)) onChange(n)
        }}
      />
    )
  } else if (schema.type === 'string') {
    control = (
      <input
        className={styles['control']}
        type="text"
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  } else {
    control = (
      <span className={styles['readonly']}>
        {localize('settings.readonly', 'Not editable in form view')}
      </span>
    )
  }

  return (
    <div className={styles['row']} data-key={configKey}>
      <div className={styles['rowMeta']}>
        <div className={styles['rowKey']}>
          {configKey}
          <span className={styles['originBadge']}>{originLabel(origin)}</span>
        </div>
        {schema.description ? <div className={styles['rowDesc']}>{schema.description}</div> : null}
      </div>
      <div className={styles['rowControl']}>{control}</div>
    </div>
  )
}

export function SettingsEditor({ input }: { input: IEditorInput }) {
  const config = useService(IConfigurationService)
  const workspace = useService(IWorkspaceService)
  const notifications = useService(INotificationService)

  const [activeTarget, setActiveTarget] = useState<
    ConfigurationTarget.User | ConfigurationTarget.Project
  >(() => (input as SettingsEditorInput).target ?? ConfigurationTarget.User)
  const [hasWorkspace, setHasWorkspace] = useState(() => workspace.current !== null)
  const [query, setQuery] = useState('')
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const focusSearch = () => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }

    focusSearch()
    document.addEventListener(SETTINGS_EDITOR_FOCUS_SEARCH_EVENT, focusSearch)
    return () => document.removeEventListener(SETTINGS_EDITOR_FOCUS_SEARCH_EVENT, focusSearch)
  }, [])

  // Track workspace open/close to enable/disable the Workspace tab.
  useEffect(() => {
    const d = workspace.onDidChangeWorkspace((w) => {
      const open = w !== null
      setHasWorkspace(open)
      // If workspace closes while Workspace tab is active, fall back to User.
      if (!open) setActiveTarget(ConfigurationTarget.User)
    })
    return () => d.dispose()
  }, [workspace])

  // Listen for external switch-target dispatches (e.g. from OpenWorkspaceSettingsAction).
  useEffect(() => {
    const handler = (e: Event) => {
      const t = (e as CustomEvent<number>).detail as
        | ConfigurationTarget.User
        | ConfigurationTarget.Project
      if (t === ConfigurationTarget.Project && !workspace.current) return
      setActiveTarget(t)
      ;(input as SettingsEditorInput).switchTarget(t)
    }
    document.addEventListener(SETTINGS_EDITOR_SWITCH_TARGET_EVENT, handler)
    return () => document.removeEventListener(SETTINGS_EDITOR_SWITCH_TARGET_EVENT, handler)
  }, [input, workspace])

  // Re-render whenever schema registry changes or any configuration value changes.
  useEffect(() => {
    const d1 = ConfigurationRegistry.onDidRegisterConfiguration(() => bump())
    const d2 = config.onDidChangeConfiguration(() => bump())
    return () => {
      d1.dispose()
      d2.dispose()
    }
  }, [config])

  function handleSwitchTarget(t: ConfigurationTarget.User | ConfigurationTarget.Project): void {
    if (t === ConfigurationTarget.Project && !hasWorkspace) {
      notifications.notify({
        message: localize('settings.noWorkspace', 'Open a folder to edit workspace settings.'),
        severity: Severity.Info,
      })
      return
    }
    setActiveTarget(t)
    ;(input as SettingsEditorInput).switchTarget(t)
  }

  const nodes = ConfigurationRegistry.getConfigurationNodes()
  const normalisedQuery = query.trim().toLowerCase()

  // Drop non-scalar settings up front so both the count and the rendered rows
  // reflect only what the form can edit.
  const scalarNodes = useMemo<IConfigurationNode[]>(() => {
    return nodes
      .map((node) => {
        const keep: Record<string, IConfigurationPropertySchema> = {}
        for (const [k, s] of Object.entries(node.properties)) {
          if (isScalarSchema(s)) keep[k] = s
        }
        return Object.keys(keep).length ? { ...node, properties: keep } : null
      })
      .filter((n): n is IConfigurationNode => n !== null)
  }, [nodes])

  const filtered = useMemo<IConfigurationNode[]>(() => {
    if (!normalisedQuery) return scalarNodes
    return scalarNodes
      .map((node) => {
        const keep: Record<string, IConfigurationPropertySchema> = {}
        for (const [k, s] of Object.entries(node.properties)) {
          if (k.toLowerCase().includes(normalisedQuery)) keep[k] = s
        }
        return Object.keys(keep).length ? { ...node, properties: keep } : null
      })
      .filter((n): n is IConfigurationNode => n !== null)
  }, [scalarNodes, normalisedQuery])

  const totalKeys = useMemo(
    () => scalarNodes.reduce((acc, n) => acc + Object.keys(n.properties).length, 0),
    [scalarNodes],
  )

  return (
    <div className={styles['root']}>
      <div className={styles['header']}>
        <div className={styles['tabs']}>
          <button
            className={`${styles['tab']} ${activeTarget === ConfigurationTarget.User ? styles['tabActive'] : ''}`}
            aria-selected={activeTarget === ConfigurationTarget.User}
            onClick={() => handleSwitchTarget(ConfigurationTarget.User)}
          >
            {localize('settings.tab.user', 'User')}
          </button>
          <button
            className={`${styles['tab']} ${!hasWorkspace ? styles['tabDisabled'] : ''} ${activeTarget === ConfigurationTarget.Project ? styles['tabActive'] : ''}`}
            aria-selected={activeTarget === ConfigurationTarget.Project}
            onClick={() => handleSwitchTarget(ConfigurationTarget.Project)}
          >
            {localize('settings.tab.workspace', 'Workspace')}
          </button>
        </div>
        <input
          ref={searchInputRef}
          className={styles['search']}
          type="search"
          placeholder={localize('settings.search.placeholder', 'Search settings ({count})', {
            count: totalKeys,
          })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={styles['body']}>
        {filtered.length === 0 ? (
          <div className={styles['empty']}>
            {localize('settings.empty', 'No matching settings.')}
          </div>
        ) : (
          filtered.map((node) => (
            <section key={node.id} className={styles['section']}>
              <h2 className={styles['sectionTitle']}>{node.title ?? node.id}</h2>
              {Object.entries(node.properties).map(([key, schema]) => (
                <PropertyRow
                  key={key}
                  configKey={key}
                  schema={schema}
                  value={config.get(key)}
                  origin={config.getValueOrigin(key)}
                  onChange={(v) => config.update(key, v, activeTarget)}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
