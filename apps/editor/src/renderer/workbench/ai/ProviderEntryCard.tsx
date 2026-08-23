/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProviderEntryCard — one single-layer provider entry (a gateway endpoint:
 *  connection + credential + protocol map). Header shows the id, an `extends`
 *  badge when present, the plaintext-apiKey badge and any configuration issues;
 *  the body edits label / baseUrl / apiKey (masked) / defaultProtocol, shows the
 *  pricing source + gateway price-table status + authoritative account usage, and
 *  lists the models grouped per protocol. An empty protocol array is rendered as
 *  "discover from endpoint"; a provider without a pricing source shows "Rate
 *  unknown" on its models rather than a fabricated number.
 *
 *  The connectivity dot only probes on an explicit "Test connection" click — it
 *  never fires network requests from render or polling. Account usage is a cache
 *  read (getAccountUsage) and is hidden entirely unless the entry declares a
 *  usageSource; when a source is declared but no authoritative value can be
 *  fetched it renders "Unavailable" rather than a local estimate.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  RefreshCw,
  Server,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import {
  AI_WIRE_PROTOCOLS,
  localize,
  StorageScope,
  type AiAccountUsage,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiModelPricing,
  type AiProviderEntry,
  type AiProviderIssue,
  type AiRateTableSnapshot,
  type AiWireProtocol,
  type IAiModelService,
  type IStorageService,
} from '@universe-editor/platform'
import { Badge, Button, Checkbox, IconButton, Input, Spinner } from '@universe-editor/workbench-ui'
import { maskKey } from '../../../shared/ai/maskKey.js'
import styles from './AiSettingsEditor.module.css'

type ConnectState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

interface ProviderEntryCardProps {
  readonly aiModel: IAiModelService
  readonly provider: AiProviderEntry
  readonly models: readonly AiModelMetadata[]
  readonly issues: readonly AiProviderIssue[]
  readonly rateTables: readonly AiRateTableSnapshot[]
  readonly reloadToken: number
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly storage: IStorageService
  readonly filterStorageKey: string
  readonly onLabelChange: (label: string) => void
  readonly onBaseUrlChange: (baseUrl: string) => void
  readonly onDefaultProtocolChange: (protocol: AiWireProtocol | undefined) => void
  readonly onSetApiKey: () => void
  readonly onClearApiKey: () => void
  readonly onRemove: () => void
  readonly onRefreshPrices: () => void
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

export function ProviderEntryCard({
  aiModel,
  provider,
  models,
  issues,
  rateTables,
  reloadToken,
  collapsed,
  onToggleCollapsed,
  storage,
  filterStorageKey,
  onLabelChange,
  onBaseUrlChange,
  onDefaultProtocolChange,
  onSetApiKey,
  onClearApiKey,
  onRemove,
  onRefreshPrices,
  onConfigure,
  getConfiguration,
}: ProviderEntryCardProps) {
  const hasApiKey = provider.apiKey !== undefined && provider.apiKey !== ''
  const [label, setLabel] = useState(provider.label ?? '')
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')
  const [connect, setConnect] = useState<ConnectState>({ kind: 'idle' })
  const [filter, setFilter] = useState('')

  useEffect(() => setLabel(provider.label ?? ''), [provider.label])
  useEffect(() => setBaseUrl(provider.baseUrl ?? ''), [provider.baseUrl])

  useEffect(() => {
    let active = true
    void storage.get<string>(filterStorageKey, StorageScope.GLOBAL).then((stored) => {
      if (active && typeof stored === 'string') setFilter(stored)
    })
    return () => {
      active = false
    }
  }, [storage, filterStorageKey])

  const onFilterChange = useCallback(
    (value: string) => {
      setFilter(value)
      void storage.set(filterStorageKey, value, StorageScope.GLOBAL)
    },
    [storage, filterStorageKey],
  )

  const protocols = useMemo(
    () => (Object.keys(provider.protocolMap ?? {}) as AiWireProtocol[]).sort(),
    [provider.protocolMap],
  )
  const effectiveProtocol = provider.defaultProtocol ?? protocols[0]
  const hasPricingSource = provider.pricingSource !== undefined

  const runVerify = useCallback(async () => {
    if (effectiveProtocol === undefined) return
    setConnect({ kind: 'checking' })
    const result = await aiModel.verifyProvider({
      id: provider.id,
      protocol: effectiveProtocol,
      ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    })
    console.debug('aiModels: verify', {
      provider: provider.id,
      ok: result.ok,
      modelCount: result.modelCount,
    })
    setConnect(
      result.ok
        ? { kind: 'ok', modelCount: result.modelCount }
        : {
            kind: 'fail',
            error: result.error ?? localize('aiModels.instance.status.fail', 'Connection failed.'),
          },
    )
  }, [aiModel, provider.id, provider.baseUrl, provider.apiKey, effectiveProtocol])

  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.family?.toLowerCase().includes(q) ?? false),
    )
  }, [models, filter])

  const snapshot = rateTables.find((t) => t.providerId === provider.id)

  return (
    <section
      className={`${styles['card']}${issues.length > 0 ? ` ${styles['cardIssue']}` : ''}`}
      data-testid="ai-provider-entry-card"
      data-provider-id={provider.id}
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
        <Server size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        <span className={styles['cardTitle']}>{provider.label ?? provider.id}</span>
        <div className={styles['cardBadges']}>
          <Badge tone="accent">{provider.id}</Badge>
          {provider.extends !== undefined && (
            <Badge>
              {localize('aiModels.entry.extends', 'extends {id}', { id: provider.extends })}
            </Badge>
          )}
          {hasApiKey && (
            <Badge tone="accent">
              <KeyRound size={11} strokeWidth={2} className={styles['badgeIcon']} />
              {localize('aiModels.badge.keyed', 'Key set')}
            </Badge>
          )}
          <Badge>
            {localize('aiModels.badge.modelCount', '{count} models', { count: models.length })}
          </Badge>
        </div>
        <span className={styles['spacer']} />
        <ConnectivityDot state={connect} />
        <span
          className={styles['cardHeaderAction']}
          role="button"
          tabIndex={0}
          aria-label={localize('aiModels.instance.remove.remove', 'Remove')}
          data-tooltip={localize('aiModels.instance.remove.remove', 'Remove provider')}
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
      </button>

      {!collapsed && (
        <div className={styles['cardBody']}>
          {issues.length > 0 && (
            <div className={styles['cardToolbar']}>
              {issues.map((issue) => (
                <span
                  key={issue.reason}
                  className={styles['issueBadge']}
                  data-tooltip={issue.detail}
                >
                  {issueReasonLabel(issue.reason)}
                  {issue.detail ? ` (${issue.detail})` : ''}
                </span>
              ))}
            </div>
          )}

          <div className={styles['cardToolbar']}>
            <Button
              size="sm"
              variant="ghost"
              busy={connect.kind === 'checking'}
              disabled={effectiveProtocol === undefined}
              onClick={() => void runVerify()}
            >
              {localize('aiModels.instance.test', 'Test connection')}
            </Button>
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>{localize('aiModels.entry.label', 'Label')}</label>
            <Input
              value={label}
              placeholder={localize('aiModels.entry.labelPlaceholder', 'Display name')}
              onChange={(e) => setLabel(e.target.value)}
              onBlur={() => {
                if (label.trim() !== (provider.label ?? '')) onLabelChange(label.trim())
              }}
            />
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>{localize('aiModels.baseUrl', 'Base URL')}</label>
            <Input
              value={baseUrl}
              placeholder={localize('aiModels.baseUrl.placeholder', 'Provider default')}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => {
                if (baseUrl.trim() !== (provider.baseUrl ?? '')) onBaseUrlChange(baseUrl.trim())
              }}
            />
          </div>

          <ApiKeyField
            apiKey={provider.apiKey}
            onSetApiKey={onSetApiKey}
            onClearApiKey={onClearApiKey}
          />

          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('aiModels.entry.defaultProtocol', 'Default protocol')}
            </label>
            <select
              className={styles['control']}
              value={provider.defaultProtocol ?? ''}
              aria-label={localize('aiModels.entry.defaultProtocol', 'Default protocol')}
              onChange={(e) =>
                onDefaultProtocolChange(
                  e.target.value === '' ? undefined : (e.target.value as AiWireProtocol),
                )
              }
            >
              <option value="">
                {localize('aiModels.entry.defaultProtocol.first', 'First protocol')}
              </option>
              {AI_WIRE_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className={styles['field']}>
            <div className={styles['modelsHeader']}>
              <span className={styles['label']}>
                {localize('aiModels.pricingSource', 'Pricing source')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!hasPricingSource}
                onClick={onRefreshPrices}
              >
                <RefreshCw size={14} strokeWidth={1.75} className={styles['btnIcon']} />
                {localize('aiModels.refreshPrices', 'Refresh prices')}
              </Button>
            </div>
            <span className={styles['ratesLine']}>
              {hasPricingSource
                ? snapshot
                  ? localize('aiModels.rates.line', '{count} models · updated {time}', {
                      count: Object.keys(snapshot.rates).length,
                      time: formatTime(snapshot.fetchedAt),
                    })
                  : localize(
                      'aiModels.pricingSource.value',
                      '{source} · no price table fetched yet.',
                      {
                        source: provider.pricingSource.id,
                      },
                    )
                : localize(
                    'aiModels.pricingSource.none',
                    'No pricing source — rates are shown as unknown, not estimated.',
                  )}
            </span>
          </div>

          <AccountUsageBlock aiModel={aiModel} provider={provider} reloadToken={reloadToken} />

          {models.length > 0 && (
            <Input
              className={styles['modelFilter']}
              value={filter}
              placeholder={localize('aiModels.filter.placeholder', 'Filter models…')}
              onChange={(e) => onFilterChange(e.target.value)}
            />
          )}

          <ProtocolSections
            provider={provider}
            models={filteredModels}
            onConfigure={onConfigure}
            getConfiguration={getConfiguration}
          />
        </div>
      )}
    </section>
  )
}

function ProtocolSections({
  provider,
  models,
  onConfigure,
  getConfiguration,
}: {
  readonly provider: AiProviderEntry
  readonly models: readonly AiModelMetadata[]
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}) {
  const discover = useMemo(() => {
    const set = new Set<string>()
    for (const [protocol, refs] of Object.entries(provider.protocolMap ?? {})) {
      if (refs !== undefined && refs.length === 0) set.add(protocol)
    }
    return set
  }, [provider.protocolMap])

  const sections = useMemo(() => {
    const byProtocol = new Map<string, AiModelMetadata[]>()
    for (const m of models) {
      const list = byProtocol.get(m.protocol) ?? []
      list.push(m)
      byProtocol.set(m.protocol, list)
    }
    for (const protocol of Object.keys(provider.protocolMap ?? {})) {
      if (!byProtocol.has(protocol)) byProtocol.set(protocol, [])
    }
    return [...byProtocol.entries()]
      .map(([protocol, list]) => ({
        protocol: protocol as AiWireProtocol,
        discover: discover.has(protocol),
        models: list,
      }))
      .sort((a, b) => a.protocol.localeCompare(b.protocol))
  }, [models, provider.protocolMap, discover])

  if (sections.length === 0) {
    return (
      <div className={styles['noModels']}>
        {localize('aiModels.noModels', 'No models available (configure baseUrl / API key).')}
      </div>
    )
  }

  return (
    <div className={styles['modelList']}>
      {sections.map((section) => (
        <div key={section.protocol}>
          <div className={styles['protocolHeader']}>
            {section.protocol}
            {section.discover && (
              <span className={styles['discoverBadge']}>
                {localize('aiModels.entry.discover', 'discover from endpoint')}
              </span>
            )}
          </div>
          {section.models.length === 0 ? (
            <div className={styles['noModels']}>
              {localize('aiModels.entry.noModels', 'No models resolved for this protocol.')}
            </div>
          ) : (
            <ul className={styles['modelList']}>
              {section.models.map((model) => (
                <EntryModelRow
                  key={model.id}
                  model={model}
                  onConfigure={onConfigure}
                  getConfiguration={getConfiguration}
                />
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

export function issueReasonLabel(reason: AiProviderIssue['reason']): string {
  switch (reason) {
    case 'malformed-entry':
      return localize('aiModels.issue.malformedEntry', 'Malformed entry (no string id)')
    case 'invalid-id':
      return localize('aiModels.issue.invalidId', "Invalid id (empty, or contains '/')")
    case 'duplicate-id':
      return localize('aiModels.issue.duplicateId', 'Duplicate id')
    case 'unknown-extends':
      return localize('aiModels.issue.unknownExtends', 'Unknown extends target')
    case 'extends-cycle':
      return localize('aiModels.issue.extendsCycle', 'Extends cycle')
    case 'extends-depth':
      return localize('aiModels.issue.extendsDepth', 'Extends chain too deep')
    case 'no-protocol':
      return localize('aiModels.issue.noProtocol', 'No protocol declared')
    case 'unknown-default-protocol':
      return localize('aiModels.issue.unknownDefaultProtocol', 'Unknown default protocol')
  }
}

function ConnectivityDot({ state }: { readonly state: ConnectState }) {
  if (state.kind === 'checking') {
    return (
      <span
        className={styles['statusDotWrap']}
        data-tooltip={localize('aiModels.instance.status.checking', 'Checking…')}
      >
        <Spinner size={11} />
      </span>
    )
  }
  const info =
    state.kind === 'ok'
      ? {
          className: styles['statusOk'],
          tooltip: localize('aiModels.instance.status.ok', 'Connected · {count} models', {
            count: state.modelCount,
          }),
        }
      : state.kind === 'fail'
        ? { className: styles['statusFail'], tooltip: state.error }
        : {
            className: styles['statusIdle'],
            tooltip: localize('aiModels.instance.status.idle', 'Not tested'),
          }
  return (
    <span
      className={`${styles['statusDot'] ?? ''} ${info.className ?? ''}`}
      data-tooltip={info.tooltip}
      data-status={state.kind}
    />
  )
}

function ApiKeyField({
  apiKey,
  onSetApiKey,
  onClearApiKey,
}: {
  readonly apiKey: string | undefined
  readonly onSetApiKey: () => void
  readonly onClearApiKey: () => void
}) {
  const [revealed, setRevealed] = useState(false)
  const has = apiKey !== undefined && apiKey !== ''

  return (
    <div className={styles['field']}>
      <label className={styles['label']}>{localize('aiModels.apiKey', 'API Key')}</label>
      <div className={styles['apiKeyRow']}>
        <span className={styles['apiKeyStatus']}>
          {!has
            ? localize('aiModels.apiKey.unset', 'Not set')
            : revealed
              ? apiKey
              : maskKey(apiKey)}
        </span>
        <IconButton
          label={
            revealed
              ? localize('aiModels.apiKey.hide', 'Hide API key')
              : localize('aiModels.apiKey.show', 'Show API key')
          }
          disabled={!has}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? (
            <EyeOff size={15} strokeWidth={1.75} />
          ) : (
            <Eye size={15} strokeWidth={1.75} />
          )}
        </IconButton>
        <IconButton label={localize('aiModels.apiKey.edit', 'Edit API key')} onClick={onSetApiKey}>
          <Pencil size={15} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label={localize('aiModels.apiKey.clearBtn', 'Clear API key')}
          disabled={!has}
          onClick={onClearApiKey}
        >
          <X size={15} strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  )
}

function AccountUsageBlock({
  aiModel,
  provider,
  reloadToken,
}: {
  readonly aiModel: IAiModelService
  readonly provider: AiProviderEntry
  readonly reloadToken: number
}) {
  const declaresUsage = provider.usageSource !== undefined
  const [usage, setUsage] = useState<AiAccountUsage | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setLoaded(false)
    const next = await aiModel.getAccountUsage(provider.id)
    if (next === undefined) console.debug('aiModels: account usage unavailable', provider.id)
    setUsage(next)
    setLoaded(true)
  }, [aiModel, provider.id])

  useEffect(() => {
    if (!declaresUsage) return
    void load()
  }, [load, declaresUsage, reloadToken])

  if (!declaresUsage) return null

  const refresh = async () => {
    setRefreshing(true)
    try {
      await aiModel.refreshRemote(provider.id)
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className={styles['field']}>
      <div className={styles['modelsHeader']}>
        <span className={styles['label']}>{localize('aiModels.usage.title', 'Account usage')}</span>
        <Button size="sm" variant="ghost" busy={refreshing} onClick={() => void refresh()}>
          {localize('aiModels.usage.refresh', 'Refresh usage')}
        </Button>
      </div>
      {!loaded ? (
        <Spinner size={13} />
      ) : usage === undefined ? (
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
        <UsageSummary usage={usage} />
      )}
    </div>
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

function usageKindLabel(kind: AiAccountUsage['kind']): string {
  switch (kind) {
    case 'quota':
      return localize('aiModels.usage.kind.quota', 'Quota')
    case 'balance':
      return localize('aiModels.usage.kind.balance', 'Balance')
    case 'subscription':
      return localize('aiModels.usage.kind.subscription', 'Subscription')
  }
}

function formatCurrency(value: number, currency: string): string {
  return `${currency === 'CNY' ? '¥' : '$'}${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

interface EntryModelRowProps {
  readonly model: AiModelMetadata
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

function EntryModelRow({ model, onConfigure, getConfiguration }: EntryModelRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({})
  const hasSchema = model.configurationSchema && Object.keys(model.configurationSchema).length > 0

  const toggleConfigure = useCallback(async () => {
    if (!expanded) {
      const current = await getConfiguration(model.id)
      setDraft({ ...current })
    }
    setExpanded((v) => !v)
  }, [expanded, getConfiguration, model.id])

  return (
    <li className={styles['modelRow']}>
      <div className={styles['modelMain']}>
        <span className={styles['modelName']}>{model.name}</span>
        <span className={styles['modelFamily']}>{model.family}</span>
        <RateBadge model={model} />
        {model.protocol === 'openai-responses' && (
          <span className={styles['agentOnlyBadge']}>
            {localize('aiModels.entry.agentOnly', 'Agent-only')}
          </span>
        )}
        <span className={styles['spacer']} />
        {hasSchema && (
          <IconButton
            label={localize('aiModels.configure', 'Configure model')}
            active={expanded}
            onClick={() => void toggleConfigure()}
          >
            <Settings2 size={15} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>

      {expanded && model.configurationSchema && (
        <div className={styles['configForm']}>
          {Object.entries(model.configurationSchema).map(([key, prop]) => {
            const value = draft[key]
            let control: JSX.Element
            if (prop.type === 'enum' && prop.enum) {
              control = (
                <select
                  className={styles['control']}
                  value={String(value ?? '')}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                >
                  <option value="">{localize('aiModels.config.unset', '(default)')}</option>
                  {prop.enum.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              )
            } else if (prop.type === 'boolean') {
              control = (
                <Checkbox
                  checked={Boolean(value)}
                  onChange={(checked) => setDraft((d) => ({ ...d, [key]: checked }))}
                />
              )
            } else if (prop.type === 'number') {
              control = (
                <Input
                  type="number"
                  value={value === undefined ? '' : String(value)}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    setDraft((d) => ({ ...d, [key]: Number.isNaN(n) ? '' : n }))
                  }}
                />
              )
            } else {
              control = (
                <Input
                  value={value === undefined ? '' : String(value)}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                />
              )
            }
            return (
              <div key={key} className={styles['configRow']}>
                <div className={styles['configMeta']}>
                  <span className={styles['configKey']}>{key}</span>
                  {prop.description && (
                    <span className={styles['configDesc']}>{prop.description}</span>
                  )}
                </div>
                <div className={styles['configControl']}>{control}</div>
              </div>
            )
          })}
          <div className={styles['configActions']}>
            <Button
              size="sm"
              onClick={() => {
                const cleaned: Record<string, string | number | boolean> = {}
                for (const [k, v] of Object.entries(draft)) {
                  if (v !== '' && v !== undefined) cleaned[k] = v
                }
                void onConfigure(model.id, cleaned).then(() => setExpanded(false))
              }}
            >
              {localize('aiModels.config.save', 'Save')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
              {localize('aiModels.config.cancel', 'Cancel')}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

function RateBadge({ model }: { readonly model: AiModelMetadata }) {
  if (model.pricing !== undefined) {
    return <Badge tone="accent">{formatPricing(model.pricing)}</Badge>
  }
  return (
    <Badge
      data-tooltip={localize(
        'aiModels.rate.unknownTooltip',
        'No pricing source is configured for this provider (or this model is not in it).',
      )}
    >
      {localize('aiModels.rate.unknown', 'Rate unknown')}
    </Badge>
  )
}

function formatPricing(pricing: AiModelPricing): string {
  const symbol = pricing.currency === 'CNY' ? '¥' : '$'
  return `${symbol}${pricing.input} / ${symbol}${pricing.output}`
}
