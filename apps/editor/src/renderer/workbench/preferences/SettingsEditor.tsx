/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Form-driven settings editor. Renders one section per registered
 *  ConfigurationNode; control type is chosen from the JSON-schema entry.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useReducer, useState, type JSX } from 'react'
import {
  ConfigurationRegistry,
  ConfigurationTarget,
  IConfigurationService,
  type IConfigurationNode,
  type IConfigurationPropertySchema,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import styles from './SettingsEditor.module.css'

interface RowProps {
  configKey: string
  schema: IConfigurationPropertySchema
  value: unknown
  onChange: (value: unknown) => void
}

function PropertyRow({ configKey, schema, value, onChange }: RowProps) {
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
            {String(opt)}
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
  } else if (schema.type === 'number') {
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
    control = <span className={styles['readonly']}>Not editable in form view</span>
  }

  return (
    <div className={styles['row']} data-key={configKey}>
      <div className={styles['rowMeta']}>
        <div className={styles['rowKey']}>{configKey}</div>
        {schema.description ? <div className={styles['rowDesc']}>{schema.description}</div> : null}
      </div>
      <div className={styles['rowControl']}>{control}</div>
    </div>
  )
}

export function SettingsEditor() {
  const config = useService(IConfigurationService)
  const [query, setQuery] = useState('')
  const [, bump] = useReducer((n: number) => n + 1, 0)

  // Re-render whenever schema registry changes or any configuration value changes.
  useEffect(() => {
    const d1 = ConfigurationRegistry.onDidRegisterConfiguration(() => bump())
    const d2 = config.onDidChangeConfiguration(() => bump())
    return () => {
      d1.dispose()
      d2.dispose()
    }
  }, [config])

  const nodes = ConfigurationRegistry.getConfigurationNodes()
  const normalisedQuery = query.trim().toLowerCase()

  const filtered = useMemo<IConfigurationNode[]>(() => {
    if (!normalisedQuery) return [...nodes]
    return nodes
      .map((node) => {
        const keep: Record<string, IConfigurationPropertySchema> = {}
        for (const [k, s] of Object.entries(node.properties)) {
          if (k.toLowerCase().includes(normalisedQuery)) keep[k] = s
        }
        return Object.keys(keep).length ? { ...node, properties: keep } : null
      })
      .filter((n): n is IConfigurationNode => n !== null)
  }, [nodes, normalisedQuery])

  const totalKeys = useMemo(
    () => nodes.reduce((acc, n) => acc + Object.keys(n.properties).length, 0),
    [nodes],
  )

  return (
    <div className={styles['root']}>
      <div className={styles['header']}>
        <input
          className={styles['search']}
          type="search"
          placeholder={`Search settings (${totalKeys})`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className={styles['body']}>
        {filtered.length === 0 ? (
          <div className={styles['empty']}>No matching settings.</div>
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
                  onChange={(v) => config.update(key, v, ConfigurationTarget.User)}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
