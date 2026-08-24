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
 *  The connectivity dot probes on its own: on mount it restores the cached
 *  answer (5 minute TTL) and probes when missing or stale; editing a
 *  connection-relevant field re-probes after a debounce. Entries that cannot
 *  be tested (no effective protocol or base URL) stay at "not tested".
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
import { Badge, IconButton, Input, Select, Spinner } from '@universe-editor/workbench-ui'
import { effectiveProtocolMap } from '../../../shared/ai/providerInheritance.js'
import { declaredProtocols } from '../../../shared/ai/protocolMapEdit.js'
import { formatUsageBadge, formatUsageTooltip } from '../../../shared/ai/usageFormat.js'
import { CardSection } from './providerCard/CardSection.js'
import { ConnectionFields } from './providerCard/ConnectionFields.js'
import { ExtendsField } from './providerCard/ExtendsField.js'
import { IssuesSection } from './providerCard/IssuesSection.js'
import { ProtocolsSection } from './providerCard/ProtocolsSection.js'
import { RemoteSourceFields } from './providerCard/RemoteSourceFields.js'
import { SavedIndicator } from './providerCard/SavedIndicator.js'
import { SettingRow } from './providerCard/SettingRow.js'
import { useAutoVerify, type ConnectState } from './providerCard/useAutoVerify.js'
import { useProviderField, type ProviderPatch } from './providerCard/useProviderField.js'
import type { UsageState } from './providerCard/usageState.js'
import styles from './AiSettingsEditor.module.css'

export { issueReasonLabel } from './providerCard/IssuesSection.js'

interface ProviderEntryCardProps {
  readonly aiModel: IAiModelService
  readonly dialog: IDialogService
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  readonly models: readonly AiModelMetadata[]
  readonly issues: readonly AiProviderIssue[]
  readonly rateTables: readonly AiRateTableSnapshot[]
  readonly knowledge: Readonly<Record<string, AiModelKnowledge>>
  /** Account usage, already fetched by the panel so the badge survives collapse. */
  readonly usage: UsageState
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  /** True when the section is collapsed; keyed per provider by the panel. */
  readonly isSectionCollapsed: (section: CardSectionId, defaultCollapsed: boolean) => boolean
  readonly onToggleSection: (section: CardSectionId, defaultCollapsed: boolean) => void
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

export type CardSectionId = 'pricing' | 'usage' | 'protocols'

export function ProviderEntryCard({
  aiModel,
  dialog,
  provider,
  allProviders,
  models,
  issues,
  rateTables,
  knowledge,
  usage,
  collapsed,
  onToggleCollapsed,
  isSectionCollapsed,
  onToggleSection,
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
  const { connect } = useAutoVerify(aiModel, provider, allProviders, storage)
  const [filter, setFilter] = useState('')

  const hasApiKey = provider.apiKey !== undefined && provider.apiKey !== ''

  const protocolCount = useMemo(
    () => declaredProtocols(effectiveProtocolMap(provider, allProviders)).length,
    [provider, allProviders],
  )

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
        <span className={styles['cardTitle']}>{provider.id}</span>
        <div className={styles['cardBadges']}>
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
          <UsageBadge usage={usage} />
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

          <ConnectionFields
            provider={provider}
            allProviders={allProviders}
            saved={saved}
            onBaseUrlChange={(baseUrl) => void setField('baseUrl', baseUrl)}
            onSetApiKey={(key) => void onSetApiKey(key).then(() => stamp('apiKey'))}
            onClearApiKey={() => void onClearApiKey().then(() => stamp('apiKey'))}
          />

          <SettingRow
            label={localize('aiModels.entry.defaultProtocol', 'Default protocol')}
            saved={saved}
            field="defaultProtocol"
            control={
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
                onChange={(next) =>
                  void setField('defaultProtocol', next === '' ? undefined : next)
                }
              />
            }
          />

          <ExtendsField
            provider={provider}
            allProviders={allProviders}
            knowledge={knowledge}
            saved={saved}
            onChange={(parentId) => void setField('extends', parentId)}
          />

          <RemoteSourceFields
            provider={provider}
            allProviders={allProviders}
            rateTables={rateTables}
            usage={usage}
            saved={saved}
            pricingCollapsed={isSectionCollapsed('pricing', true)}
            usageCollapsed={isSectionCollapsed('usage', true)}
            onTogglePricing={() => onToggleSection('pricing', true)}
            onToggleUsage={() => onToggleSection('usage', true)}
            onPricingSourceChange={(spec) => void setField('pricingSource', spec)}
            onUsageSourceChange={(spec) => void setField('usageSource', spec)}
            onRefreshRemote={onRefreshRemote}
          />

          <CardSection
            testId="ai-protocols-card-section"
            title={localize('aiModels.protocols.title', 'Protocols & models')}
            summary={localize('aiModels.protocols.summary', '{count} protocols · {models} models', {
              count: protocolCount,
              models: models.length,
            })}
            collapsed={isSectionCollapsed('protocols', false)}
            onToggle={() => onToggleSection('protocols', false)}
            actions={<SavedIndicator saved={saved} field="protocolMap" />}
          >
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
              onChange={(map) => void setField('protocolMap', map)}
              onConfigure={onConfigure}
              getConfiguration={getConfiguration}
            />
          </CardSection>
        </div>
      )}
    </section>
  )
}

/**
 * The account-usage number in short form, next to the other header badges. It has
 * to distinguish "still fetching" from "fetched and the gateway reported nothing":
 * the second is a real answer and must not sit under a spinner forever.
 */
function UsageBadge({ usage }: { readonly usage: UsageState }) {
  if (usage.kind === 'none') return null
  if (usage.kind === 'loading') {
    return (
      <Badge>
        <Spinner size={11} />
      </Badge>
    )
  }
  if (usage.value === undefined) {
    return (
      <Badge>
        <span data-tooltip={localize('aiModels.usage.unavailable', 'Unavailable')}>
          {localize('aiModels.usage.unavailable', 'Unavailable')}
        </span>
      </Badge>
    )
  }
  return (
    <Badge tone="accent">
      <span data-tooltip={formatUsageTooltip(usage.value)}>{formatUsageBadge(usage.value)}</span>
    </Badge>
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
        data-status="checking"
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
