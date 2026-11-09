import type {
  MobileElicitationContentValue,
  MobileElicitationField,
  MobilePendingElicitation,
} from '@universe-editor/mobile-protocol'
import { useEffect, useState, type ReactNode } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'

export type ElicitationFieldValue = string | boolean | readonly string[]

const NO_FIELDS: readonly MobileElicitationField[] = []

export interface ElicitationSheetProps {
  readonly client: Pick<MobileClient, 'resolveElicitation'>
  readonly elicitation: MobilePendingElicitation
  readonly online: boolean
  readonly onNotice: (text: string) => void
}

export function ElicitationSheet({ client, elicitation, online, onNotice }: ElicitationSheetProps) {
  const fields = elicitation.fields ?? NO_FIELDS
  const isForm = elicitation.mode === 'form' && fields.length > 0
  const isUrl = !isForm && (elicitation.url !== undefined || elicitation.mode === 'url')
  const [values, setValues] = useState<Record<string, ElicitationFieldValue>>(() =>
    initialValues(fields),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'accept' | 'decline' | 'cancel' | undefined>(undefined)
  const requestId = elicitation.requestId

  useEffect(() => {
    setValues(initialValues(fields))
    setErrors({})
    setBusy(undefined)
    // Fields are immutable for one request; re-init only when the request changes.
  }, [fields, requestId])

  const run = async (
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, MobileElicitationContentValue>,
  ): Promise<void> => {
    if (busy !== undefined) return
    setBusy(action)
    try {
      await client.resolveElicitation(requestId, action, content)
    } catch (error) {
      setBusy(undefined)
      onNotice(commandErrorText(errorCode(error)))
    }
  }

  const accept = (): void => {
    const nextErrors = validateFields(fields, values)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    void run('accept', buildContent(fields, values))
  }

  return (
    <BottomSheet
      title={strings.pendingElicitationSheetTitle}
      icon="?"
      testId="elicitation-sheet"
      expandKey={requestId}
    >
      <p className="sheet__request" data-testid="elicitation-message">
        {elicitation.message}
      </p>
      {isUrl ? (
        <div className="elicitation-url" data-testid="elicitation-url">
          <span className="sheet__field-label">{strings.elicitationUrlLabel}</span>
          <code className="elicitation-url__value">{elicitation.url ?? ''}</code>
          <p className="sheet__hint">{strings.elicitationUrlHint}</p>
          <div className="sheet-options">
            <button
              type="button"
              className="sheet-option sheet-option--reject"
              disabled={!online || busy !== undefined}
              onClick={() => void run('decline')}
            >
              {busy === 'decline' ? strings.pendingSubmitting : strings.elicitationDecline}
            </button>
            <button
              type="button"
              className="sheet-option sheet-option--cancel"
              disabled={!online || busy !== undefined}
              onClick={() => void run('cancel')}
            >
              {busy === 'cancel' ? strings.pendingSubmitting : strings.elicitationCancel}
            </button>
          </div>
        </div>
      ) : isForm ? (
        <div className="elicitation-form">
          {fields.map((field) => (
            <ElicitationFieldInput
              key={field.name}
              field={field}
              value={values[field.name] ?? emptyValue(field)}
              error={errors[field.name]}
              disabled={!online || busy !== undefined}
              onChange={(value) => {
                setValues((previous) => ({ ...previous, [field.name]: value }))
                setErrors((previous) => {
                  if (previous[field.name] === undefined) return previous
                  const next = { ...previous }
                  delete next[field.name]
                  return next
                })
              }}
            />
          ))}
          <div className="sheet-options">
            <button
              type="button"
              className="sheet-option sheet-option--allow"
              data-testid="elicitation-accept"
              disabled={!online || busy !== undefined}
              onClick={accept}
            >
              {busy === 'accept' ? strings.pendingSubmitting : strings.elicitationAccept}
            </button>
            <button
              type="button"
              className="sheet-option sheet-option--reject"
              disabled={!online || busy !== undefined}
              onClick={() => void run('decline')}
            >
              {busy === 'decline' ? strings.pendingSubmitting : strings.elicitationDecline}
            </button>
            <button
              type="button"
              className="sheet-option sheet-option--cancel"
              disabled={!online || busy !== undefined}
              onClick={() => void run('cancel')}
            >
              {busy === 'cancel' ? strings.pendingSubmitting : strings.elicitationCancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="elicitation-form">
          <p className="sheet__hint">{strings.elicitationTextHint}</p>
          <div className="sheet-options">
            <button
              type="button"
              className="sheet-option sheet-option--allow"
              disabled={!online || busy !== undefined}
              onClick={() => void run('accept')}
            >
              {busy === 'accept' ? strings.pendingSubmitting : strings.elicitationAccept}
            </button>
            <button
              type="button"
              className="sheet-option sheet-option--reject"
              disabled={!online || busy !== undefined}
              onClick={() => void run('decline')}
            >
              {busy === 'decline' ? strings.pendingSubmitting : strings.elicitationDecline}
            </button>
            <button
              type="button"
              className="sheet-option sheet-option--cancel"
              disabled={!online || busy !== undefined}
              onClick={() => void run('cancel')}
            >
              {busy === 'cancel' ? strings.pendingSubmitting : strings.elicitationCancel}
            </button>
          </div>
        </div>
      )}
      {!online && <p className="sheet__hint sheet__hint--danger">{strings.pendingOffline}</p>}
    </BottomSheet>
  )
}

function ElicitationFieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  readonly field: MobileElicitationField
  readonly value: ElicitationFieldValue
  readonly error: string | undefined
  readonly disabled: boolean
  readonly onChange: (value: ElicitationFieldValue) => void
}) {
  const id = `elicit-field-${field.name}`
  const label = (
    <label className="sheet__field-label" htmlFor={kindUsesGroup(field.kind) ? undefined : id}>
      {field.title ?? field.name}
      {field.required ? <span className="sheet__required"> *</span> : null}
    </label>
  )
  const describedBy = error !== undefined ? `${id}-error` : undefined

  let control: ReactNode
  switch (field.kind) {
    case 'string':
      control = (
        <input
          id={id}
          type="text"
          className="sheet__input"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      )
      break
    case 'number':
      control = (
        <input
          id={id}
          type="number"
          className="sheet__input"
          step={field.integer === true ? 1 : 'any'}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      )
      break
    case 'boolean':
      control = (
        <label className="sheet-switch">
          <input
            id={id}
            type="checkbox"
            role="switch"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{value === true ? strings.configOn : strings.configOff}</span>
        </label>
      )
      break
    case 'enum':
      control = (
        <select
          id={id}
          className="sheet__input"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.title}
            </option>
          ))}
        </select>
      )
      break
    case 'enum-multi': {
      const selected = Array.isArray(value) ? value : []
      control = (
        <div className="sheet-checkboxes" role="group" aria-labelledby={`${id}-group`}>
          <span id={`${id}-group`} className="visually-hidden">
            {field.title ?? field.name}
          </span>
          {(field.options ?? []).map((option) => {
            const checked = selected.includes(option.value)
            return (
              <label key={option.value} className="sheet-checkbox">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    onChange(
                      checked
                        ? selected.filter((entry) => entry !== option.value)
                        : [...selected, option.value],
                    )
                  }
                />
                <span>{option.title}</span>
              </label>
            )
          })}
        </div>
      )
      break
    }
  }

  return (
    <div className="sheet-field">
      {label}
      {field.description !== undefined && (
        <p className="sheet-field__description">{field.description}</p>
      )}
      {control}
      {error !== undefined && (
        <p className="sheet-field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  )
}

function kindUsesGroup(kind: MobileElicitationField['kind']): boolean {
  return kind === 'enum-multi' || kind === 'boolean'
}

function emptyValue(field: MobileElicitationField): ElicitationFieldValue {
  switch (field.kind) {
    case 'boolean':
      return false
    case 'enum-multi':
      return []
    default:
      return ''
  }
}

export function initialValues(
  fields: readonly MobileElicitationField[],
): Record<string, ElicitationFieldValue> {
  const values: Record<string, ElicitationFieldValue> = {}
  for (const field of fields) {
    const fallback = emptyValue(field)
    switch (field.kind) {
      case 'string':
      case 'number':
      case 'enum':
        values[field.name] =
          field.default !== undefined && typeof field.default !== 'boolean'
            ? Array.isArray(field.default)
              ? field.default.join(',')
              : String(field.default)
            : fallback
        break
      case 'boolean':
        values[field.name] = field.default === true
        break
      case 'enum-multi':
        values[field.name] = Array.isArray(field.default) ? [...field.default] : []
        break
    }
  }
  return values
}

export function validateFields(
  fields: readonly MobileElicitationField[],
  values: Record<string, ElicitationFieldValue>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const error = validateField(field, values[field.name] ?? emptyValue(field))
    if (error !== undefined) errors[field.name] = error
  }
  return errors
}

export function validateField(
  field: MobileElicitationField,
  value: ElicitationFieldValue,
): string | undefined {
  switch (field.kind) {
    case 'string': {
      const text = typeof value === 'string' ? value : ''
      if (text.trim() === '') return field.required ? strings.elicitationRequired : undefined
      if (field.minLength !== undefined && text.length < field.minLength) {
        return strings.elicitationStringTooShort(field.minLength)
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return strings.elicitationStringTooLong(field.maxLength)
      }
      if (field.pattern !== undefined && !matchesPattern(field.pattern, text)) {
        return strings.elicitationPatternMismatch
      }
      return undefined
    }
    case 'number': {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return field.required ? strings.elicitationRequired : undefined
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) return strings.elicitationNumberInvalid
      if (field.integer === true && !Number.isInteger(parsed)) {
        return strings.elicitationIntegerInvalid
      }
      if (field.minimum !== undefined && parsed < field.minimum) {
        return strings.elicitationNumberTooSmall(field.minimum)
      }
      if (field.maximum !== undefined && parsed > field.maximum) {
        return strings.elicitationNumberTooLarge(field.maximum)
      }
      return undefined
    }
    case 'boolean':
      return undefined
    case 'enum': {
      const text = typeof value === 'string' ? value : ''
      return text === '' && field.required ? strings.elicitationRequired : undefined
    }
    case 'enum-multi': {
      const selected = Array.isArray(value) ? value : []
      const min = field.minItems ?? (field.required ? 1 : 0)
      if (selected.length < min) return strings.elicitationMultiTooFew(min)
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        return strings.elicitationMultiTooMany(field.maxItems)
      }
      return undefined
    }
  }
}

export function buildContent(
  fields: readonly MobileElicitationField[],
  values: Record<string, ElicitationFieldValue>,
): Record<string, MobileElicitationContentValue> {
  const content: Record<string, MobileElicitationContentValue> = {}
  for (const field of fields) {
    const value = values[field.name] ?? emptyValue(field)
    switch (field.kind) {
      case 'string': {
        const text = typeof value === 'string' ? value.trim() : ''
        if (text !== '') content[field.name] = text
        break
      }
      case 'number': {
        const text = typeof value === 'string' ? value.trim() : ''
        if (text === '') break
        const parsed = Number(text)
        if (Number.isFinite(parsed)) content[field.name] = parsed
        break
      }
      case 'boolean':
        content[field.name] = value === true
        break
      case 'enum': {
        const text = typeof value === 'string' ? value : ''
        if (text !== '') content[field.name] = text
        break
      }
      case 'enum-multi': {
        const selected = Array.isArray(value) ? [...value] : []
        if (selected.length > 0) content[field.name] = selected
        break
      }
    }
  }
  return content
}

function matchesPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text)
  } catch {
    return true
  }
}
