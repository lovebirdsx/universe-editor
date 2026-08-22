/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProviderTypeCard — one provider *type* in the "Provider Types" section. Shows
 *  the protocol / builtin-or-custom / model-count badges, an editable default
 *  baseUrl, and the shared model catalog. Each catalog row resolves its
 *  effective rate through resolveModelPricing (model → type → catalog; no
 *  gateway level here because a type is shared across instances) and edits the
 *  per-model `pricing` override, which is written back via updateProviderTypes.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Layers, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import {
  composeModelId,
  localize,
  type AiCurrency,
  type AiCustomModelConfig,
  type AiModelPricing,
  type AiPricingOrigin,
  type AiProviderType,
} from '@universe-editor/platform'
import { Badge, Button, IconButton, Input } from '@universe-editor/workbench-ui'
import { resolveModelPricing } from '../../../shared/ai/resolveModelPricing.js'
import styles from './AiSettingsEditor.module.css'

interface ProviderTypeCardProps {
  readonly typeId: string
  readonly type: AiProviderType
  readonly builtin: boolean
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly canRemove: boolean
  readonly onRemove: () => void
  readonly onBaseUrlChange: (baseUrl: string) => void
  readonly onModelPricingChange: (modelId: string, pricing: AiModelPricing | undefined) => void
  readonly onAddModel: () => void
  readonly onRemoveModel: (modelId: string) => void
  readonly onRefreshPrices: () => void
}

export function ProviderTypeCard({
  typeId,
  type,
  builtin,
  collapsed,
  onToggleCollapsed,
  canRemove,
  onRemove,
  onBaseUrlChange,
  onModelPricingChange,
  onAddModel,
  onRemoveModel,
  onRefreshPrices,
}: ProviderTypeCardProps) {
  const models = type.models ?? []
  const hasPricingSource = type.pricingSource !== undefined
  const [baseUrl, setBaseUrl] = useState(type.defaultBaseUrl ?? '')

  useEffect(() => setBaseUrl(type.defaultBaseUrl ?? ''), [type.defaultBaseUrl])

  return (
    <section className={styles['card']} data-testid="ai-type-card" data-type-id={typeId}>
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
        <Layers size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        <span className={styles['cardTitle']}>{type.label ?? typeId}</span>
        <div className={styles['cardBadges']}>
          <Badge tone="accent">{type.protocol}</Badge>
          <Badge>
            {builtin
              ? localize('aiModels.type.badge.builtin', 'Built-in')
              : localize('aiModels.type.badge.custom', 'Custom')}
          </Badge>
          <Badge>
            {localize('aiModels.badge.modelCount', '{count} models', { count: models.length })}
          </Badge>
        </div>
        <span className={styles['spacer']} />
        {canRemove && (
          <span
            className={styles['cardHeaderAction']}
            role="button"
            tabIndex={0}
            aria-label={localize('aiModels.type.remove.remove', 'Remove')}
            data-tooltip={localize('aiModels.type.remove.remove', 'Remove provider type')}
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onRemove()
              }
            }}
          >
            <Trash2 size={15} strokeWidth={1.75} />
          </span>
        )}
      </button>

      {!collapsed && (
        <div className={styles['cardBody']}>
          <div className={styles['cardToolbar']}>
            <span
              data-tooltip={
                hasPricingSource
                  ? undefined
                  : localize(
                      'aiModels.type.refreshPrices.noSource',
                      'This type has no price source configured.',
                    )
              }
            >
              <Button
                size="sm"
                variant="ghost"
                disabled={!hasPricingSource}
                onClick={onRefreshPrices}
              >
                <RefreshCw size={14} strokeWidth={1.75} className={styles['btnIcon']} />
                {localize('aiModels.type.refreshPrices', 'Refresh prices from gateway')}
              </Button>
            </span>
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.type.baseUrl', 'Default base URL')}
            </label>
            <Input
              value={baseUrl}
              placeholder={localize('aiModels.type.baseUrl.placeholder', 'No default')}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => {
                if (baseUrl.trim() !== (type.defaultBaseUrl ?? '')) onBaseUrlChange(baseUrl.trim())
              }}
            />
          </div>

          <div className={styles['field']}>
            <span className={styles['label']}>
              {localize('aiModels.type.requiresApiKey', 'Requires API key')}
            </span>
            <span className={styles['plainValue']}>
              {type.requiresApiKey
                ? localize('aiModels.yes', 'Yes')
                : localize('aiModels.no', 'No')}
            </span>
          </div>

          <div className={styles['modelsHeader']}>
            <span className={styles['label']}>
              {localize('aiModels.type.models', 'Model catalog')}
            </span>
            <IconButton label={localize('aiModels.addModel', 'Add model')} onClick={onAddModel}>
              <Plus size={15} strokeWidth={2} />
            </IconButton>
          </div>

          {models.length === 0 ? (
            <div className={styles['noModels']}>
              {localize('aiModels.type.noModels', 'No models declared for this type.')}
            </div>
          ) : (
            <ul className={styles['modelList']}>
              {models.map((model) => (
                <TypeModelRow
                  key={model.id}
                  typeId={typeId}
                  typePricing={type.pricing}
                  model={model}
                  onPricingChange={onModelPricingChange}
                  onRemove={() => onRemoveModel(model.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

interface TypeModelRowProps {
  readonly typeId: string
  readonly typePricing: AiModelPricing | undefined
  readonly model: AiCustomModelConfig
  readonly onPricingChange: (modelId: string, pricing: AiModelPricing | undefined) => void
  readonly onRemove: () => void
}

function TypeModelRow({
  typeId,
  typePricing,
  model,
  onPricingChange,
  onRemove,
}: TypeModelRowProps) {
  const [editing, setEditing] = useState(false)

  const resolved = useMemo(
    () =>
      resolveModelPricing({
        modelId: composeModelId(typeId, 'default', model.id),
        model,
        typePricing,
      }),
    [typeId, typePricing, model],
  )

  const origin = originBadge(resolved.origin)

  return (
    <li className={styles['modelRow']}>
      <div className={styles['modelMain']}>
        <span className={styles['modelName']}>{model.id}</span>
        {model.family && <span className={styles['modelFamily']}>{model.family}</span>}
        <span className={styles['spacer']} />
        <Badge tone={origin.tone}>{origin.text}</Badge>
        <IconButton
          label={
            editing
              ? localize('aiModels.pricing.cancel', 'Cancel')
              : resolved.pricing !== undefined
                ? localize('aiModels.pricing.edit', 'Edit rate')
                : localize('aiModels.pricing.fill', 'Fill in rate')
          }
          active={editing}
          onClick={() => setEditing((v) => !v)}
        >
          <Pencil size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton label={localize('aiModels.removeModel', 'Remove model')} onClick={onRemove}>
          <Trash2 size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
      {editing && (
        <PricingEditor
          initial={resolved.pricing}
          onSave={(pricing) => {
            onPricingChange(model.id, pricing)
            setEditing(false)
          }}
          onClear={() => {
            onPricingChange(model.id, undefined)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  )
}

function originBadge(origin: AiPricingOrigin | undefined): {
  text: string
  tone: 'default' | 'accent'
} {
  switch (origin) {
    case 'model':
      return { text: localize('aiModels.origin.model', 'Model'), tone: 'accent' }
    case 'gateway':
      return { text: localize('aiModels.origin.gateway', 'Gateway'), tone: 'accent' }
    case 'type':
      return { text: localize('aiModels.origin.type', 'Type'), tone: 'default' }
    case 'catalog':
      return { text: localize('aiModels.origin.catalog', 'Built-in catalog'), tone: 'default' }
    default:
      return { text: localize('aiModels.origin.unknown', 'Rate unknown'), tone: 'default' }
  }
}

interface PricingEditorProps {
  readonly initial: AiModelPricing | undefined
  readonly onSave: (pricing: AiModelPricing) => void
  readonly onClear: () => void
  readonly onCancel: () => void
}

function PricingEditor({ initial, onSave, onClear, onCancel }: PricingEditorProps) {
  const [input, setInput] = useState(initial ? String(initial.input) : '')
  const [output, setOutput] = useState(initial ? String(initial.output) : '')
  const [cacheRead, setCacheRead] = useState(
    initial?.cacheRead !== undefined ? String(initial.cacheRead) : '',
  )
  const [cacheWrite, setCacheWrite] = useState(
    initial?.cacheWrite !== undefined ? String(initial.cacheWrite) : '',
  )
  const [currency, setCurrency] = useState<AiCurrency>(initial?.currency ?? 'USD')

  const fields = {
    input: parseField(input),
    output: parseField(output),
    cacheRead: parseField(cacheRead),
    cacheWrite: parseField(cacheWrite),
  }
  const canSave =
    fields.input.value !== undefined &&
    fields.output.value !== undefined &&
    !fields.input.invalid &&
    !fields.output.invalid &&
    !fields.cacheRead.invalid &&
    !fields.cacheWrite.invalid

  const save = () => {
    if (!canSave) return
    onSave({
      currency,
      input: fields.input.value as number,
      output: fields.output.value as number,
      ...(fields.cacheRead.value !== undefined ? { cacheRead: fields.cacheRead.value } : {}),
      ...(fields.cacheWrite.value !== undefined ? { cacheWrite: fields.cacheWrite.value } : {}),
    })
  }

  return (
    <div className={styles['pricingEditor']}>
      <span className={styles['pricingHint']}>
        {localize('aiModels.pricing.perMillion', 'per 1M tokens')}
      </span>
      <div className={styles['pricingGrid']}>
        <label className={styles['pricingField']}>
          <span className={styles['label']}>{localize('aiModels.pricing.input', 'Input')}</span>
          <Input
            type="number"
            value={input}
            invalid={fields.input.invalid}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <label className={styles['pricingField']}>
          <span className={styles['label']}>{localize('aiModels.pricing.output', 'Output')}</span>
          <Input
            type="number"
            value={output}
            invalid={fields.output.invalid}
            onChange={(e) => setOutput(e.target.value)}
          />
        </label>
        <label className={styles['pricingField']}>
          <span className={styles['label']}>
            {localize('aiModels.pricing.cacheRead', 'Cache read')}
          </span>
          <Input
            type="number"
            value={cacheRead}
            invalid={fields.cacheRead.invalid}
            onChange={(e) => setCacheRead(e.target.value)}
          />
        </label>
        <label className={styles['pricingField']}>
          <span className={styles['label']}>
            {localize('aiModels.pricing.cacheWrite', 'Cache write')}
          </span>
          <Input
            type="number"
            value={cacheWrite}
            invalid={fields.cacheWrite.invalid}
            onChange={(e) => setCacheWrite(e.target.value)}
          />
        </label>
        <label className={styles['pricingField']}>
          <span className={styles['label']}>
            {localize('aiModels.pricing.currency', 'Currency')}
          </span>
          <select
            className={styles['control']}
            value={currency}
            aria-label={localize('aiModels.pricing.currency', 'Currency')}
            onChange={(e) => setCurrency(e.target.value as AiCurrency)}
          >
            <option value="USD">USD</option>
            <option value="CNY">CNY</option>
          </select>
        </label>
      </div>
      <div className={styles['configActions']}>
        <Button size="sm" disabled={!canSave} onClick={save}>
          {localize('aiModels.pricing.save', 'Save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear}>
          {localize('aiModels.pricing.clear', 'Clear')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {localize('aiModels.pricing.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

function parseField(s: string): { value: number | undefined; invalid: boolean } {
  const t = s.trim()
  if (t === '') return { value: undefined, invalid: false }
  const n = Number(t)
  return Number.isFinite(n) ? { value: n, invalid: false } : { value: undefined, invalid: true }
}
