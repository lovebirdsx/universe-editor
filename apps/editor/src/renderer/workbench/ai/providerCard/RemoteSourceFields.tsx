/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteSourceFields — the editable surface for a provider entry's two remote
 *  sources: where its price table comes from (`pricingSource`) and where its
 *  authoritative account usage comes from (`usageSource`). Both are optional;
 *  an absent source is a deliberate "unknown / not shown", never a guess.
 *
 *  Two source kinds exist today: `catalog` (pricing only — a synchronous lookup
 *  into the built-in official rate lists, keyed by vendor) and `http-json`
 *  (pricing and usage — a bounded fetch against the gateway's own JSON
 *  endpoint). The structured form below covers the common options; anything
 *  more exotic (custom headers, nested field maps) stays reachable through the
 *  raw-JSON editor so the form does not grow a control per corner case.
 *
 *  Both sections collapse, because these are settings you fill in once and then
 *  only read: collapsed, the summary line is what tells you how the source is
 *  configured. What the sections render follows the *effective* source — the
 *  entry's own or an ancestor's — since main flattens `extends` before it fetches
 *  and caches under this entry's own id. What they *write* is always the entry's
 *  own field, so opening an inherited form and changing one option materializes
 *  the whole spec locally rather than editing the ancestor.
 *
 *  Every edit commits on blur / selection and writes through the parent's
 *  callbacks — this component holds no persistence and reads no service; account
 *  usage arrives as already-fetched props, because the header badge shows it even
 *  while the card body is collapsed and unmounted.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import {
  localize,
  type AiAccountUsage,
  type AiProviderEntry,
  type AiRateTableSnapshot,
  type AiRemoteSourceSpec,
} from '@universe-editor/platform'
import {
  Badge,
  Button,
  FocusScopeOverlay,
  Input,
  Select,
  Spinner,
  Toggle,
} from '@universe-editor/workbench-ui'
import { OFFICIAL_CATALOGS } from '../../../../shared/ai/catalog/modelKnowledge.js'
import { effectiveRemoteSource, findInherited } from '../../../../shared/ai/providerInheritance.js'
import { formatCurrency, formatTime, usageKindLabel } from '../../../../shared/ai/usageFormat.js'
import { CardSection } from './CardSection.js'
import { InheritanceNote } from './ConnectionFields.js'
import { SavedIndicator } from './SavedIndicator.js'
import { SettingRow } from './SettingRow.js'
import type { UsageState } from './usageState.js'
import type { SavedStamp } from './useProviderField.js'
import styles from '../AiSettingsEditor.module.css'

type SourceKind = 'pricing' | 'usage'

export interface RemoteSourceFieldsProps {
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  readonly rateTables: readonly AiRateTableSnapshot[]
  readonly usage: UsageState
  readonly saved: SavedStamp | undefined
  readonly pricingCollapsed: boolean
  readonly usageCollapsed: boolean
  readonly onTogglePricing: () => void
  readonly onToggleUsage: () => void
  readonly onPricingSourceChange: (spec: AiRemoteSourceSpec | undefined) => void
  readonly onUsageSourceChange: (spec: AiRemoteSourceSpec | undefined) => void
  readonly onRefreshRemote: () => Promise<void>
}

export function RemoteSourceFields({
  provider,
  allProviders,
  rateTables,
  usage,
  saved,
  pricingCollapsed,
  usageCollapsed,
  onTogglePricing,
  onToggleUsage,
  onPricingSourceChange,
  onUsageSourceChange,
  onRefreshRemote,
}: RemoteSourceFieldsProps): JSX.Element {
  return (
    <>
      <PricingSourceSection
        provider={provider}
        allProviders={allProviders}
        rateTables={rateTables}
        saved={saved}
        collapsed={pricingCollapsed}
        onToggle={onTogglePricing}
        onChange={onPricingSourceChange}
        onRefresh={onRefreshRemote}
      />
      <UsageSourceSection
        provider={provider}
        allProviders={allProviders}
        usage={usage}
        saved={saved}
        collapsed={usageCollapsed}
        onToggle={onToggleUsage}
        onChange={onUsageSourceChange}
        onRefresh={onRefreshRemote}
      />
    </>
  )
}

/**
 * The empty option means "store nothing of my own", which is not the same as
 * having no source: if any ancestor declares one, clearing falls back to it. So
 * the label follows whether that ancestor *exists*, not whether we are currently
 * inheriting — otherwise an entry that overrides its parent offers "None", and
 * picking it visibly restores the parent's value instead.
 */
function noneOptionLabel(fallbackFrom: string | undefined): string {
  return fallbackFrom === undefined
    ? localize('aiModels.source.none.option', 'None')
    : localize('aiModels.source.inheritOption', 'Inherit from {id}', { id: fallbackFrom })
}

/** Shared trailing note: whether this section's value is local or borrowed. */
function sourceInheritanceNote(
  effective: { readonly from: string; readonly inherited: boolean } | undefined,
  own: boolean,
  onRevert: () => void,
): ReactNode {
  const inheritedFrom = effective?.inherited === true ? effective.from : undefined
  return <InheritanceNote own={own} inheritedFrom={inheritedFrom} onRevert={onRevert} />
}

/* ------------------------------------------------------------------ pricing */

function PricingSourceSection({
  provider,
  allProviders,
  rateTables,
  saved,
  collapsed,
  onToggle,
  onChange,
  onRefresh,
}: {
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  readonly rateTables: readonly AiRateTableSnapshot[]
  readonly saved: SavedStamp | undefined
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly onChange: (spec: AiRemoteSourceSpec | undefined) => void
  readonly onRefresh: () => Promise<void>
}) {
  const effective = useMemo(
    () => effectiveRemoteSource(provider, allProviders, 'pricingSource'),
    [provider, allProviders],
  )
  const ancestor = useMemo(
    () => findInherited(provider, allProviders, 'pricingSource')?.from,
    [provider, allProviders],
  )
  const spec = effective?.value
  const snapshot = rateTables.find((t) => t.providerId === provider.id)
  const [refreshing, setRefreshing] = useState(false)

  const onSourceIdChange = useCallback(
    (id: string) => {
      console.debug('aiModels: pricing source change', { provider: provider.id, id })
      if (id === '') {
        onChange(undefined)
      } else if (id === 'catalog') {
        const vendor = Object.keys(OFFICIAL_CATALOGS)[0] ?? ''
        onChange({ id: 'catalog', options: { vendor } })
      } else {
        onChange({ id: 'http-json' })
      }
    },
    [onChange, provider.id],
  )

  const refresh = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  const ratesLine =
    spec !== undefined
      ? snapshot
        ? localize('aiModels.rates.line', '{count} models · updated {time}', {
            count: Object.keys(snapshot.rates).length,
            time: formatTime(snapshot.fetchedAt),
          })
        : localize('aiModels.pricingSource.value', '{source} · no price table fetched yet.', {
            source: spec.id,
          })
      : localize(
          'aiModels.pricingSource.none',
          'No pricing source — rates are shown as unknown, not estimated.',
        )

  return (
    <CardSection
      testId="ai-pricing-source"
      title={localize('aiModels.pricingSource.title', 'Pricing source')}
      summary={pricingSummary(
        spec,
        snapshot,
        effective?.inherited === true ? effective.from : undefined,
      )}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <>
          <SavedIndicator saved={saved} field="pricingSource" />
          <Button
            size="sm"
            variant="ghost"
            busy={refreshing}
            disabled={spec === undefined}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} strokeWidth={1.75} className={styles['btnIcon'] ?? ''} />
            {localize('aiModels.pricingSource.refresh', 'Refresh prices')}
          </Button>
        </>
      }
    >
      <SettingRow
        label={localize('aiModels.pricingSource.title', 'Pricing source')}
        control={
          <Select
            value={spec?.id ?? ''}
            aria-label={localize('aiModels.pricingSource.title', 'Pricing source')}
            options={[
              {
                value: '',
                label: noneOptionLabel(ancestor),
              },
              {
                value: 'catalog',
                label: localize('aiModels.pricingSource.catalog', 'Catalog (built-in)'),
              },
              {
                value: 'http-json',
                label: localize('aiModels.pricingSource.httpJson', 'HTTP JSON'),
              },
            ]}
            onChange={onSourceIdChange}
          />
        }
        note={
          <>
            <span className={styles['ratesLine']}>{ratesLine}</span>
            {sourceInheritanceNote(effective, provider.pricingSource !== undefined, () =>
              onChange(undefined),
            )}
          </>
        }
      />
      {spec?.id === 'catalog' && <CatalogVendorField spec={spec} onChange={onChange} />}
      {spec?.id === 'http-json' && (
        <HttpJsonOptionsForm kind="pricing" spec={spec} onChange={onChange} />
      )}
    </CardSection>
  )
}

function pricingSummary(
  spec: AiRemoteSourceSpec | undefined,
  snapshot: AiRateTableSnapshot | undefined,
  inheritedFrom: string | undefined,
): string {
  if (spec === undefined) return localize('aiModels.source.summary.none', 'None')
  const parts: string[] = []
  if (spec.id === 'catalog') {
    const vendor = readOptionString(spec.options ?? {}, 'vendor')
    parts.push(
      localize('aiModels.pricingSource.summary.catalog', 'Catalog · {vendor}', {
        vendor: vendor === '' ? '—' : vendor,
      }),
    )
  } else if (spec.id === 'http-json') {
    const path = readOptionString(spec.options ?? {}, 'path')
    parts.push(
      localize('aiModels.pricingSource.summary.httpJson', 'HTTP JSON · {path}', {
        path: path === '' ? '—' : path,
      }),
    )
    const currency = readOptionString(spec.options ?? {}, 'currency')
    if (currency !== '') parts.push(currency)
  } else {
    // A hand-edited file can name a source no registry knows. Echo the id rather
    // than assuming the last kind we happen to check for.
    parts.push(spec.id)
  }
  if (snapshot !== undefined) {
    parts.push(
      localize('aiModels.source.summary.rates', '{count} models', {
        count: Object.keys(snapshot.rates).length,
      }),
    )
  }
  if (inheritedFrom !== undefined) {
    parts.push(localize('aiModels.inherit.from', 'Inherited from {id}', { id: inheritedFrom }))
  }
  return parts.join(' · ')
}

function CatalogVendorField({
  spec,
  onChange,
}: {
  readonly spec: AiRemoteSourceSpec
  readonly onChange: (spec: AiRemoteSourceSpec) => void
}) {
  const vendors = useMemo(() => Object.keys(OFFICIAL_CATALOGS), [])
  const rawVendor = spec.options?.['vendor']
  const vendor = typeof rawVendor === 'string' && rawVendor !== '' ? rawVendor : (vendors[0] ?? '')

  return (
    <SettingRow
      label={localize('aiModels.pricingSource.catalog.vendor', 'Vendor')}
      control={
        <Select
          value={vendor}
          aria-label={localize('aiModels.pricingSource.catalog.vendor', 'Vendor')}
          options={vendors.map((v) => ({ value: v, label: v }))}
          onChange={(next) => onChange({ id: 'catalog', options: { vendor: next } })}
        />
      }
      note={
        <span className={styles['ratesLine']}>
          {localize(
            'aiModels.pricingSource.catalog.note',
            'Rates are looked up by the wire model name, so a renamed channel model will not match the official catalog.',
          )}
        </span>
      }
    />
  )
}

/* -------------------------------------------------------------------- usage */

function UsageSourceSection({
  provider,
  allProviders,
  usage,
  saved,
  collapsed,
  onToggle,
  onChange,
  onRefresh,
}: {
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  readonly usage: UsageState
  readonly saved: SavedStamp | undefined
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly onChange: (spec: AiRemoteSourceSpec | undefined) => void
  readonly onRefresh: () => Promise<void>
}) {
  const effective = useMemo(
    () => effectiveRemoteSource(provider, allProviders, 'usageSource'),
    [provider, allProviders],
  )
  const ancestor = useMemo(
    () => findInherited(provider, allProviders, 'usageSource')?.from,
    [provider, allProviders],
  )
  const spec = effective?.value
  const [refreshing, setRefreshing] = useState(false)

  const onSourceIdChange = useCallback(
    (id: string) => {
      console.debug('aiModels: usage source change', { provider: provider.id, id })
      if (id === '') onChange(undefined)
      else onChange({ id: 'http-json' })
    },
    [onChange, provider.id],
  )

  const refresh = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <CardSection
      testId="ai-usage-source"
      title={localize('aiModels.usageSource.title', 'Account usage source')}
      summary={usageSummary(spec, effective?.inherited === true ? effective.from : undefined)}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <>
          <SavedIndicator saved={saved} field="usageSource" />
          <Button
            size="sm"
            variant="ghost"
            busy={refreshing}
            disabled={spec === undefined}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} strokeWidth={1.75} className={styles['btnIcon'] ?? ''} />
            {localize('aiModels.usage.refresh', 'Refresh usage')}
          </Button>
        </>
      }
    >
      <SettingRow
        label={localize('aiModels.usageSource.title', 'Account usage source')}
        control={
          <Select
            value={spec?.id ?? ''}
            aria-label={localize('aiModels.usageSource.title', 'Account usage source')}
            options={[
              {
                value: '',
                label: noneOptionLabel(ancestor),
              },
              { value: 'http-json', label: localize('aiModels.usageSource.httpJson', 'HTTP JSON') },
            ]}
            onChange={onSourceIdChange}
          />
        }
        note={sourceInheritanceNote(effective, provider.usageSource !== undefined, () =>
          onChange(undefined),
        )}
      />
      {spec?.id === 'http-json' && (
        <HttpJsonOptionsForm kind="usage" spec={spec} onChange={onChange} />
      )}
      {spec !== undefined && <AccountUsageBlock usage={usage} />}
    </CardSection>
  )
}

function usageSummary(
  spec: AiRemoteSourceSpec | undefined,
  inheritedFrom: string | undefined,
): string {
  if (spec === undefined) return localize('aiModels.source.summary.none', 'None')
  const parts: string[] = []
  if (spec.id === 'http-json') {
    const path = readOptionString(spec.options ?? {}, 'path')
    parts.push(
      localize('aiModels.usageSource.summary.httpJson', 'HTTP JSON · {path}', {
        path: path === '' ? '—' : path,
      }),
    )
  } else {
    parts.push(spec.id)
  }
  const kind = readOptionString(spec.options ?? {}, 'kind')
  if (isUsageKind(kind)) parts.push(usageKindLabel(kind))
  if (inheritedFrom !== undefined) {
    parts.push(localize('aiModels.inherit.from', 'Inherited from {id}', { id: inheritedFrom }))
  }
  return parts.join(' · ')
}

function isUsageKind(value: string): value is AiAccountUsage['kind'] {
  return value === 'quota' || value === 'balance' || value === 'subscription'
}

/**
 * The detail view of a number the header already shows in short form. Purely
 * presentational: the fetch lives in the panel so the badge survives a collapsed
 * card.
 */
function AccountUsageBlock({ usage }: { readonly usage: UsageState }) {
  return (
    <SettingRow
      label={localize('aiModels.usage.title', 'Account usage')}
      control={
        usage.kind === 'loading' || usage.kind === 'none' ? (
          <Spinner size={13} />
        ) : usage.value === undefined ? (
          <span
            className={styles['usageUnavailable']}
            data-tooltip={localize(
              'aiModels.usage.unavailableTooltip',
              'A usage source is configured but no authoritative value could be fetched; no local estimate is shown in its place.',
            )}
          >
            {localize('aiModels.usage.unavailable', 'Unavailable')}
          </span>
        ) : (
          <UsageSummary usage={usage.value} />
        )
      }
    />
  )
}

function UsageSummary({ usage }: { readonly usage: AiAccountUsage }) {
  const currency = usage.currency ?? 'USD'
  const stats: { label: string; value: number }[] = []
  if (usage.usedUSD !== undefined) {
    stats.push({ label: localize('aiModels.usage.used', 'Used'), value: usage.usedUSD })
  }
  if (usage.limitUSD !== undefined) {
    stats.push({ label: localize('aiModels.usage.limit', 'Limit'), value: usage.limitUSD })
  }
  if (usage.remainingUSD !== undefined) {
    stats.push({
      label: localize('aiModels.usage.remaining', 'Remaining'),
      value: usage.remainingUSD,
    })
  }
  return (
    <div className={styles['usageBlock']}>
      <Badge>{usageKindLabel(usage.kind)}</Badge>
      {stats.map((s) => (
        <span key={s.label} className={styles['usageStat']}>
          <span className={styles['usageStatLabel']}>{s.label}</span>
          <span className={styles['usageStatValue']}>{formatCurrency(s.value, currency)}</span>
        </span>
      ))}
      {(usage.windows ?? []).map((w) => (
        <span key={w.id} className={styles['usageStat']}>
          <span className={styles['usageStatLabel']}>{w.label}</span>
          <span className={styles['usageStatValue']}>{Math.round(w.usedPercent)}%</span>
        </span>
      ))}
      <span className={styles['usageFetchedAt']}>
        {localize('aiModels.usage.fetchedAt', 'Fetched {time}', {
          time: formatTime(usage.fetchedAt),
        })}
      </span>
    </div>
  )
}

/* ------------------------------------------------------- http-json options */

const PRICING_RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
const USAGE_FIELDS = ['used', 'limit', 'remaining'] as const

function HttpJsonOptionsForm({
  kind,
  spec,
  onChange,
}: {
  readonly kind: SourceKind
  readonly spec: AiRemoteSourceSpec
  readonly onChange: (spec: AiRemoteSourceSpec) => void
}) {
  const options = useMemo(() => spec.options ?? {}, [spec.options])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)

  const commit = useCallback(
    (patch: Readonly<Record<string, unknown>>) => {
      const next: Record<string, unknown> = { ...options }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === '') delete next[key]
        else next[key] = value
      }
      const cleaned =
        Object.keys(next).length > 0 ? { id: spec.id, options: next } : { id: spec.id }
      onChange(cleaned)
    },
    [onChange, options, spec.id],
  )

  const pathPlaceholder =
    kind === 'pricing'
      ? localize('aiModels.httpJson.path.placeholder.pricing', '/v1/pricing')
      : localize('aiModels.httpJson.path.placeholder.usage', '/api/user/self')

  const fieldKeys = kind === 'pricing' ? PRICING_RATE_FIELDS : USAGE_FIELDS

  return (
    <div className={styles['httpJsonForm']}>
      <OptionTextField
        label={localize('aiModels.httpJson.path', 'Path')}
        value={readOptionString(options, 'path')}
        placeholder={pathPlaceholder}
        onCommit={(v) => commit({ path: v })}
      />
      <div className={styles['configRow']}>
        <div className={styles['configMeta']}>
          <span className={styles['configKey']}>
            {localize('aiModels.httpJson.auth', 'Send API key')}
          </span>
          <span className={styles['configDesc']}>
            {localize(
              'aiModels.httpJson.auth.desc',
              'Attach the provider API key as an auth header (default on).',
            )}
          </span>
        </div>
        <div className={styles['configControl']}>
          <Toggle
            checked={options['auth'] !== false}
            aria-label={localize('aiModels.httpJson.auth', 'Send API key')}
            onChange={(checked) => commit({ auth: checked })}
          />
        </div>
      </div>
      <OptionSelectField
        label={localize('aiModels.httpJson.currency', 'Currency')}
        value={readOptionString(options, 'currency') ?? 'USD'}
        options={[
          { value: 'USD', label: 'USD' },
          { value: 'CNY', label: 'CNY' },
        ]}
        onCommit={(v) => commit({ currency: v })}
      />
      {kind === 'usage' && (
        <OptionSelectField
          label={localize('aiModels.httpJson.kind', 'Usage kind')}
          value={readOptionString(options, 'kind') ?? 'quota'}
          options={[
            { value: 'quota', label: localize('aiModels.usage.kind.quota', 'Quota') },
            { value: 'balance', label: localize('aiModels.usage.kind.balance', 'Balance') },
            {
              value: 'subscription',
              label: localize('aiModels.usage.kind.subscription', 'Subscription'),
            },
          ]}
          onCommit={(v) => commit({ kind: v })}
        />
      )}

      <button
        type="button"
        className={styles['protocolHeader']}
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((v) => !v)}
      >
        {advancedOpen ? (
          <ChevronDown size={14} strokeWidth={1.75} className={styles['btnIcon'] ?? ''} />
        ) : (
          <ChevronRight size={14} strokeWidth={1.75} className={styles['btnIcon'] ?? ''} />
        )}
        {localize('aiModels.httpJson.advanced', 'Advanced')}
      </button>
      {advancedOpen && (
        <div className={styles['httpJsonAdvanced']}>
          <OptionTextField
            label={localize('aiModels.httpJson.authHeader', 'Auth header name')}
            value={readOptionString(options, 'authHeader')}
            placeholder="Authorization"
            onCommit={(v) => commit({ authHeader: v })}
          />
          <OptionTextField
            label={localize('aiModels.httpJson.itemsPath', 'Items path')}
            value={readOptionString(options, 'itemsPath')}
            placeholder={localize('aiModels.httpJson.itemsPath.placeholder', 'data')}
            onCommit={(v) => commit({ itemsPath: v })}
          />
          {kind === 'pricing' && (
            <OptionTextField
              label={localize('aiModels.httpJson.modelField', 'Model id field')}
              value={readOptionString(options, 'modelField')}
              placeholder="id"
              onCommit={(v) => commit({ modelField: v })}
            />
          )}
          <OptionNumberField
            label={localize('aiModels.httpJson.unit', 'Unit')}
            value={readOptionNumber(options, 'unit')}
            placeholder={kind === 'pricing' ? '1000000' : '1'}
            onCommit={(v) => commit({ unit: v })}
          />
          {fieldKeys.map((fieldKey) => (
            <OptionTextField
              key={fieldKey}
              label={localize('aiModels.httpJson.field', 'Field: {name}', { name: fieldKey })}
              value={readFieldPath(options, fieldKey)}
              placeholder={fieldKey}
              onCommit={(v) => commitField(options, fieldKey, v, commit)}
            />
          ))}
          <span className={styles['ratesLine']}>
            {localize(
              'aiModels.httpJson.headers.note',
              'Custom headers can be edited via "Edit raw JSON".',
            )}
          </span>
        </div>
      )}

      <div className={styles['configRow']}>
        <Button size="sm" variant="ghost" onClick={() => setRawOpen(true)}>
          {localize('aiModels.httpJson.editRaw', 'Edit raw JSON')}
        </Button>
      </div>
      <RawJsonEditor
        visible={rawOpen}
        options={options}
        onClose={() => setRawOpen(false)}
        onSave={(parsed) => {
          console.debug('aiModels: raw JSON saved', { id: spec.id, keys: Object.keys(parsed) })
          onChange(
            Object.keys(parsed).length > 0 ? { id: spec.id, options: parsed } : { id: spec.id },
          )
          setRawOpen(false)
        }}
      />
    </div>
  )
}

function commitField(
  options: Readonly<Record<string, unknown>>,
  fieldKey: string,
  value: string | undefined,
  commit: (patch: Readonly<Record<string, unknown>>) => void,
): void {
  const rawFields = options['fields']
  const current: Record<string, unknown> =
    rawFields !== null && typeof rawFields === 'object' && !Array.isArray(rawFields)
      ? { ...(rawFields as Record<string, unknown>) }
      : {}
  if (value === undefined || value === '') delete current[fieldKey]
  else current[fieldKey] = value
  commit({ fields: Object.keys(current).length > 0 ? current : undefined })
}

function readOptionString(options: Readonly<Record<string, unknown>>, key: string): string {
  const v = options[key]
  return typeof v === 'string' ? v : ''
}

function readOptionNumber(options: Readonly<Record<string, unknown>>, key: string): string {
  const v = options[key]
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
}

function readFieldPath(options: Readonly<Record<string, unknown>>, fieldKey: string): string {
  const rawFields = options['fields']
  if (rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields)) return ''
  const v = (rawFields as Record<string, unknown>)[fieldKey]
  return typeof v === 'string' ? v : ''
}

function OptionTextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  readonly label: string
  readonly value: string
  readonly placeholder?: string
  readonly onCommit: (value: string | undefined) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <SettingRow
      label={label}
      control={
        <Input
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const trimmed = draft.trim()
            if (trimmed !== value) onCommit(trimmed === '' ? undefined : trimmed)
          }}
        />
      }
    />
  )
}

function OptionNumberField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  readonly label: string
  readonly value: string
  readonly placeholder?: string
  readonly onCommit: (value: number | undefined) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <SettingRow
      label={label}
      control={
        <Input
          type="number"
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const trimmed = draft.trim()
            if (trimmed === value) return
            if (trimmed === '') {
              onCommit(undefined)
              return
            }
            const n = Number(trimmed)
            if (!Number.isFinite(n) || n <= 0) {
              setDraft(value)
              return
            }
            onCommit(n)
          }}
        />
      }
    />
  )
}

function OptionSelectField<T extends string>({
  label,
  value,
  options,
  onCommit,
}: {
  readonly label: string
  readonly value: T
  readonly options: readonly { value: T; label: string }[]
  readonly onCommit: (value: T) => void
}) {
  return (
    <SettingRow
      label={label}
      control={<Select value={value} options={options} aria-label={label} onChange={onCommit} />}
    />
  )
}

function RawJsonEditor({
  visible,
  options,
  onClose,
  onSave,
}: {
  readonly visible: boolean
  readonly options: Readonly<Record<string, unknown>>
  readonly onClose: () => void
  readonly onSave: (parsed: Record<string, unknown>) => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (visible) {
      setText(JSON.stringify(options, null, 2))
      setError(undefined)
    }
  }, [visible, options])

  const save = () => {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError(localize('aiModels.httpJson.raw.errorShape', 'JSON must be an object.'))
        return
      }
      onSave(parsed as Record<string, unknown>)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.debug('aiModels: raw JSON parse failed', { error: message })
      setError(message)
    }
  }

  return (
    <FocusScopeOverlay visible={visible} onEscape={onClose}>
      <div className={styles['rawJsonOverlay']} role="dialog" aria-modal="true">
        <div className={styles['rawJsonDialog']}>
          <div className={styles['modelsHeader']}>
            <span className={styles['label']}>
              {localize('aiModels.httpJson.raw.title', 'Edit raw JSON')}
            </span>
          </div>
          <textarea
            className={styles['rawJsonEditor']}
            value={text}
            aria-label={localize('aiModels.httpJson.raw.title', 'Edit raw JSON')}
            onChange={(e) => setText(e.target.value)}
          />
          {error !== undefined && <span className={styles['rawJsonError']}>{error}</span>}
          <div className={styles['modelsHeader']}>
            <span className={styles['spacer']} />
            <Button size="sm" onClick={save}>
              {localize('aiModels.httpJson.raw.save', 'Save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {localize('aiModels.httpJson.raw.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      </div>
    </FocusScopeOverlay>
  )
}
