/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-row control for the settings editor, dispatched on the JSON-schema
 *  shape: enum → themed Select, boolean → Checkbox, number/string → Input.
 *  All controls commit "write the default = reset" (undefined) so the key is
 *  deleted from the layer instead of pinning a copy of the default value.
 *--------------------------------------------------------------------------------------------*/

import { memo, useEffect, useState, type JSX } from 'react'
import { localize, type IConfigurationPropertySchema } from '@universe-editor/platform'
import { Checkbox, Input, Select } from '@universe-editor/workbench-ui'

interface ControlProps {
  configKey: string
  schema: IConfigurationPropertySchema
  value: unknown
  onCommit: (value: unknown) => void
}

function EnumControl({ schema, value, onCommit }: ControlProps): JSX.Element {
  const options = (schema.enum ?? []).map((opt) => {
    const str = String(opt)
    const label = schema.enumItemLabels?.[str] ?? str
    return {
      value: str,
      label:
        opt === schema.default
          ? `${label} (${localize('settings.defaultBadge', 'default')})`
          : label,
      text: str,
    }
  })
  return (
    <Select
      value={String(value ?? '')}
      options={options}
      onChange={(v) => onCommit(v === String(schema.default) ? undefined : v)}
      aria-label={localize('settings.control.ariaLabel', 'Setting value')}
    />
  )
}

function BooleanControl({ value, schema, onCommit }: ControlProps): JSX.Element {
  return (
    <Checkbox
      checked={Boolean(value)}
      onChange={(checked) => onCommit(checked === schema.default ? undefined : checked)}
    />
  )
}

function NumberControl({ value, schema, onCommit }: ControlProps): JSX.Element {
  // Draft state so typing intermediates ('', '1.') never commit garbage; the
  // committed value flows back in as a normal render prop. An empty draft is
  // held until blur — committing the reset immediately would snap the field
  // back to the default while the user is mid-edit.
  const [draft, setDraft] = useState<string | undefined>(undefined)
  useEffect(() => {
    setDraft(undefined)
  }, [value])

  return (
    <Input
      type="number"
      value={draft ?? String(value ?? '')}
      {...(schema.minimum !== undefined ? { min: schema.minimum } : {})}
      {...(schema.maximum !== undefined ? { max: schema.maximum } : {})}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (raw === '') return
        const n = Number(raw)
        if (!Number.isNaN(n)) onCommit(n === schema.default ? undefined : n)
      }}
      onBlur={() => {
        if (draft === '') onCommit(undefined)
      }}
    />
  )
}

function StringControl({ value, schema, onCommit }: ControlProps): JSX.Element {
  const [draft, setDraft] = useState<string | undefined>(undefined)
  useEffect(() => {
    setDraft(undefined)
  }, [value])

  return (
    <Input
      type="text"
      value={draft ?? String(value ?? '')}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        onCommit(raw === String(schema.default ?? '') ? undefined : raw)
      }}
    />
  )
}

export const SettingsRowControl = memo(function SettingsRowControl(props: ControlProps) {
  const { configKey, schema } = props
  return (
    <div data-testid={`setting-control-${configKey}`}>
      {Array.isArray(schema.enum) && schema.enum.length > 0 ? (
        <EnumControl {...props} />
      ) : schema.type === 'boolean' ? (
        <BooleanControl {...props} />
      ) : schema.type === 'number' || schema.type === 'integer' ? (
        <NumberControl {...props} />
      ) : schema.type === 'string' ? (
        <StringControl {...props} />
      ) : (
        <span>{localize('settings.readonly', 'Not editable in form view')}</span>
      )}
    </div>
  )
})
