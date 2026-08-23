/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProviderEntryCard — the shell for one provider entry (one gateway endpoint:
 *  connection + credential + protocol map). The header carries identity and
 *  status; the body is a sequence of sections, each owning one part of the entry:
 *  inheritance, connection, protocols & models, remote sources, issues.
 *
 *  Every section follows the same contract — edits commit immediately through
 *  `updateEntry` and report back with a "Saved" flag next to the field that was
 *  written. There is no card-level dirty state and no Save button, because a
 *  provider entry is a bag of independent settings, not a form.
 *
 *  The connectivity dot never probes on its own: it shows the last explicit
 *  "Test connection" result, cached for a few minutes so switching categories
 *  does not throw the answer away, and falls back to "not tested" rather than
 *  implying a stale success is current.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Copy, KeyRound, Server, Trash2, X } from 'lucide-react'
import {
  AI_WIRE_PROTOCOLS,
  StorageScope,
  localize,
  type AiModelConfiguration,
  type AiModelKnowledge,
  type AiModelMetadata,
  type AiProviderEntry,
  type AiProviderIssue,
  type AiRateTableSnapshot,
  type AiWireProtocol,
  type IAiModelService,
  type IDialogService,
  type IStorageService,
} from '@universe-editor/platform'
import { Badge, Button, IconButton, Input, Select, Spinner } from '@universe-editor/workbench-ui'
import { declaredProtocols } from '../../../shared/ai/protocolMapEdit.js'
import { effectiveConnection, findInherited } from '../../../shared/ai/providerInheritance.js'
import { ConnectionFields } from './providerCard/ConnectionFields.js'
import { ExtendsField } from './providerCard/ExtendsField.js'
import { IssuesSection } from './providerCard/IssuesSection.js'
import { ProtocolsSection } from './providerCard/ProtocolsSection.js'
import { RemoteSourceFields } from './providerCard/RemoteSourceFields.js'
import { SavedIndicator } from './providerCard/SavedIndicator.js'
import { useProviderField, type ProviderPatch } from './providerCard/useProviderField.js'
import styles from './AiSettingsEditor.module.css'

export { issueReasonLabel } from './providerCard/IssuesSection.js'

/** How long a "Test connection" answer is still worth showing. */
const CONNECTIVITY_TTL_MS = 5 * 60 * 1000
const connectivityKey = (id: string): string => `ai.settings.connectivity.${id}`

interface StoredConnectivity {
  readonly ok: boolean
  readonly modelCount: number
  readonly error?: string
  readonly at: number
}

type ConnectState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly modelCount: number }
  | { readonly kind: 'fail'; readonly error: string }

interface ProviderEntryCardProps {
  readonly aiModel: IAiModelService
  readonly dialog: IDialogService
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  readonly models: readonly AiModelMetadata[]
  readonly issues: readonly AiProviderIssue[]
  readonly rateTables: readonly AiRateTableSnapshot[]
  readonly knowledge: Readonly<Record<string, AiModelKnowledge>>
  readonly reloadToken: number
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly storage: IStorageService
  readonly filterStorageKey: string
  readonly updateEntry: (build: ProviderPatch) => Promise<void>
  readonly onSetApiKey: (key: string) => Promise<void>
  readonly onClearApiKey: () => Promise<void>
  readonly onRemove: () => void
  readonly onDuplicate: () => void
  readonly onRefreshRemote: () => Promise<void>
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

export function ProviderEntryCard({
  aiModel,
  dialog,
  provider,
  allProviders,
  models,
  issues,
  rateTables,
  knowledge,
  reloadToken,
  collapsed,
  onToggleCollapsed,
  storage,
  filterStorageKey,
  updateEntry,
  onSetApiKey,
  onClearApiKey,
  onRemove,
  onDuplicate,
  onRefreshRemote,
  onConfigure,
  getConfiguration,
}: ProviderEntryCardProps) {
  const { setField, stamp, saved } = useProviderField(updateEntry)
  const [connect, setConnect] = useState<ConnectState>({ kind: 'idle' })
  const [filter, setFilter] = useState('')

  const hasApiKey = provider.apiKey !== undefined && provider.apiKey !== ''
  const inheritedMap = findInherited(provider, allProviders, 'protocolMap')
  const effectiveMap = provider.protocolMap ?? inheritedMap?.value
  const protocols = useMemo(() => declaredProtocols(effectiveMap), [effectiveMap])
  const effectiveProtocol = provider.defaultProtocol ?? protocols[0]

  useEffect(() => {
    let active = true
    void storage.get<string>(filterStorageKey, StorageScope.GLOBAL).then((stored) => {
      if (active && typeof stored === 'string') setFilter(stored)
    })
    return () => {
      active = false
    }
  }, [storage, filterStorageKey])

  useEffect(() => {
    let active = true
    void storage
      .get<StoredConnectivity>(connectivityKey(provider.id), StorageScope.GLOBAL)
      .then((stored) => {
        if (!active || !stored || Date.now() - stored.at > CONNECTIVITY_TTL_MS) return
        setConnect(
          stored.ok
            ? { kind: 'ok', modelCount: stored.modelCount }
            : { kind: 'fail', error: stored.error ?? '' },
        )
      })
    return () => {
      active = false
    }
  }, [storage, provider.id])

  const onFilterChange = useCallback(
    (value: string) => {
      setFilter(value)
      void storage.set(filterStorageKey, value, StorageScope.GLOBAL)
    },
    [storage, filterStorageKey],
  )

  const runVerify = useCallback(async () => {
    if (effectiveProtocol === undefined) return
    setConnect({ kind: 'checking' })
    // Dial what the resolver would dial, not just what this entry declares: a
    // purely inheriting entry keeps its address and key on an ancestor.
    const connection = effectiveConnection(provider, allProviders)
    const result = await aiModel.verifyProvider({
      id: provider.id,
      protocol: effectiveProtocol,
      ...connection,
    })
    console.debug('aiModels: verify', {
      provider: provider.id,
      ok: result.ok,
      modelCount: result.modelCount,
    })
    const error = result.error ?? localize('aiModels.instance.status.fail', 'Connection failed.')
    setConnect(result.ok ? { kind: 'ok', modelCount: result.modelCount } : { kind: 'fail', error })
    const stored: StoredConnectivity = {
      ok: result.ok,
      modelCount: result.modelCount,
      ...(result.ok ? {} : { error }),
      at: Date.now(),
    }
    void storage.set(connectivityKey(provider.id), stored, StorageScope.GLOBAL)
  }, [aiModel, provider, allProviders, effectiveProtocol, storage])

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
        <HeaderAction
          label={localize('aiModels.entry.duplicate', 'Duplicate provider')}
          onTrigger={onDuplicate}
        >
          <Copy size={15} strokeWidth={1.75} />
        </HeaderAction>
        <HeaderAction
          label={localize('aiModels.instance.remove.remove', 'Remove provider')}
          onTrigger={onRemove}
        >
          <Trash2 size={15} strokeWidth={1.75} />
        </HeaderAction>
      </button>

      {!collapsed && (
        <div className={styles['cardBody']}>
          <IssuesSection
            issues={issues}
            onClearExtends={() => void setField('extends', undefined)}
          />

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

          <ConnectionFields
            provider={provider}
            allProviders={allProviders}
            saved={saved}
            onLabelChange={(label) => void setField('label', label)}
            onBaseUrlChange={(baseUrl) => void setField('baseUrl', baseUrl)}
            onSetApiKey={(key) => void onSetApiKey(key).then(() => stamp('apiKey'))}
            onClearApiKey={() => void onClearApiKey().then(() => stamp('apiKey'))}
          />

          <div className={styles['field']}>
            <div className={styles['fieldHeader']}>
              <label className={styles['label']}>
                {localize('aiModels.entry.defaultProtocol', 'Default protocol')}
              </label>
              <SavedIndicator saved={saved} field="defaultProtocol" />
            </div>
            <Select<AiWireProtocol | ''>
              value={provider.defaultProtocol ?? ''}
              aria-label={localize('aiModels.entry.defaultProtocol', 'Default protocol')}
              data-testid="ai-default-protocol"
              options={[
                {
                  value: '',
                  label: localize('aiModels.entry.defaultProtocol.first', 'First protocol'),
                },
                ...AI_WIRE_PROTOCOLS.map((p) => ({ value: p, label: p })),
              ]}
              onChange={(next) => void setField('defaultProtocol', next === '' ? undefined : next)}
            />
          </div>

          <ExtendsField
            provider={provider}
            allProviders={allProviders}
            knowledge={knowledge}
            saved={saved}
            onChange={(parentId) => void setField('extends', parentId)}
          />

          <RemoteSourceFields
            aiModel={aiModel}
            provider={provider}
            allProviders={allProviders}
            rateTables={rateTables}
            reloadToken={reloadToken}
            saved={saved}
            onPricingSourceChange={(spec) => void setField('pricingSource', spec)}
            onUsageSourceChange={(spec) => void setField('usageSource', spec)}
            onRefreshRemote={onRefreshRemote}
          />

          <div className={styles['filterRow']}>
            <Input
              className={styles['modelFilter']}
              value={filter}
              placeholder={localize('aiModels.filter.placeholder', 'Filter models…')}
              aria-label={localize('aiModels.filter.placeholder', 'Filter models…')}
              onChange={(e) => onFilterChange(e.target.value)}
            />
            {filter !== '' && (
              <IconButton
                label={localize('aiModels.filter.clear', 'Clear model filter')}
                onClick={() => onFilterChange('')}
              >
                <X size={14} strokeWidth={1.75} />
              </IconButton>
            )}
          </div>

          <ProtocolsSection
            aiModel={aiModel}
            dialog={dialog}
            provider={provider}
            allProviders={allProviders}
            models={models}
            knowledge={knowledge}
            filter={filter}
            saved={saved}
            onChange={(map) => void setField('protocolMap', map)}
            onConfigure={onConfigure}
            getConfiguration={getConfiguration}
          />
        </div>
      )}
    </section>
  )
}

/**
 * A clickable affordance inside the header button. It cannot be a <button>:
 * the header itself is one, and nesting them is invalid HTML that React will
 * render but the browser will re-parent.
 */
function HeaderAction({
  label,
  onTrigger,
  children,
}: {
  readonly label: string
  readonly onTrigger: () => void
  readonly children: ReactNode
}) {
  return (
    <span
      className={styles['cardHeaderAction']}
      role="button"
      tabIndex={0}
      aria-label={label}
      data-tooltip={label}
      onClick={(e) => {
        e.stopPropagation()
        onTrigger()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          onTrigger()
        }
      }}
    >
      {children}
    </span>
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
