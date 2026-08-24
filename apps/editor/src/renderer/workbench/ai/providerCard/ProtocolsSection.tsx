/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProtocolsSection — the editable view of `protocolMap`, the field that decides
 *  what a provider actually serves. One block per declared protocol, each in one
 *  of the two useful states: "discover from endpoint" (`[]`) or an explicit list.
 *  Undeclared protocols are not blocks at all — they live in the "Add protocol"
 *  picker, which is what an absent key means.
 *
 *  The declared list and the resolved models are shown as *one* list, not two.
 *  A separate read-only "here is what resolved" table would leave the user to
 *  guess how a line in the file relates to a row in the UI; instead each declared
 *  ref carries the metadata it resolved to (name, family, rate), and rows that
 *  resolved to nothing simply show the bare wire name — the normal state for a
 *  model the knowledge base has never heard of.
 *
 *  `protocolMap` is replaced wholesale by `extends`, never merged, so the first
 *  edit on an inheriting entry writes the whole effective map down locally. That
 *  is the same thing the resolver would have computed, made explicit.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useMemo, useState, type JSX, type ReactNode } from 'react'
import { Pencil, Pin, Plus, Search, Settings2, Trash2, X } from 'lucide-react'
import {
  AI_WIRE_PROTOCOLS,
  composeModelId,
  localize,
  type AiModelConfiguration,
  type AiModelKnowledge,
  type AiModelMetadata,
  type AiModelPricing,
  type AiProtocolMap,
  type AiProtocolModelRef,
  type AiProviderEntry,
  type AiWireProtocol,
  type IAiModelService,
  type IDialogService,
} from '@universe-editor/platform'
import { Badge, Button, Checkbox, IconButton, Input, Select } from '@universe-editor/workbench-ui'
import {
  appendModelNames,
  declaredProtocols,
  mergeProbedSelection,
  refKnowledgeKey,
  refWireName,
  removeProtocol,
  setProtocolRefs,
} from '../../../../shared/ai/protocolMapEdit.js'
import { effectiveConnection, findInherited } from '../../../../shared/ai/providerInheritance.js'
import { InheritanceNote } from './ConnectionFields.js'
import { ModelRefEditor } from './ModelRefEditor.js'
import { ProbeModelsDialog } from './ProbeModelsDialog.js'
import { SavedIndicator } from './SavedIndicator.js'
import type { SavedStamp } from './useProviderField.js'
import styles from '../AiSettingsEditor.module.css'

type ProtocolMode = 'discover' | 'static'

interface ProtocolsSectionProps {
  readonly aiModel: IAiModelService
  readonly dialog: IDialogService
  readonly provider: AiProviderEntry
  readonly allProviders: readonly AiProviderEntry[]
  /** Every resolved model of this provider, unfiltered. */
  readonly models: readonly AiModelMetadata[]
  readonly knowledge: Readonly<Record<string, AiModelKnowledge>>
  readonly filter: string
  readonly saved: SavedStamp | undefined
  readonly onChange: (map: AiProtocolMap | undefined) => void
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

export function ProtocolsSection({
  aiModel,
  dialog,
  provider,
  allProviders,
  models,
  knowledge,
  filter,
  saved,
  onChange,
  onConfigure,
  getConfiguration,
}: ProtocolsSectionProps) {
  const inherited = useMemo(
    () => findInherited(provider, allProviders, 'protocolMap'),
    [provider, allProviders],
  )
  // Stable identity matters: every commit callback closes over this, and the
  // `?? {}` fallback would otherwise mint a new object on each render.
  const effective: AiProtocolMap = useMemo(
    () => provider.protocolMap ?? inherited?.value ?? {},
    [provider.protocolMap, inherited],
  )
  const declared = useMemo(() => declaredProtocols(effective), [effective])
  const [probing, setProbing] = useState<AiWireProtocol | undefined>(undefined)
  const [adding, setAdding] = useState<AiWireProtocol | undefined>(undefined)
  const [addDraft, setAddDraft] = useState('')
  const [editing, setEditing] = useState<string | undefined>(undefined)

  const modelsByProtocol = useMemo(() => {
    const map = new Map<string, AiModelMetadata[]>()
    for (const model of models) {
      const list = map.get(model.protocol) ?? []
      list.push(model)
      map.set(model.protocol, list)
    }
    return map
  }, [models])

  const commit = useCallback(
    (next: AiProtocolMap) => {
      // An empty map on an inheriting entry is a meaningful override ("speak
      // nothing, whatever the parent says"); on a root entry it is just noise.
      const empty = Object.keys(next).length === 0
      onChange(empty && provider.extends === undefined ? undefined : next)
    },
    [onChange, provider.extends],
  )

  const setRefs = useCallback(
    (protocol: AiWireProtocol, refs: readonly AiProtocolModelRef[]) => {
      console.debug('aiModels: protocol refs', {
        provider: provider.id,
        protocol,
        count: refs.length,
      })
      commit(setProtocolRefs(effective, protocol, refs))
    },
    [commit, effective, provider.id],
  )

  const addProtocol = useCallback(
    (protocol: AiWireProtocol) => {
      commit(setProtocolRefs(effective, protocol, []))
    },
    [commit, effective],
  )

  const dropProtocol = useCallback(
    async (protocol: AiWireProtocol) => {
      if (declared.length === 1) {
        const { confirmed } = await dialog.confirm({
          message: localize(
            'aiModels.protocol.removeLastConfirm',
            'Remove the last protocol from {name}? The provider will serve no models until another protocol is added.',
            { name: provider.id },
          ),
          primaryButton: localize('aiModels.protocol.remove', 'Remove'),
          type: 'warning',
        })
        if (!confirmed) return
      }
      commit(removeProtocol(effective, protocol))
    },
    [commit, declared.length, dialog, effective, provider.id],
  )

  const setMode = useCallback(
    (protocol: AiWireProtocol, mode: ProtocolMode) => {
      if (mode === 'discover') {
        setRefs(protocol, [])
        return
      }
      // Switching to a static list with nothing to put in it is the exact moment
      // the endpoint should be asked, so the probe opens instead of an empty box.
      const current = effective[protocol] ?? []
      if (current.length === 0) setProbing(protocol)
    },
    [effective, setRefs],
  )

  const pinDiscovered = useCallback(
    (protocol: AiWireProtocol) => {
      const names = (modelsByProtocol.get(protocol) ?? []).map((m) => m.channelModel)
      if (names.length === 0) return
      setRefs(protocol, names)
    },
    [modelsByProtocol, setRefs],
  )

  const undeclared = AI_WIRE_PROTOCOLS.filter((p) => !declared.includes(p))
  const query = filter.trim().toLowerCase()

  const connection = useMemo(
    () => effectiveConnection(provider, allProviders),
    [provider, allProviders],
  )
  // The probe dialog re-runs its request whenever this changes, so it may not be
  // rebuilt on every render — only when the declared list for that protocol does.
  const probeDeclared = useMemo(
    () => (probing === undefined ? [] : (effective[probing] ?? []).map(refWireName)),
    [effective, probing],
  )

  /**
   * Offered in both modes on purpose. Typing a name while in discover mode is the
   * only way to reach a static list without a reachable endpoint — an offline or
   * key-less gateway would otherwise have no path out of "ask every launch".
   */
  const addModelControl = (protocol: AiWireProtocol, refs: readonly AiProtocolModelRef[]) =>
    adding === protocol ? (
      <Input
        autoFocus
        className={styles['modelFilter']}
        value={addDraft}
        placeholder={localize('aiModels.protocol.addModel.placeholder', 'Wire model name…')}
        aria-label={localize('aiModels.protocol.addModel', 'Add model')}
        onChange={(e) => setAddDraft(e.target.value)}
        onBlur={() => {
          setAdding(undefined)
          setAddDraft('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const next = appendModelNames(refs, [addDraft])
            setAddDraft('')
            if (next !== refs) setRefs(protocol, next)
          } else if (e.key === 'Escape') {
            setAddDraft('')
            e.currentTarget.blur()
          }
        }}
      />
    ) : (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setAddDraft('')
          setAdding(protocol)
        }}
      >
        <Plus size={14} strokeWidth={2} className={styles['btnIcon'] ?? ''} />
        {localize('aiModels.protocol.addModel', 'Add model')}
      </Button>
    )

  return (
    <div className={styles['field']} data-testid="ai-protocols-section">
      <div className={styles['fieldHeader']}>
        <label className={styles['label']}>
          {localize('aiModels.protocols.title', 'Protocols & models')}
        </label>
        <SavedIndicator saved={saved} field="protocolMap" />
      </div>
      <InheritanceNote
        own={provider.protocolMap !== undefined}
        inheritedFrom={inherited?.from}
        onRevert={() => onChange(undefined)}
      />

      {declared.length === 0 ? (
        <div className={styles['noModels']}>
          {localize(
            'aiModels.protocols.empty',
            'No protocol declared — this provider serves no models. Add one below.',
          )}
        </div>
      ) : (
        declared.map((protocol) => {
          const refs = effective[protocol] ?? []
          const mode: ProtocolMode = refs.length === 0 ? 'discover' : 'static'
          const resolved = modelsByProtocol.get(protocol) ?? []
          return (
            <div
              key={protocol}
              className={styles['protocolBlock']}
              data-testid={`ai-protocol-${protocol}`}
            >
              <div className={styles['protocolHeaderRow']}>
                <span className={styles['protocolName']}>{protocol}</span>
                {protocol === 'openai-responses' && (
                  <span className={styles['agentOnlyBadge']}>
                    {localize('aiModels.entry.agentOnly', 'Agent-only')}
                  </span>
                )}
                <span className={styles['spacer']} />
                <Select
                  className={styles['protocolMode'] ?? ''}
                  value={mode}
                  aria-label={localize('aiModels.protocol.mode', 'Model list mode')}
                  data-testid={`ai-protocol-mode-${protocol}`}
                  options={[
                    {
                      value: 'discover',
                      label: localize('aiModels.protocol.discover', 'Discover from endpoint'),
                    },
                    {
                      value: 'static',
                      label: localize('aiModels.protocol.static', 'Static list'),
                    },
                  ]}
                  onChange={(next) => setMode(protocol, next as ProtocolMode)}
                />
                <IconButton
                  label={localize('aiModels.protocol.removeLabel', 'Remove protocol {protocol}', {
                    protocol,
                  })}
                  onClick={() => void dropProtocol(protocol)}
                >
                  <Trash2 size={14} strokeWidth={1.75} />
                </IconButton>
              </div>

              {mode === 'discover' ? (
                <>
                  <div className={styles['protocolHint']}>
                    {localize(
                      'aiModels.protocol.discover.hint',
                      'The endpoint is asked for its model list every launch. Pin it to keep working offline and to review changes.',
                    )}
                  </div>
                  <ModelList>
                    {resolved
                      .filter((m) => matches(m.channelModel, m.name, m.family, query))
                      .map((model) => (
                        <ModelRow
                          key={model.id}
                          wireName={model.channelModel}
                          model={model}
                          onConfigure={onConfigure}
                          getConfiguration={getConfiguration}
                        />
                      ))}
                  </ModelList>
                  {resolved.length === 0 && (
                    <div className={styles['noModels']}>
                      {localize('aiModels.entry.noModels', 'No models resolved for this protocol.')}
                    </div>
                  )}
                  <div className={styles['protocolActions']}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resolved.length === 0}
                      onClick={() => pinDiscovered(protocol)}
                    >
                      <Pin size={14} strokeWidth={1.75} className={styles['btnIcon'] ?? ''} />
                      {localize('aiModels.protocol.pin', 'Pin {count} models to a static list', {
                        count: resolved.length,
                      })}
                    </Button>
                    {addModelControl(protocol, refs)}
                  </div>
                </>
              ) : (
                <>
                  <ModelList>
                    {refs.map((ref, index) => {
                      const wire = refWireName(ref)
                      const key = refKnowledgeKey(ref)
                      const model = models.find(
                        (m) => m.id === composeModelId(provider.id, protocol, wire),
                      )
                      const rowId = `${protocol}#${index}`
                      if (!matches(wire, model?.name, model?.family, query)) return null
                      if (editing === rowId) {
                        return (
                          <li key={rowId} className={styles['modelRow']}>
                            <ModelRefEditor
                              value={ref}
                              knowledge={knowledge}
                              onCancel={() => setEditing(undefined)}
                              onCommit={(next) => {
                                setEditing(undefined)
                                setRefs(
                                  protocol,
                                  refs.map((r, i) => (i === index ? next : r)),
                                )
                              }}
                            />
                          </li>
                        )
                      }
                      return (
                        <ModelRow
                          key={rowId}
                          wireName={wire}
                          knowledgeRef={key !== wire ? key : undefined}
                          model={model}
                          onEdit={() => setEditing(rowId)}
                          onRemove={() =>
                            setRefs(
                              protocol,
                              refs.filter((_, i) => i !== index),
                            )
                          }
                          onConfigure={onConfigure}
                          getConfiguration={getConfiguration}
                        />
                      )
                    })}
                  </ModelList>
                  <div className={styles['protocolActions']}>
                    {addModelControl(protocol, refs)}
                    <Button size="sm" variant="ghost" onClick={() => setProbing(protocol)}>
                      <Search size={14} strokeWidth={1.75} className={styles['btnIcon'] ?? ''} />
                      {localize('aiModels.protocol.probe', 'Probe endpoint…')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )
        })
      )}

      {undeclared.length > 0 && (
        <div className={styles['protocolActions']}>
          <Select
            className={styles['protocolMode'] ?? ''}
            value=""
            aria-label={localize('aiModels.protocol.add', 'Add protocol')}
            data-testid="ai-add-protocol"
            options={[
              { value: '', label: localize('aiModels.protocol.add', 'Add protocol') },
              ...undeclared.map((p) => ({ value: p, label: p })),
            ]}
            onChange={(next) => {
              if (next !== '') addProtocol(next as AiWireProtocol)
            }}
          />
        </div>
      )}

      {probing !== undefined && (
        <ProbeModelsDialog
          aiModel={aiModel}
          provider={provider}
          protocol={probing}
          connection={connection}
          declared={probeDeclared}
          onClose={() => setProbing(undefined)}
          onConfirm={(names, offered) => {
            const protocol = probing
            setProbing(undefined)
            setRefs(protocol, mergeProbedSelection(effective[protocol] ?? [], offered, names))
          }}
        />
      )}
    </div>
  )
}

function matches(
  wireName: string,
  name: string | undefined,
  family: string | undefined,
  query: string,
): boolean {
  if (query === '') return true
  return (
    wireName.toLowerCase().includes(query) ||
    (name?.toLowerCase().includes(query) ?? false) ||
    (family?.toLowerCase().includes(query) ?? false)
  )
}

function ModelList({ children }: { readonly children: ReactNode }) {
  return <ul className={styles['modelList']}>{children}</ul>
}

interface ModelRowProps {
  readonly wireName: string
  readonly knowledgeRef?: string | undefined
  readonly model: AiModelMetadata | undefined
  readonly onEdit?: (() => void) | undefined
  readonly onRemove?: (() => void) | undefined
  readonly onConfigure: (modelId: string, config: AiModelConfiguration) => Promise<void>
  readonly getConfiguration: (modelId: string) => Promise<AiModelConfiguration>
}

function ModelRow({
  wireName,
  knowledgeRef,
  model,
  onEdit,
  onRemove,
  onConfigure,
  getConfiguration,
}: ModelRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({})
  const schema = model?.configurationSchema
  const hasSchema = schema !== undefined && Object.keys(schema).length > 0

  const toggleConfigure = useCallback(async () => {
    if (model === undefined) return
    if (!expanded) setDraft({ ...(await getConfiguration(model.id)) })
    setExpanded((v) => !v)
  }, [expanded, getConfiguration, model])

  return (
    <li className={styles['modelRow']}>
      <div className={styles['modelMain']}>
        <span className={styles['modelName']}>{model?.name ?? wireName}</span>
        {model !== undefined && model.name !== wireName && (
          <span className={styles['modelWire']}>{wireName}</span>
        )}
        {knowledgeRef !== undefined && (
          <span className={styles['modelWire']}>
            {localize('aiModels.model.viaRef', '→ {ref}', { ref: knowledgeRef })}
          </span>
        )}
        {model !== undefined && <span className={styles['modelFamily']}>{model.family}</span>}
        {model === undefined ? (
          <Badge
            data-tooltip={localize(
              'aiModels.model.unknownTooltip',
              'Declared here but not in the knowledge base — it still works, just without metadata.',
            )}
          >
            {localize('aiModels.model.unknown', 'No metadata')}
          </Badge>
        ) : (
          <RateBadge pricing={model.pricing} />
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
        {onEdit !== undefined && (
          <IconButton
            label={localize('aiModels.model.edit', 'Edit model declaration')}
            onClick={onEdit}
          >
            <Pencil size={15} strokeWidth={1.75} />
          </IconButton>
        )}
        {onRemove !== undefined && (
          <IconButton
            label={localize('aiModels.model.remove', 'Remove model from the list')}
            onClick={onRemove}
          >
            <X size={15} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>

      {expanded && model !== undefined && schema !== undefined && (
        <div className={styles['configForm']}>
          {Object.entries(schema).map(([key, prop]) => {
            const value = draft[key]
            let control: JSX.Element
            if (prop.type === 'enum' && prop.enum) {
              control = (
                <Select
                  value={String(value ?? '')}
                  aria-label={key}
                  options={[
                    { value: '', label: localize('aiModels.config.unset', '(default)') },
                    ...prop.enum.map((opt) => ({ value: opt, label: opt })),
                  ]}
                  onChange={(next) => setDraft((d) => ({ ...d, [key]: next }))}
                />
              )
            } else if (prop.type === 'boolean') {
              control = (
                <Checkbox
                  checked={Boolean(value)}
                  aria-label={key}
                  onChange={(checked) => setDraft((d) => ({ ...d, [key]: checked }))}
                />
              )
            } else if (prop.type === 'number') {
              control = (
                <Input
                  type="number"
                  value={value === undefined ? '' : String(value)}
                  aria-label={key}
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
                  aria-label={key}
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

function RateBadge({ pricing }: { readonly pricing: AiModelPricing | undefined }) {
  if (pricing !== undefined) {
    const symbol = pricing.currency === 'CNY' ? '¥' : '$'
    return <Badge tone="accent">{`${symbol}${pricing.input} / ${symbol}${pricing.output}`}</Badge>
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
