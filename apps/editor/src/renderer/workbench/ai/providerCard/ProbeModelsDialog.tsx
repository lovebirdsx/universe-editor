/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ProbeModelsDialog — asks the endpoint what it serves, then lets the user pick
 *  which of those names to freeze into a static list. This is the bridge between
 *  the two useful states of a protocol entry: `[]` (ask every launch) and an
 *  explicit array (offline, stable, reviewable).
 *
 *  Aggregator gateways answer with hundreds of models, so the list is virtual,
 *  filterable, and pre-checked conservatively — writing 900 names into
 *  aiSettings.json because someone hit "select all" is a worse outcome than
 *  making them check a few boxes.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  localize,
  type AiProviderEntry,
  type AiWireProtocol,
  type IAiModelService,
} from '@universe-editor/platform'
import {
  Button,
  Checkbox,
  FocusScopeOverlay,
  Input,
  Spinner,
  VirtualList,
} from '@universe-editor/workbench-ui'
import styles from '../AiSettingsEditor.module.css'
import type { EffectiveConnection } from '../../../../shared/ai/providerInheritance.js'

/** Above this, a static list stops being something a human reviews. */
const LARGE_LIST_WARNING = 200
/** How many to pre-check when nothing is declared yet. */
const DEFAULT_CHECKED = 50
const ROW_HEIGHT = 26
/** Shared empty list so the "not loaded yet" case keeps a stable identity. */
const EMPTY_IDS: readonly string[] = []

type ProbeState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly ids: readonly string[]; readonly total: number }
  | { readonly kind: 'fail'; readonly error: string }

interface ProbeModelsDialogProps {
  readonly aiModel: IAiModelService
  readonly provider: AiProviderEntry
  readonly protocol: AiWireProtocol
  /** Where to dial — already folded over `extends`, so an inheriting entry works. */
  readonly connection: EffectiveConnection
  /**
   * Wire names already declared — pre-checked, so confirming never drops them.
   * Must be referentially stable: it is an effect dependency, and a fresh array
   * on every parent render would re-probe and wipe the user's ticks.
   */
  readonly declared: readonly string[]
  readonly onClose: () => void
  /** Receives what the dialog offered as well as what was ticked. */
  readonly onConfirm: (selected: readonly string[], offered: readonly string[]) => void
}

export function ProbeModelsDialog({
  aiModel,
  provider,
  protocol,
  connection,
  declared,
  onClose,
  onConfirm,
}: ProbeModelsDialogProps) {
  const [state, setState] = useState<ProbeState>({ kind: 'loading' })
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')

  const { baseUrl, apiKey } = connection

  useEffect(() => {
    let active = true
    void (async () => {
      const result = await aiModel.verifyProvider({
        id: provider.id,
        protocol,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
      })
      if (!active) return
      console.debug('aiModels: probe', {
        provider: provider.id,
        protocol,
        ok: result.ok,
        modelCount: result.modelCount,
        returned: result.modelIds?.length ?? 0,
      })
      if (!result.ok) {
        setState({
          kind: 'fail',
          error: result.error ?? localize('aiModels.probe.failed', 'Could not reach the endpoint.'),
        })
        return
      }
      const ids = result.modelIds ?? []
      setState({ kind: 'ok', ids, total: result.modelCount })
      const declaredSet = new Set(declared)
      const preset = ids.filter((id) => declaredSet.has(id))
      setChecked(new Set(preset.length > 0 ? preset : ids.slice(0, DEFAULT_CHECKED)))
    })()
    return () => {
      active = false
    }
  }, [aiModel, provider.id, baseUrl, apiKey, protocol, declared])

  const ids = useMemo(() => (state.kind === 'ok' ? state.ids : EMPTY_IDS), [state])
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q === '' ? ids : ids.filter((id) => id.toLowerCase().includes(q))
  }, [ids, filter])

  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const setAllVisible = useCallback(
    (on: boolean) => {
      setChecked((prev) => {
        const next = new Set(prev)
        for (const id of visible) {
          if (on) next.add(id)
          else next.delete(id)
        }
        return next
      })
    },
    [visible],
  )

  return (
    <FocusScopeOverlay visible onEscape={onClose}>
      <div className={styles['probeBackdrop']} onMouseDown={onClose} />
      <div className={styles['probeDialog']} role="dialog" aria-modal="true" data-testid="ai-probe">
        <div className={styles['probeHeader']}>
          <span className={styles['sectionTitle']}>
            {localize('aiModels.probe.title', 'Models on {protocol}', { protocol })}
          </span>
        </div>

        {state.kind === 'loading' && (
          <div className={styles['probeStatus']}>
            <Spinner size={14} />
            {localize('aiModels.probe.loading', 'Asking the endpoint…')}
          </div>
        )}

        {state.kind === 'fail' && (
          <div className={styles['probeError']} data-testid="ai-probe-error">
            {state.error}
          </div>
        )}

        {state.kind === 'ok' && (
          <>
            {state.total > state.ids.length && (
              <div className={styles['probeNote']}>
                {localize(
                  'aiModels.probe.capped',
                  'Showing the first {shown} of {total} models reported by the endpoint.',
                  { shown: state.ids.length, total: state.total },
                )}
              </div>
            )}
            {state.total > LARGE_LIST_WARNING && (
              <div className={styles['probeNote']}>
                {localize(
                  'aiModels.probe.largeList',
                  'This endpoint serves {total} models. A static list this long is hard to review — consider leaving the protocol on "Discover from endpoint" instead.',
                  { total: state.total },
                )}
              </div>
            )}

            <div className={styles['probeToolbar']}>
              <Input
                className={styles['modelFilter']}
                value={filter}
                placeholder={localize('aiModels.probe.filter', 'Filter…')}
                aria-label={localize('aiModels.probe.filter', 'Filter…')}
                onChange={(e) => setFilter(e.target.value)}
              />
              <Button size="sm" variant="ghost" onClick={() => setAllVisible(true)}>
                {localize('aiModels.probe.selectAll', 'Select all')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAllVisible(false)}>
                {localize('aiModels.probe.selectNone', 'Select none')}
              </Button>
            </div>

            {visible.length === 0 ? (
              <div className={styles['probeStatus']}>
                {localize('aiModels.probe.empty', 'No model matches this filter.')}
              </div>
            ) : (
              <VirtualList
                items={visible}
                className={styles['probeList'] ?? ''}
                estimateSize={() => ROW_HEIGHT}
                getItemKey={(index) => visible[index] ?? index}
                renderItem={(id, style) => (
                  <div style={style} className={styles['probeRow']}>
                    <Checkbox checked={checked.has(id)} label={id} onChange={() => toggle(id)} />
                  </div>
                )}
              />
            )}
          </>
        )}

        <div className={styles['probeFooter']}>
          <span className={styles['probeCount']}>
            {localize('aiModels.probe.selected', '{count} selected', { count: checked.size })}
          </span>
          <span className={styles['spacer']} />
          <Button
            size="sm"
            disabled={state.kind !== 'ok' || checked.size === 0}
            onClick={() =>
              onConfirm(
                ids.filter((id) => checked.has(id)),
                ids,
              )
            }
          >
            {localize('aiModels.probe.confirm', 'Use selected')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {localize('aiModels.probe.cancel', 'Cancel')}
          </Button>
        </div>
      </div>
    </FocusScopeOverlay>
  )
}
