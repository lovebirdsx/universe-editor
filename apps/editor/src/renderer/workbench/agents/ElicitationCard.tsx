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
import { ChevronDown, ChevronUp, ExternalLink, X } from 'lucide-react'
import { useObservable, useService } from '../useService.js'
import type {
  AcpPendingElicitation,
  AcpUrlElicitationState,
  IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
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
} from '../../services/acp/session/acpElicitationDraftCache.js'
import { PlanAutoExecuteToggle } from './PlanAutoExecuteToggle.js'
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
 * Pairs an AskUserQuestion-style free-text field with its enum question so the
 * two render side by side on one row: the select plus an always-visible
 * notes/"Other" input. Two suffix conventions are recognized: claude's fork
 * emits `<name>_custom` per question, codex's fork emits `<name>__other` for
 * request_user_input's other-answer; on submit both values travel together and
 * each agent bridge folds the text into a note on the selection (claude as
 * annotations, codex as `<label>（补充：<note>）`), standing alone as the
 * answer only when nothing is picked. The two controls keep
 * their values independently — clearing either on the other's edit would
 * silently destroy user input.
 */
interface DisplayField {
  readonly field: ElicitationFormField
  /** The `<field.name>_custom` / `<field.name>__other` free-text field rendered beside this enum's select. */
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
      const custom =
        stringFields.get(`${field.name}_custom`) ?? stringFields.get(`${field.name}__other`)
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

/**
 * Shared frame for the form/url cards: header holds the agent's question
 * (single-line ellipsis when collapsed) plus collapse and close actions. The
 * collapse is pure visual — only the body is conditionally rendered, while each
 * card keeps its own input state ABOVE this shell, so folding never unmounts
 * the in-progress values and never touches the pending elicitation. Esc on the
 * root still closes/cancels regardless of collapsed state (a collapse toggle
 * must not repurpose that gesture).
 */
function ElicitationShell({
  message,
  collapsed,
  onToggleCollapse,
  onClose,
  children,
}: {
  message: ReactNode
  collapsed: boolean
  onToggleCollapse: () => void
  onClose: () => void
  children?: ReactNode
}) {
  return (
    <section
      className={
        collapsed
          ? `${styles['elicitationCard']} ${styles['elicitationCardCollapsed']}`
          : styles['elicitationCard']
      }
      data-testid="acp-elicitation-card"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <header className={styles['elicitationHeader']}>
        <span className={styles['elicitationMessage']}>{message}</span>
        <div className={styles['elicitationHeaderActions']}>
          <IconButton
            label={
              collapsed
                ? localize('acp.elicitation.expand', 'Expand question')
                : localize('acp.elicitation.collapse', 'Collapse question')
            }
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            data-testid="acp-elicitation-collapse"
          >
            {collapsed ? (
              <ChevronUp size={14} strokeWidth={1.75} />
            ) : (
              <ChevronDown size={14} strokeWidth={1.75} />
            )}
          </IconButton>
          <IconButton
            label={localize('acp.elicitation.close', 'Close (Esc)')}
            onClick={onClose}
            data-testid="acp-elicitation-close"
          >
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
      </header>
      {!collapsed && children}
    </section>
  )
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

  // A fresh elicitation resets the fold so it never opens collapsed.
  const rawElicitationId = 'elicitationId' in request ? request.elicitationId : undefined
  const elicitationId = typeof rawElicitationId === 'string' ? rawElicitationId : undefined
  const collapseKey = elicitationId ?? `msg:${request.message ?? ''}`
  const [collapseStateKey, setCollapseStateKey] = useState(collapseKey)
  const [collapsed, setCollapsed] = useState(false)
  if (collapseKey !== collapseStateKey) {
    setCollapseStateKey(collapseKey)
    setCollapsed(false)
  }

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
    <ElicitationShell
      message={request.message}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      onClose={close}
    >
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
    </ElicitationShell>
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
  // Fold is per-elicitation and defaults open so a new question is never missed.
  const [collapsed, setCollapsed] = useState(false)
  if (draftKey !== stateKey) {
    setStateKey(draftKey)
    setValues(initialValues(fields, AcpElicitationDraftCache.load(session.id, draftKey)))
    setError(null)
    setCollapsed(false)
  }

  useEffect(() => {
    AcpElicitationDraftCache.save(session.id, draftKey, values)
  }, [values, session.id, draftKey])

  const patch = (name: string, value: string | boolean | string[] | undefined): void => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setError(null)
  }

  const submit = (): void => {
    // Selection and custom text are submitted together: the agent bridge folds
    // non-empty custom text into notes on the selection (or a notes-only answer
    // when nothing is picked), so a remark never swallows the picked option.
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

  // Plan 会话中的提问（AskUserQuestion 通常出现在 plan 制定过程中）是预设
  // 「计划完成后自动执行」的天然触点：此处勾选后，随后的 ExitPlanMode 卡片
  // 就会走倒计时自动执行，无需再手动点选。非 plan 会话不提供该开关。
  const configOptions = useObservable(session.configOptions)
  const isPlanMode = configOptions.some((o) => o.category === 'mode' && o.currentValue === 'plan')

  return (
    <ElicitationShell
      message={request.message}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      onClose={close}
    >
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
      {isPlanMode && (
        <div className={styles['permissionAuto']}>
          <PlanAutoExecuteToggle testId="acp-elicitation-auto-execute" />
        </div>
      )}
    </ElicitationShell>
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
  // Esc inside the self-drawn dropdown must close the dropdown only, not the
  // whole card — stop it from bubbling to the card's Escape handler (the
  // dropdown is a React descendant through the portal, so it would reach us).
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <div className={customField ? styles['elicitationEnumRow'] : undefined}>
        <Select
          value={value}
          wrapItems
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
          ]}
          onChange={onChange}
          aria-label={field.title ?? field.name}
          data-testid={`acp-elicitation-input-${field.name}`}
        />
        {customField && (
          <Input
            value={customValue}
            spellCheck={false}
            placeholder={localize('acp.elicitation.otherPlaceholder', 'Notes or other answer…')}
            aria-label={customField.title ?? 'Other'}
            onChange={(e) => onCustomChange?.(e.target.value)}
            data-testid={`acp-elicitation-input-${customField.name}`}
          />
        )}
      </div>
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
