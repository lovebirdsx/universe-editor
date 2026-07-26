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
 *
 *  url mode renders a consent card instead: full URL + highlighted domain, and
 *  the link is opened (via IOpenerService) ONLY after the user confirms — no
 *  prefetch, no auto-open (MCP-spec mandatory). Confirm settles accept and the
 *  card stays in a waiting state until the agent's `elicitation/complete`
 *  flips it to done; both states dismiss locally.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { IOpenerService, localize, type ISettableObservable } from '@universe-editor/platform'
import { Button, Checkbox, IconButton, Input, Select } from '@universe-editor/workbench-ui'
import { ExternalLink, X } from 'lucide-react'
import { useObservable, useService } from '../useService.js'
import type {
  AcpPendingElicitation,
  AcpUrlElicitationState,
  IAcpSession,
} from '../../services/acp/acpSessionService.js'
import type { ElicitationSchema } from '@agentclientprotocol/sdk'
import {
  normalizeElicitationForm,
  validateElicitationValues,
  type ElicitationEnumMultiField,
  type ElicitationFormField,
  type ElicitationFormValues,
  type ElicitationStringField,
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

/**
 * Sentinel for the folded-in "Other…" dropdown entry. The fork emits a
 * per-question `<name>_custom` string field whose non-empty text wins over the
 * enum selection (see elicitation.ts in the fork), so the card folds it into
 * the enum's dropdown instead of rendering a separate full-width field.
 */
const OTHER_OPTION_VALUE = '__other__'

interface DisplayField {
  readonly field: ElicitationFormField
  /** The `<field.name>_custom` free-text field folded into this enum's dropdown. */
  readonly customField?: ElicitationStringField
}

function toDisplayFields(fields: readonly ElicitationFormField[]): DisplayField[] {
  const stringFields = new Map(
    fields.filter((f): f is ElicitationStringField => f.kind === 'string').map((f) => [f.name, f]),
  )
  const consumed = new Set<string>()
  const display: DisplayField[] = []
  for (const field of fields) {
    if (consumed.has(field.name)) continue
    if (field.kind === 'enum') {
      const custom = stringFields.get(`${field.name}_custom`)
      if (custom) {
        consumed.add(custom.name)
        display.push({ field, customField: custom })
        continue
      }
    }
    display.push({ field })
  }
  return display
}

export function ElicitationCard({ session }: { session: IAcpSession }) {
  const pending = useObservable(session.pendingElicitation)
  if (!pending) return null
  if (pending.request.mode === 'url' && pending.urlState) {
    return <UrlElicitationCard pending={pending} urlState={pending.urlState} />
  }
  return <FormElicitationCard session={session} pending={pending} />
}

/** Split a URL into (prefix, host, rest) so the domain can be highlighted. */
function splitUrlForDisplay(url: string): { prefix: string; host: string; rest: string } | null {
  try {
    const u = new URL(url)
    return { prefix: `${u.protocol}//`, host: u.host, rest: `${u.pathname}${u.search}${u.hash}` }
  } catch {
    return null
  }
}

function UrlElicitationCard({
  pending,
  urlState,
}: {
  pending: AcpPendingElicitation
  urlState: ISettableObservable<AcpUrlElicitationState>
}) {
  const opener = useService(IOpenerService)
  const state = useObservable(urlState)
  const request = pending.request
  // The custom-mode variant's index signature types these as unknown.
  const rawUrl = 'url' in request ? request.url : undefined
  const url = typeof rawUrl === 'string' ? rawUrl : ''
  const parts = useMemo(() => splitUrlForDisplay(url), [url])

  const close = (): void => {
    if (state === 'consent') {
      pending.cancel()
    } else {
      // waiting / done: the protocol exchange already settled — local teardown.
      pending.dismiss?.()
    }
  }
  const confirm = (): void => {
    // Consent-gated open: never prefetch, never auto-open (spec mandatory).
    void opener.open(url)
    pending.resolve({ action: 'accept' })
  }
  const decline = (): void => {
    pending.resolve({ action: 'decline' })
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
      {state === 'consent' && (
        <>
          <div className={styles['elicitationDescription']}>
            {localize(
              'acp.elicitation.url.hint',
              'The agent asks you to open this link in your browser. It will not be opened automatically — only continue if you trust it.',
            )}
          </div>
          <code className={styles['elicitationUrl']} data-testid="acp-elicitation-url">
            {parts ? (
              <>
                {parts.prefix}
                <strong className={styles['elicitationUrlDomain']}>{parts.host}</strong>
                {parts.rest}
              </>
            ) : (
              url
            )}
          </code>
          <div className={styles['questionActions']}>
            <Button
              variant="primary"
              size="sm"
              onClick={confirm}
              data-testid="acp-elicitation-url-open"
            >
              <ExternalLink size={13} strokeWidth={1.75} />
              {localize('acp.elicitation.url.open', 'Open link')}
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
        </>
      )}
      {state === 'waiting' && (
        <div className={styles['elicitationDescription']} data-testid="acp-elicitation-url-waiting">
          {localize(
            'acp.elicitation.url.waiting',
            'Opened in your browser — waiting for the agent to finish…',
          )}
        </div>
      )}
      {state === 'done' && (
        <div className={styles['elicitationDescription']} data-testid="acp-elicitation-url-done">
          {localize('acp.elicitation.url.done', 'The agent has finished this flow.')}
        </div>
      )}
    </section>
  )
}

function FormElicitationCard({
  session,
  pending,
}: {
  session: IAcpSession
  pending: AcpPendingElicitation
}) {
  const request = pending.request
  // The custom-mode variant's index signature types `toolCallId` as unknown.
  const rawToolCallId = 'toolCallId' in request ? request.toolCallId : undefined
  const toolCallId = typeof rawToolCallId === 'string' ? rawToolCallId : undefined
  const draftKey = elicitationDraftKey(toolCallId, request.message ?? '')

  const fields = useMemo(
    () =>
      request.mode === 'form' && 'requestedSchema' in request
        ? normalizeElicitationForm(request.requestedSchema as ElicitationSchema, (m) =>
            console.warn(`[elicitation] ${m}`),
          )
        : [],
    [request],
  )
  const displayFields = useMemo(() => toDisplayFields(fields), [fields])

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
    AcpElicitationDraftCache.save(session.id, draftKey, values)
  }, [values, session.id, draftKey])

  const patch = (name: string, value: string | boolean | string[] | undefined): void => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setError(null)
  }

  const submit = (): void => {
    // A folded "Other…" answer replaces the enum selection: non-empty custom
    // text (or a bare sentinel pick) drops the enum value, so the content only
    // carries the custom field — mirroring the fork's custom-wins rule.
    const cleaned: CardValues = { ...values }
    for (const { field, customField } of displayFields) {
      if (!customField) continue
      const custom = cleaned[customField.name]
      if (
        cleaned[field.name] === OTHER_OPTION_VALUE ||
        (typeof custom === 'string' && custom.trim() !== '')
      ) {
        delete cleaned[field.name]
      }
    }
    const built = buildContent(fields, cleaned)
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
      {displayFields.map(({ field, customField }) => (
        <ElicitationFieldRow
          key={field.name}
          field={field}
          customField={customField}
          value={values[field.name]}
          customValue={customField ? values[customField.name] : undefined}
          onChange={(v) => patch(field.name, v)}
          onCustomChange={customField ? (v) => patch(customField.name, v) : undefined}
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
  customField,
  value,
  customValue,
  onChange,
  onCustomChange,
}: {
  field: ElicitationFormField
  customField?: ElicitationStringField | undefined
  value: string | boolean | string[] | undefined
  customValue?: string | boolean | string[] | undefined
  onChange: (value: string | boolean | string[] | undefined) => void
  onCustomChange?: ((value: string) => void) | undefined
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
      <FieldControl
        field={field}
        customField={customField}
        value={value}
        customValue={customValue}
        onChange={onChange}
        onCustomChange={onCustomChange}
      />
    </div>
  )
}

function FieldControl({
  field,
  customField,
  value,
  customValue,
  onChange,
  onCustomChange,
}: {
  field: ElicitationFormField
  customField?: ElicitationStringField | undefined
  value: string | boolean | string[] | undefined
  customValue?: string | boolean | string[] | undefined
  onChange: (value: string | boolean | string[] | undefined) => void
  onCustomChange?: ((value: string) => void) | undefined
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
          customField={customField}
          customValue={typeof customValue === 'string' ? customValue : ''}
          onCustomChange={onCustomChange}
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
  customField,
  customValue,
  onCustomChange,
}: {
  field: Extract<ElicitationFormField, { kind: 'enum' }>
  value: string
  onChange: (value: string) => void
  footer?: ReactNode
  customField?: ElicitationStringField | undefined
  customValue: string
  onCustomChange?: ((value: string) => void) | undefined
}) {
  const otherTitle = customField?.title ?? 'Other'
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
            // Trigger stays a compact one-liner; the description shows in the
            // dropdown item and (once selected) in the footer below — nowhere else.
            triggerLabel: o.title,
            label: (
              <span className={styles['elicitationOption']}>
                <span>{o.title}</span>
                {o.description && (
                  <span className={styles['elicitationOptionDescription']}>{o.description}</span>
                )}
              </span>
            ),
          })),
          ...(customField
            ? [
                {
                  value: OTHER_OPTION_VALUE,
                  text: otherTitle,
                  triggerLabel:
                    customValue.trim() !== '' ? `${otherTitle}: ${customValue.trim()}` : otherTitle,
                  label: (
                    <span className={styles['elicitationOption']}>
                      <span>{otherTitle}</span>
                      {customField.description && (
                        <span className={styles['elicitationOptionDescription']}>
                          {customField.description}
                        </span>
                      )}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
        onChange={(v) => {
          onChange(v)
          // Picking a concrete option abandons any typed custom answer.
          if (v !== OTHER_OPTION_VALUE) onCustomChange?.('')
        }}
        aria-label={field.title ?? field.name}
        data-testid={`acp-elicitation-input-${field.name}`}
      />
      {customField && value === OTHER_OPTION_VALUE && (
        <Input
          value={customValue}
          spellCheck={false}
          placeholder={customField.description}
          onChange={(e) => onCustomChange?.(e.target.value)}
          data-testid={`acp-elicitation-input-${customField.name}`}
        />
      )}
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
