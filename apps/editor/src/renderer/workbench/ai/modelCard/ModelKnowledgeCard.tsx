/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ModelKnowledgeCard — the editable surface for one entry of the `models`
 *  knowledge base: the intrinsic properties of a model that do not change when it
 *  is reached through a different gateway (display name, family, real vendor,
 *  native protocol, token limits, capabilities, reasoning-effort levels, request
 *  parameter schema). Pricing is deliberately absent — a rate is a function of
 *  (channel, model) and lives on the provider entry.
 *
 *  Same paradigm as the provider cards: every field commits on blur / selection
 *  and reports back with a "Saved" flag next to that field alone. There is no
 *  card-level dirty state and no Save button.
 *
 *  The inheritance rule mirrors RemoteSourceFields: what a row *renders* is the
 *  effective value (the user's own, else the built-in entry's), but what it
 *  *writes* is only the user layer. Clearing a field deletes the key, at which
 *  point the row falls back to showing the built-in value again — that is the
 *  visible "reset this field" gesture, and it is why an Override starts as an
 *  empty object instead of a copy of the built-in entry: copying would pin the
 *  values against a future built-in catalog upgrade.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Cpu, PenLine, RotateCcw, Trash2 } from 'lucide-react'
import {
  AI_WIRE_PROTOCOLS,
  localize,
  type AiModelCapabilities,
  type AiModelKnowledge,
  type AiWireProtocol,
} from '@universe-editor/platform'
import {
  Badge,
  Button,
  Checkbox,
  FocusScopeOverlay,
  IconButton,
  Input,
  Select,
} from '@universe-editor/workbench-ui'
import { AI_CAPABILITY_KEYS, type AiCapabilityKey } from '../../../../shared/ai/protocolMapEdit.js'
import {
  formatReasoningEffort,
  parseReasoningEffort,
  toggledCapabilities,
  validateParametersSchema,
} from '../../../../shared/ai/modelKnowledgeEdit.js'
import { HeaderAction } from '../providerCard/HeaderAction.js'
import { SettingRow } from '../providerCard/SettingRow.js'
import {
  patchField,
  useEditableText,
  useEntryField,
  type SavedStamp,
} from '../providerCard/useProviderField.js'
import { useEditableNumber } from './useEditableNumber.js'
import styles from '../AiSettingsEditor.module.css'

export type KnowledgePatch = (entry: AiModelKnowledge) => AiModelKnowledge

export interface ModelKnowledgeCardProps {
  readonly modelKey: string
  /** The user's own layer for this key — the only thing this card writes. */
  readonly own: AiModelKnowledge
  /** Built-in entry for this key, when one exists. Rendered as the fallback. */
  readonly builtin: AiModelKnowledge | undefined
  /** Provider ids whose protocolMap references this key. */
  readonly usedBy: readonly string[]
  readonly disabled: boolean
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly updateEntry: (build: KnowledgePatch) => Promise<void>
  readonly onRename: () => void
  readonly onDuplicate: () => void
  readonly onRemove: () => void
}

export function ModelKnowledgeCard({
  modelKey,
  own,
  builtin,
  usedBy,
  disabled,
  collapsed,
  onToggleCollapsed,
  updateEntry,
  onRename,
  onDuplicate,
  onRemove,
}: ModelKnowledgeCardProps) {
  const { setField, apply, saved } = useEntryField<AiModelKnowledge>(updateEntry)
  const [parametersOpen, setParametersOpen] = useState(false)

  const effective: AiModelKnowledge = useMemo(
    () => (builtin === undefined ? own : { ...builtin, ...own }),
    [builtin, own],
  )

  return (
    <section
      className={styles['card']}
      data-testid="ai-model-knowledge-card"
      data-model-key={modelKey}
    >
      <button
        type="button"
        className={styles['cardHeader']}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        {collapsed ? (
          <ChevronRight size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        ) : (
          <ChevronDown size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        )}
        <Cpu size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        <span className={styles['cardTitle']}>{modelKey}</span>
        <div className={styles['cardBadges']}>
          {builtin !== undefined ? (
            <Badge tone="accent">
              {localize('aiKnowledge.badge.overridesBuiltin', 'Overrides built-in')}
            </Badge>
          ) : (
            <Badge>{localize('aiKnowledge.badge.custom', 'Custom')}</Badge>
          )}
          {effective.name !== undefined && <Badge>{effective.name}</Badge>}
          {usedBy.length > 0 && (
            <Badge>
              <span data-tooltip={usedBy.join(', ')}>
                {localize('aiKnowledge.badge.usedBy', 'Used by {count} providers', {
                  count: usedBy.length,
                })}
              </span>
            </Badge>
          )}
        </div>
        <span className={styles['spacer']} />
        <HeaderAction
          label={localize('aiKnowledge.card.rename', 'Rename model key')}
          disabled={disabled}
          onTrigger={onRename}
        >
          <PenLine size={15} strokeWidth={1.75} />
        </HeaderAction>
        <HeaderAction
          label={localize('aiKnowledge.card.duplicate', 'Duplicate model')}
          disabled={disabled}
          onTrigger={onDuplicate}
        >
          <Copy size={15} strokeWidth={1.75} />
        </HeaderAction>
        <HeaderAction
          label={
            builtin === undefined
              ? localize('aiKnowledge.card.remove', 'Remove model')
              : localize('aiKnowledge.card.reset', 'Reset to built-in')
          }
          disabled={disabled}
          onTrigger={onRemove}
        >
          {builtin === undefined ? (
            <Trash2 size={15} strokeWidth={1.75} />
          ) : (
            <RotateCcw size={15} strokeWidth={1.75} />
          )}
        </HeaderAction>
      </button>

      {!collapsed && (
        <div className={styles['cardBody']}>
          <TextRow
            field="name"
            label={localize('aiKnowledge.field.name', 'Display name')}
            own={own.name}
            builtin={builtin?.name}
            saved={saved}
            disabled={disabled}
            onCommit={(value) => void setField('name', value)}
          />
          <TextRow
            field="family"
            label={localize('aiKnowledge.field.family', 'Family')}
            own={own.family}
            builtin={builtin?.family}
            saved={saved}
            disabled={disabled}
            onCommit={(value) => void setField('family', value)}
          />
          <TextRow
            field="vendor"
            label={localize('aiKnowledge.field.vendor', 'Vendor')}
            own={own.vendor}
            builtin={builtin?.vendor}
            saved={saved}
            disabled={disabled}
            onCommit={(value) => void setField('vendor', value)}
          />

          <SettingRow
            label={localize('aiKnowledge.field.nativeProtocol', 'Native protocol')}
            saved={saved}
            field="nativeProtocol"
            control={
              <Select<AiWireProtocol | ''>
                value={own.nativeProtocol ?? ''}
                disabled={disabled}
                aria-label={localize('aiKnowledge.field.nativeProtocol', 'Native protocol')}
                data-testid="ai-knowledge-native-protocol"
                options={[
                  { value: '', label: unsetProtocolLabel(builtin?.nativeProtocol) },
                  ...AI_WIRE_PROTOCOLS.map((p) => ({ value: p, label: p })),
                ]}
                onChange={(next) => void setField('nativeProtocol', next === '' ? undefined : next)}
              />
            }
            note={
              <span className={styles['ratesLine']}>
                {localize(
                  'aiKnowledge.field.nativeProtocol.note',
                  'The protocol this model speaks on its own vendor endpoint. Anything else is a translation.',
                )}
              </span>
            }
          />

          <NumberRow
            field="maxInputTokens"
            label={localize('aiKnowledge.field.maxInputTokens', 'Max input tokens')}
            own={own.maxInputTokens}
            builtin={builtin?.maxInputTokens}
            saved={saved}
            disabled={disabled}
            onCommit={(value) => void setField('maxInputTokens', value)}
          />
          <NumberRow
            field="maxOutputTokens"
            label={localize('aiKnowledge.field.maxOutputTokens', 'Max output tokens')}
            own={own.maxOutputTokens}
            builtin={builtin?.maxOutputTokens}
            saved={saved}
            disabled={disabled}
            onCommit={(value) => void setField('maxOutputTokens', value)}
          />

          <CapabilitiesRow
            own={own.capabilities}
            effective={effective.capabilities}
            builtinDeclared={builtin?.capabilities !== undefined}
            saved={saved}
            disabled={disabled}
            onChange={(next) => void setField('capabilities', next)}
            onClear={() => void setField('capabilities', undefined)}
          />

          <ReasoningEffortRow
            own={own.supportsReasoningEffort}
            builtin={builtin?.supportsReasoningEffort}
            saved={saved}
            disabled={disabled}
            onCommit={(levels) => void setField('supportsReasoningEffort', levels)}
          />

          <SettingRow
            label={localize('aiKnowledge.field.parameters', 'Request parameters')}
            saved={saved}
            field="parameters"
            control={
              <div className={styles['apiKeyRow']}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => setParametersOpen(true)}
                >
                  {localize('aiKnowledge.field.parameters.edit', 'Edit parameter schema')}
                </Button>
                {own.parameters !== undefined && (
                  <IconButton
                    label={localize(
                      'aiKnowledge.field.parameters.clear',
                      'Clear the parameter schema',
                    )}
                    disabled={disabled}
                    onClick={() => void setField('parameters', undefined)}
                  >
                    <RotateCcw size={13} strokeWidth={1.75} />
                  </IconButton>
                )}
              </div>
            }
            note={
              <span className={styles['ratesLine']}>
                {parametersSummary(effective, own.parameters !== undefined)}
              </span>
            }
          />

          {parametersOpen && (
            <ParametersDialog
              schema={effective.parameters}
              onClose={() => setParametersOpen(false)}
              onSave={(schema) => {
                setParametersOpen(false)
                // An empty schema means "no tunable parameters", which is the same
                // as not declaring the field — patchField deletes it for us.
                void apply(
                  'parameters',
                  Object.keys(schema).length === 0
                    ? patchField<AiModelKnowledge, 'parameters'>('parameters', undefined)
                    : (entry) => ({ ...entry, parameters: schema }),
                )
              }}
            />
          )}
        </div>
      )}
    </section>
  )
}

function unsetProtocolLabel(builtin: AiWireProtocol | undefined): string {
  return builtin === undefined
    ? localize('aiKnowledge.field.nativeProtocol.unset', 'Unset')
    : localize('aiKnowledge.field.nativeProtocol.builtin', 'Unset (built-in: {protocol})', {
        protocol: builtin,
      })
}

function parametersSummary(effective: AiModelKnowledge, ownDeclared: boolean): string {
  const count = Object.keys(effective.parameters ?? {}).length
  if (count === 0) {
    return localize(
      'aiKnowledge.field.parameters.none',
      'No tunable parameters — the picker shows no configuration form for this model.',
    )
  }
  const line = localize('aiKnowledge.field.parameters.count', '{count} parameters', { count })
  return ownDeclared
    ? line
    : `${line} · ${localize('aiKnowledge.inherit.builtin', 'From built-in knowledge')}`
}

/**
 * The note under an inherited field. Two states worth distinguishing: the row is
 * showing a built-in value (clearing the box changes nothing) versus the row is
 * overriding one (clearing the box restores it).
 */
function BuiltinNote({
  builtin,
  overridden,
}: {
  readonly builtin: string | undefined
  readonly overridden: boolean
}) {
  if (builtin === undefined) return null
  return (
    <span className={styles['inheritNote']}>
      {overridden
        ? localize('aiKnowledge.inherit.overrides', 'Overrides built-in: {value}', {
            value: builtin,
          })
        : localize('aiKnowledge.inherit.from', 'Built-in: {value}', { value: builtin })}
    </span>
  )
}

function TextRow({
  field,
  label,
  own,
  builtin,
  saved,
  disabled,
  onCommit,
}: {
  readonly field: string
  readonly label: string
  readonly own: string | undefined
  readonly builtin: string | undefined
  readonly saved: SavedStamp | undefined
  readonly disabled: boolean
  readonly onCommit: (value: string) => void
}) {
  const edit = useEditableText(own, onCommit)
  return (
    <SettingRow
      label={label}
      saved={saved}
      field={field}
      control={
        <Input
          value={edit.value}
          disabled={disabled}
          placeholder={builtin ?? ''}
          aria-label={label}
          onChange={(e) => edit.onChange(e.target.value)}
          onFocus={edit.onFocus}
          onBlur={edit.onBlur}
          onKeyDown={edit.onKeyDown}
        />
      }
      note={<BuiltinNote builtin={builtin} overridden={own !== undefined} />}
    />
  )
}

function NumberRow({
  field,
  label,
  own,
  builtin,
  saved,
  disabled,
  onCommit,
}: {
  readonly field: string
  readonly label: string
  readonly own: number | undefined
  readonly builtin: number | undefined
  readonly saved: SavedStamp | undefined
  readonly disabled: boolean
  readonly onCommit: (value: number | undefined) => void
}) {
  const edit = useEditableNumber(own, onCommit)
  return (
    <SettingRow
      label={label}
      saved={saved}
      field={field}
      control={
        <Input
          value={edit.value}
          invalid={edit.invalid}
          disabled={disabled}
          inputMode="numeric"
          placeholder={builtin === undefined ? '' : String(builtin)}
          aria-label={label}
          onChange={(e) => edit.onChange(e.target.value)}
          onFocus={edit.onFocus}
          onBlur={edit.onBlur}
          onKeyDown={edit.onKeyDown}
        />
      }
      note={
        edit.invalid ? (
          <span className={styles['fieldError']}>
            {localize('aiKnowledge.field.number.invalid', 'Enter a whole number of tokens.')}
          </span>
        ) : (
          <BuiltinNote
            builtin={builtin === undefined ? undefined : String(builtin)}
            overridden={own !== undefined}
          />
        )
      }
    />
  )
}

const CAPABILITY_LABELS: Readonly<Record<AiCapabilityKey, () => string>> = {
  streaming: () => localize('aiKnowledge.capability.streaming', 'Streaming'),
  vision: () => localize('aiKnowledge.capability.vision', 'Vision'),
  promptCaching: () => localize('aiKnowledge.capability.promptCaching', 'Prompt caching'),
  toolCalling: () => localize('aiKnowledge.capability.toolCalling', 'Tool calling'),
}

/**
 * Every toggle writes the COMPLETE quad, never a single flag: an absent
 * `capabilities` falls back to `{ streaming: true }` in the registry, and
 * mergeModelKnowledge replaces nested objects wholesale — so a partial write
 * would silently drop the built-in entry's vision / caching flags. Removing the
 * override is therefore an explicit action, not a side effect of unticking.
 */
function CapabilitiesRow({
  own,
  effective,
  builtinDeclared,
  saved,
  disabled,
  onChange,
  onClear,
}: {
  readonly own: AiModelCapabilities | undefined
  readonly effective: AiModelCapabilities | undefined
  readonly builtinDeclared: boolean
  readonly saved: SavedStamp | undefined
  readonly disabled: boolean
  readonly onChange: (next: AiModelCapabilities) => void
  readonly onClear: () => void
}) {
  const shown = effective ?? { streaming: true }
  return (
    <SettingRow
      label={localize('aiKnowledge.field.capabilities', 'Capabilities')}
      saved={saved}
      field="capabilities"
      control={
        <div className={styles['capabilityRow']} data-testid="ai-knowledge-capabilities">
          {AI_CAPABILITY_KEYS.map((key) => (
            <Checkbox
              key={key}
              checked={shown[key] ?? false}
              disabled={disabled}
              label={CAPABILITY_LABELS[key]()}
              aria-label={CAPABILITY_LABELS[key]()}
              onChange={(checked) => onChange(toggledCapabilities(effective, key, checked))}
            />
          ))}
          {own !== undefined && (
            <IconButton
              label={localize(
                'aiKnowledge.field.capabilities.clear',
                'Clear the capability override',
              )}
              disabled={disabled}
              onClick={onClear}
            >
              <RotateCcw size={13} strokeWidth={1.75} />
            </IconButton>
          )}
        </div>
      }
      note={
        own === undefined ? (
          <span className={styles['ratesLine']}>
            {builtinDeclared
              ? localize('aiKnowledge.field.capabilities.builtin', 'From built-in knowledge.')
              : localize(
                  'aiKnowledge.field.capabilities.default',
                  'Not declared — streaming is assumed. Ticking any box records the full set.',
                )}
          </span>
        ) : null
      }
    />
  )
}

function ReasoningEffortRow({
  own,
  builtin,
  saved,
  disabled,
  onCommit,
}: {
  readonly own: readonly string[] | undefined
  readonly builtin: readonly string[] | undefined
  readonly saved: SavedStamp | undefined
  readonly disabled: boolean
  readonly onCommit: (levels: readonly string[] | undefined) => void
}) {
  const commit = useCallback(
    (text: string) => {
      const levels = parseReasoningEffort(text)
      onCommit(levels.length === 0 ? undefined : levels)
    },
    [onCommit],
  )
  const edit = useEditableText(formatReasoningEffort(own), commit)
  const label = localize('aiKnowledge.field.reasoningEffort', 'Reasoning effort levels')
  return (
    <SettingRow
      label={label}
      saved={saved}
      field="supportsReasoningEffort"
      control={
        <Input
          value={edit.value}
          disabled={disabled}
          placeholder={formatReasoningEffort(builtin) || 'low, medium, high'}
          aria-label={label}
          onChange={(e) => edit.onChange(e.target.value)}
          onFocus={edit.onFocus}
          onBlur={edit.onBlur}
          onKeyDown={edit.onKeyDown}
        />
      }
      note={
        <>
          <span className={styles['ratesLine']}>
            {localize(
              'aiKnowledge.field.reasoningEffort.note',
              'Comma-separated, in the order the model documents them. Empty means the model has no effort setting.',
            )}
          </span>
          <BuiltinNote
            builtin={builtin === undefined ? undefined : formatReasoningEffort(builtin)}
            overridden={own !== undefined}
          />
        </>
      }
    />
  )
}

/**
 * The parameter schema is a small nested JSON document (property → type / enum /
 * default / range), so it gets a raw editor rather than a control per field: a
 * form here would be a schema editor for a schema. Validation is strict about
 * the keys we understand and permissive about the rest.
 */
function ParametersDialog({
  schema,
  onClose,
  onSave,
}: {
  readonly schema: AiModelKnowledge['parameters']
  readonly onClose: () => void
  readonly onSave: (schema: NonNullable<AiModelKnowledge['parameters']>) => void
}) {
  const [text, setText] = useState(() =>
    schema === undefined ? '{}' : JSON.stringify(schema, null, 2),
  )
  const [error, setError] = useState<string | undefined>(undefined)

  const save = () => {
    const result = validateParametersSchema(text)
    if (!result.ok) {
      console.debug('aiKnowledge: parameter schema rejected', { error: result.error })
      setError(result.error)
      return
    }
    onSave(result.schema)
  }

  const title = localize('aiKnowledge.parameters.title', 'Request parameter schema')
  return (
    <FocusScopeOverlay visible onEscape={onClose}>
      <div className={styles['rawJsonOverlay']} role="dialog" aria-modal="true">
        <div className={styles['rawJsonDialog']}>
          <div className={styles['modelsHeader']}>
            <span className={styles['label']}>{title}</span>
          </div>
          <textarea
            className={styles['rawJsonEditor']}
            value={text}
            aria-label={title}
            data-testid="ai-knowledge-parameters-editor"
            onChange={(e) => setText(e.target.value)}
          />
          {error !== undefined && <span className={styles['rawJsonError']}>{error}</span>}
          <span className={styles['ratesLine']}>
            {localize(
              'aiKnowledge.parameters.hint',
              'One key per parameter, e.g. { "temperature": { "type": "number", "default": 1 } }. An empty object clears the schema.',
            )}
          </span>
          <div className={styles['modelsHeader']}>
            <span className={styles['spacer']} />
            <Button size="sm" onClick={save}>
              {localize('aiKnowledge.parameters.save', 'Save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {localize('aiKnowledge.parameters.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      </div>
    </FocusScopeOverlay>
  )
}
