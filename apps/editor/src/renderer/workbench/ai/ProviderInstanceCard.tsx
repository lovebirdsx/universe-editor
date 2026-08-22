/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProviderInstanceCard — one provider *instance* (a gateway entry: connection +
 *  credential). Header shows the type badge, the plaintext-apiKey badge and a
 *  connectivity status dot; the body has an editable baseUrl, a masked API key
 *  (show/hide + edit + clear), the authoritative account-usage block, a gateway
 *  price-table status line and the instance's models (declared models float to
 *  the top with a star, each with an optional per-model configuration form).
 *
 *  The connectivity dot only probes on an explicit "Test connection" click — it
 *  never fires network requests from render or polling. Account usage is a cache
 *  read (getAccountUsage) and is hidden entirely unless the instance/type
 *  declares a usageSource; when a source is declared but no authoritative value
 *  can be fetched it renders "Unavailable" rather than a local estimate.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  Server,
  Settings2,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import {
  bareModelName,
  localize,
  providerKey,
  StorageScope,
  type AiAccountUsage,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiProviderInstance,
  type AiProviderType,
  type AiRateTableSnapshot,
  type IAiModelService,
  type IStorageService,
} from '@universe-editor/platform'
import { Badge, Button, Checkbox, IconButton, Input, Spinner } from '@universe-editor/workbench-ui'
import styles from './AiSettingsEditor.module.css'

type ConnectState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

interface ProviderInstanceCardProps {
  readonly aiModel: IAiModelService
  readonly instance: AiProviderInstance
  readonly type: AiProviderType | undefined
  readonly models: readonly AiModelMetadata[]
  readonly rateTables: readonly AiRateTableSnapshot[]
  readonly reloadToken: number
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly storage: IStorageService
  readonly filterStorageKey: string
  readonly onBaseUrlChange: (baseUrl: string) => void
  readonly onSetApiKey: () => void
  readonly onClearApiKey: () => void
  readonly onRemove: () => void
  readonly onAddModel: () => void
  readonly onRemoveModel: (modelId: string) => void
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

export function ProviderInstanceCard({
  aiModel,
  instance,
  type,
  models,
  rateTables,
  reloadToken,
  collapsed,
  onToggleCollapsed,
  storage,
  filterStorageKey,
  onBaseUrlChange,
  onSetApiKey,
  onClearApiKey,
  onRemove,
  onAddModel,
  onRemoveModel,
  onConfigure,
  getConfiguration,
}: ProviderInstanceCardProps) {
  const key = providerKey(instance)
  const hasApiKey = instance.apiKey !== undefined && instance.apiKey !== ''
  const [baseUrl, setBaseUrl] = useState(instance.baseUrl ?? '')
  const [connect, setConnect] = useState<ConnectState>({ kind: 'idle' })
  const [filter, setFilter] = useState('')

  useEffect(() => setBaseUrl(instance.baseUrl ?? ''), [instance.baseUrl])

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

  const runVerify = useCallback(async () => {
    if (!type) return
    setConnect({ kind: 'checking' })
    const effectiveBaseUrl = instance.baseUrl ?? type.defaultBaseUrl
    const result = await aiModel.verifyProvider({
      type: instance.type,
      name: instance.name,
      protocol: type.protocol,
      ...(effectiveBaseUrl !== undefined ? { baseUrl: effectiveBaseUrl } : {}),
      ...(instance.apiKey !== undefined ? { apiKey: instance.apiKey } : {}),
    })
    console.debug('aiModels: verify', {
      provider: providerKey(instance),
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
  }, [aiModel, instance, type])

  const declaredIds = useMemo(
    () => new Set((instance.models ?? []).map((m) => m.id)),
    [instance.models],
  )

  const orderedModels = useMemo(() => {
    const isDeclared = (m: AiModelMetadata) =>
      declaredIds.has(bareModelName(m.id, instance.type, instance.name))
    const declared = models.filter(isDeclared)
    const rest = models.filter((m) => !isDeclared(m))
    return [...declared, ...rest]
  }, [models, declaredIds, instance.type, instance.name])

  const filteredModels = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return orderedModels
    return orderedModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.family?.toLowerCase().includes(q) ?? false),
    )
  }, [orderedModels, filter])

  const snapshot = rateTables.find((t) => t.providerKey === key)

  return (
    <section className={styles['card']} data-testid="ai-instance-card" data-provider-key={key}>
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
        <span className={styles['cardTitle']}>{instance.label ?? instance.name}</span>
        <div className={styles['cardBadges']}>
          <Badge tone="accent">{instance.type}</Badge>
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
          <div className={styles['cardToolbar']}>
            <Button
              size="sm"
              variant="ghost"
              busy={connect.kind === 'checking'}
              disabled={type === undefined}
              onClick={() => void runVerify()}
            >
              {localize('aiModels.instance.test', 'Test connection')}
            </Button>
          </div>

          <div className={styles['field']}>
            <label className={styles['label']}>{localize('aiModels.baseUrl', 'Base URL')}</label>
            <Input
              value={baseUrl}
              placeholder={
                type?.defaultBaseUrl ?? localize('aiModels.baseUrl.placeholder', 'Provider default')
              }
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => {
                if (baseUrl.trim() !== (instance.baseUrl ?? '')) onBaseUrlChange(baseUrl.trim())
              }}
            />
          </div>

          <ApiKeyField
            apiKey={instance.apiKey}
            onSetApiKey={onSetApiKey}
            onClearApiKey={onClearApiKey}
          />

          <AccountUsageBlock
            aiModel={aiModel}
            instance={instance}
            type={type}
            reloadToken={reloadToken}
          />

          <div className={styles['field']}>
            <span className={styles['label']}>
              {localize('aiModels.rates.title', 'Gateway price table')}
            </span>
            <span className={styles['ratesLine']}>
              {snapshot
                ? localize('aiModels.rates.line', '{count} models · updated {time}', {
                    count: Object.keys(snapshot.rates).length,
                    time: formatTime(snapshot.fetchedAt),
                  })
                : localize('aiModels.rates.none', 'No gateway price table fetched.')}
            </span>
          </div>

          <div className={styles['modelsHeader']}>
            <span className={styles['label']}>{localize('aiModels.models', 'Models')}</span>
            <IconButton label={localize('aiModels.addModel', 'Add model')} onClick={onAddModel}>
              <Plus size={15} strokeWidth={2} />
            </IconButton>
          </div>

          {models.length > 0 && (
            <Input
              className={styles['modelFilter']}
              value={filter}
              placeholder={localize('aiModels.filter.placeholder', 'Filter models…')}
              onChange={(e) => onFilterChange(e.target.value)}
            />
          )}

          {models.length === 0 ? (
            <div className={styles['noModels']}>
              {localize('aiModels.noModels', 'No models available (configure baseUrl / API key).')}
            </div>
          ) : filteredModels.length === 0 ? (
            <div className={styles['noModels']}>
              {localize('aiModels.noMatch', 'No models match the filter.')}
            </div>
          ) : (
            <ul className={styles['modelList']}>
              {filteredModels.map((model) => (
                <InstanceModelRow
                  key={model.id}
                  model={model}
                  declared={declaredIds.has(bareModelName(model.id, instance.type, instance.name))}
                  onRemove={() => onRemoveModel(model.id)}
                  onConfigure={onConfigure}
                  getConfiguration={getConfiguration}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
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

/** Mask a key: first 4 + last 4 with fixed dots; short keys hide entirely. */
function maskKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(8)
  return `${key.slice(0, 4)}••••••••••${key.slice(-4)}`
}

function AccountUsageBlock({
  aiModel,
  instance,
  type,
  reloadToken,
}: {
  readonly aiModel: IAiModelService
  readonly instance: AiProviderInstance
  readonly type: AiProviderType | undefined
  readonly reloadToken: number
}) {
  const key = providerKey(instance)
  const declaresUsage = (instance.usageSource ?? type?.usageSource) !== undefined
  const [usage, setUsage] = useState<AiAccountUsage | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setLoaded(false)
    const next = await aiModel.getAccountUsage(key)
    if (next === undefined) console.debug('aiModels: account usage unavailable', key)
    setUsage(next)
    setLoaded(true)
  }, [aiModel, key])

  useEffect(() => {
    if (!declaresUsage) return
    void load()
  }, [load, declaresUsage, reloadToken])

  if (!declaresUsage) return null

  const refresh = async () => {
    setRefreshing(true)
    try {
      await aiModel.refreshRemote(key)
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

interface InstanceModelRowProps {
  readonly model: AiModelMetadata
  readonly declared: boolean
  readonly onRemove: () => void
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

function InstanceModelRow({
  model,
  declared,
  onRemove,
  onConfigure,
  getConfiguration,
}: InstanceModelRowProps) {
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
        {declared && (
          <Star
            size={13}
            strokeWidth={2}
            className={styles['declaredIcon']}
            aria-label={localize('aiModels.declared', 'Custom model')}
          />
        )}
        <span className={styles['modelName']}>{model.name}</span>
        <span className={styles['modelFamily']}>{model.family}</span>
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
        {declared && (
          <IconButton label={localize('aiModels.removeModel', 'Remove model')} onClick={onRemove}>
            <Trash2 size={15} strokeWidth={1.75} />
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
