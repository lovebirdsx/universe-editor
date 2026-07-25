/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ElicitationCard — renders the active session's pending elicitation
 *  (`elicitation/create`) inline above the prompt input. Form mode renders the
 *  agent's JSON Schema as a field list (string / number / boolean / enum /
 *  enum-multi); the three exits map to the protocol's three actions: 提交 =
 *  accept + content, 拒绝 = decline (an explicit refusal — the server may take
 *  an alternative path), 关闭 (Esc / ×) = cancel (no answer given). In-progress
 *  input survives session switches via AcpElicitationDraftCache; only a real
 *  answer (submit / decline / close) clears it.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { localize } from '@universe-editor/platform'
import { Button, Checkbox, IconButton, Input, Select } from '@universe-editor/workbench-ui'
import { X } from 'lucide-react'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import type { ElicitationSchema } from '@agentclientprotocol/sdk'
import {
  normalizeElicitationForm,
  validateElicitationValues,
  type ElicitationEnumMultiField,
  type ElicitationFormField,
  type ElicitationFormValues,
} from '../../services/acp/acpElicitationForm.js'
import {
  AcpElicitationDraftCache,
  elicitationDraftKey,
  type ElicitationDraftValues,
} from '../../services/acp/acpElicitationDraftCache.js'
import styles from './agents.module.css'

/** Editable input state — numbers stay raw strings until submit conversion. */
type CardValues = ElicitationDraftValues

function initialValues(
  fields: readonly ElicitationFormField[],
  saved: ElicitationDraftValues | undefined,
): CardValues {
  if (saved) return { ...saved }
  const values: CardValues = {}
  for (const field of fields) {
    if (field.default === undefined) continue
    values[field.name] = (
      field.kind === 'number'
        ? String(field.default)
        : Array.isArray(field.default)
          ? [...field.default]
          : field.default
    ) as string | boolean | string[]
  }
  return values
}

/** Convert the editable state into wire content; returns the error key 'nan' when a number field is unparseable. */
function buildContent(
  fields: readonly ElicitationFormField[],
  values: CardValues,
): { content: ElicitationFormValues } | { errorField: ElicitationFormField } {
  const content: ElicitationFormValues = {}
  for (const field of fields) {
    const raw = values[field.name]
    switch (field.kind) {
      case 'string':
      case 'enum':
        if (typeof raw === 'string' && raw !== '') content[field.name] = raw
        break
      case 'number': {
        if (typeof raw !== 'string' || raw.trim() === '') break
        const num = Number(raw)
        if (Number.isNaN(num)) return { errorField: field }
        content[field.name] = field.integer ? Math.round(num) : num
        break
      }
      case 'boolean':
        content[field.name] = raw === true
        break
      case 'enum-multi':
        if (Array.isArray(raw) && raw.length > 0) content[field.name] = raw
        break
    }
  }
  return { content }
}

export function ElicitationCard({ session }: { session: IAcpSession }) {
  const pending = useObservable(session.pendingElicitation)
  const request = pending?.request
  const rawToolCallId = request != null && 'toolCallId' in request ? request.toolCallId : undefined
  // The custom-mode variant's index signature types `toolCallId` as unknown.
  const toolCallId = typeof rawToolCallId === 'string' ? rawToolCallId : undefined
  const draftKey = elicitationDraftKey(toolCallId, request?.message ?? '')

  const fields = useMemo(
    () =>
      request != null && request.mode === 'form' && 'requestedSchema' in request
        ? normalizeElicitationForm(request.requestedSchema as ElicitationSchema, (m) =>
            console.warn(`[elicitation] ${m}`),
          )
        : [],
    [request],
  )

  // Reset the input state whenever a new elicitation arrives (canonical
  // "reset state on prop change" — no effect needed). The first paint seeds
  // from the draft cache so a session switch restores in-progress input.
  const [stateKey, setStateKey] = useState(draftKey)
  const [values, setValues] = useState<CardValues>(() =>
    initialValues(fields, AcpElicitationDraftCache.load(session.id, draftKey)),
  )
  const [error, setError] = useState<string | null>(null)
  if (draftKey !== stateKey) {
    setStateKey(draftKey)
    setValues(initialValues(fields, AcpElicitationDraftCache.load(session.id, draftKey)))
    setError(null)
  }

  useEffect(() => {
    if (pending) AcpElicitationDraftCache.save(session.id, draftKey, values)
  }, [values, session.id, draftKey, pending])

  if (!pending || !request) return null

  const patch = (name: string, value: string | boolean | string[] | undefined): void => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setError(null)
  }

  const submit = (): void => {
    const built = buildContent(fields, values)
    if ('errorField' in built) {
      setError(
        localize('acp.elicitation.notANumber', '"{field}" must be a number', {
          field: built.errorField.title ?? built.errorField.name,
        }),
      )
      return
    }
    const validation = validateElicitationValues(fields, built.content)
    if (validation) {
      setError(validation)
      return
    }
    AcpElicitationDraftCache.clear(session.id, draftKey)
    pending.resolve({ action: 'accept', content: built.content })
  }

  const decline = (): void => {
    AcpElicitationDraftCache.clear(session.id, draftKey)
    pending.resolve({ action: 'decline' })
  }

  const close = (): void => {
    AcpElicitationDraftCache.clear(session.id, draftKey)
    pending.cancel()
  }

  return (
    <section
      className={styles['elicitationCard']}
      data-testid="acp-elicitation-card"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
      }}
    >
      <header className={styles['elicitationHeader']}>
        <span className={styles['elicitationMessage']}>{request.message}</span>
        <IconButton
          label={localize('acp.elicitation.close', 'Close (Esc)')}
          onClick={close}
          data-testid="acp-elicitation-close"
        >
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      </header>
      {request.mode !== 'form' && (
        <div className={styles['elicitationDescription']}>
          {localize('acp.elicitation.unsupportedMode', 'Unsupported elicitation mode: {mode}', {
            mode: request.mode,
          })}
        </div>
      )}
      {fields.map((field) => (
        <ElicitationFieldRow
          key={field.name}
          field={field}
          value={values[field.name]}
          onChange={(v) => patch(field.name, v)}
        />
      ))}
      {error && (
        <div className={styles['elicitationError']} data-testid="acp-elicitation-error">
          {error}
        </div>
      )}
      <div className={styles['questionActions']}>
        <Button variant="primary" size="sm" onClick={submit} data-testid="acp-elicitation-submit">
          {localize('acp.elicitation.submit', 'Submit')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={decline}
          data-testid="acp-elicitation-decline"
        >
          {localize('acp.elicitation.decline', 'Decline')}
        </Button>
      </div>
    </section>
  )
}

function ElicitationFieldRow({
  field,
  value,
  onChange,
}: {
  field: ElicitationFormField
  value: string | boolean | string[] | undefined
  onChange: (value: string | boolean | string[] | undefined) => void
}) {
  return (
    <div className={styles['elicitationField']} data-testid={`acp-elicitation-field-${field.name}`}>
      <span className={styles['elicitationLabel']}>
        {field.title ?? field.name}
        {field.required && <span className={styles['elicitationRequired']}>*</span>}
      </span>
      {field.description && (
        <span className={styles['elicitationDescription']}>{field.description}</span>
      )}
      <FieldControl field={field} value={value} onChange={onChange} />
    </div>
  )
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: ElicitationFormField
  value: string | boolean | string[] | undefined
  onChange: (value: string | boolean | string[] | undefined) => void
}) {
  switch (field.kind) {
    case 'string':
      return (
        <Input
          value={typeof value === 'string' ? value : ''}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`acp-elicitation-input-${field.name}`}
        />
      )
    case 'number':
      return (
        <Input
          type="number"
          value={typeof value === 'string' ? value : ''}
          spellCheck={false}
          {...(field.minimum != null ? { min: field.minimum } : {})}
          {...(field.maximum != null ? { max: field.maximum } : {})}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`acp-elicitation-input-${field.name}`}
        />
      )
    case 'boolean':
      return (
        <Checkbox
          checked={value === true}
          onChange={(checked) => onChange(checked)}
          data-testid={`acp-elicitation-input-${field.name}`}
        />
      )
    case 'enum': {
      const selected = field.options.find((o) => o.value === value)
      return (
        <EnumSelect
          field={field}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          footer={
            selected && (selected.description || selected.preview) ? (
              <span className={styles['elicitationDescription']}>
                {selected.description}
                {selected.preview && (
                  <pre
                    className={styles['elicitationPreview']}
                    data-testid={`acp-elicitation-preview-${field.name}`}
                  >
                    {selected.preview}
                  </pre>
                )}
              </span>
            ) : undefined
          }
        />
      )
    }
    case 'enum-multi':
      return (
        <EnumMultiGroup
          field={field}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      )
  }
}

function EnumSelect({
  field,
  value,
  onChange,
  footer,
}: {
  field: Extract<ElicitationFormField, { kind: 'enum' }>
  value: string
  onChange: (value: string) => void
  footer?: ReactNode
}) {
  // Esc inside the self-drawn dropdown must close the dropdown only, not the
  // whole card — stop it from bubbling to the card's Escape handler (the
  // dropdown is a React descendant through the portal, so it would reach us).
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <Select
        value={value}
        options={[
          { value: '', label: localize('acp.elicitation.selectPlaceholder', 'Select…') },
          ...field.options.map((o) => ({
            value: o.value,
            text: o.title,
            label: (
              <span className={styles['elicitationOption']}>
                <span>{o.title}</span>
                {o.description && (
                  <span className={styles['elicitationOptionDescription']}>{o.description}</span>
                )}
              </span>
            ),
          })),
        ]}
        onChange={onChange}
        aria-label={field.title ?? field.name}
        data-testid={`acp-elicitation-input-${field.name}`}
      />
      {footer}
    </div>
  )
}

function EnumMultiGroup({
  field,
  value,
  onChange,
}: {
  field: ElicitationEnumMultiField
  value: string[]
  onChange: (value: string[]) => void
}) {
  const toggle = (optionValue: string, checked: boolean): void => {
    onChange(checked ? [...value, optionValue] : value.filter((v) => v !== optionValue))
  }
  return (
    <div className={styles['elicitationCheckGroup']}>
      {field.options.map((o) => (
        <Checkbox
          key={o.value}
          checked={value.includes(o.value)}
          onChange={(checked) => toggle(o.value, checked)}
          label={
            <span className={styles['elicitationOption']}>
              <span>{o.title}</span>
              {o.description && (
                <span className={styles['elicitationOptionDescription']}>{o.description}</span>
              )}
            </span>
          }
          data-testid={`acp-elicitation-input-${field.name}-${o.value}`}
        />
      ))}
    </div>
  )
}
