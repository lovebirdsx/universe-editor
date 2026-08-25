/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiModelsPanel — the "Model configuration" category of the AI settings editor.
 *  A single list of provider *entries* (one gateway endpoint each: connection +
 *  credential + protocol map). Reads everything live from IAiModelService; edits
 *  go through updateProviders / setApiKey / deleteApiKey, and API keys are stored
 *  plaintext on the entry (explicit user decision: cross-machine sync) — never
 *  logged. A banner surfaces when aiSettings.json is still in the retired
 *  two-layer format, and configuration problems from getProviderIssues() are
 *  shown on the affected cards rather than silently swallowed.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileJson, Plus, TriangleAlert } from 'lucide-react'
import {
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  IStorageService,
  IUserDataFilesService,
  StorageScope,
  UserDataFile,
  localize,
  type AiAccountUsage,
  type AiModelKnowledge,
  type AiModelMetadata,
  type AiProviderEntry,
  type AiProviderIssue,
  type AiRateTableSnapshot,
} from '@universe-editor/platform'
import { Button, Spinner } from '@universe-editor/workbench-ui'
import { useEventSubscription, useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../../services/editor/openInLockAwareGroup.js'
import { IAiRateMirror } from '../../services/ai/aiRateMirror.js'
import { effectiveUsageSource } from '../../../shared/ai/providerInheritance.js'
import { AddProviderDialog } from './AddProviderDialog.js'
import { ProviderEntryCard, issueReasonLabel, type CardSectionId } from './ProviderEntryCard.js'
import type { UsageState } from './providerCard/usageState.js'
import type { ProviderPatch } from './providerCard/useProviderField.js'
import styles from './AiSettingsEditor.module.css'

const COLLAPSED_KEY = 'ai.settings.models.collapsed'
const filterKey = (key: string): string => `ai.settings.models.filter.${key}`

const SECTION_PROVIDERS = 'section:providers'
const providerCollapseKey = (id: string): string => `provider:${id}`
const sectionCollapseKey = (id: string, section: CardSectionId): string =>
  `provider:${id}:${section}`
const protocolCollapseKey = (id: string, protocol: string): string =>
  `provider:${id}:protocol:${protocol}`

export function AiModelsPanel() {
  const aiModel = useService(IAiModelService)
  const rateMirror = useService(IAiRateMirror)
  const dialog = useService(IDialogService)
  const userData = useService(IUserDataFilesService)
  const editorGroups = useService(IEditorGroupsService)
  const instantiation = useService(IInstantiationService)
  const storage = useService(IStorageService)

  const [providers, setProviders] = useState<readonly AiProviderEntry[]>([])
  const [models, setModels] = useState<readonly AiModelMetadata[]>([])
  const [issues, setIssues] = useState<readonly AiProviderIssue[]>([])
  const [knowledge, setKnowledge] = useState<Readonly<Record<string, AiModelKnowledge>>>({})
  const [legacy, setLegacy] = useState(false)
  const [rateTables, setRateTables] = useState<readonly AiRateTableSnapshot[]>([])
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({})
  const [usages, setUsages] = useState<ReadonlyMap<string, AiAccountUsage | undefined>>(new Map())
  const [addOpen, setAddOpen] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [loaded, setLoaded] = useState(false)
  /**
   * True while a model enumeration is in flight. Cards use it to say "asking the
   * endpoint" instead of flashing "0 models / none resolved" before the answer
   * lands — a hung /v1/models can hold this for the full request timeout.
   */
  const [modelsLoading, setModelsLoading] = useState(true)

  /**
   * `updateProviders` replaces the whole array, so every write must start from
   * the newest one. Render state is too old for that: with per-field immediate
   * saves, a second commit can be issued while the first is still in flight to
   * main, and a stale snapshot would silently undo it. The ref carries the value
   * across that window, and the chain keeps writes from interleaving at all.
   */
  const providersRef = useRef<readonly AiProviderEntry[]>([])
  const writeChain = useRef<Promise<unknown>>(Promise.resolve())
  /** Monotonic guard so a stale model enumeration can never paint over a newer one. */
  const modelsTokenRef = useRef(0)
  /** Set on unmount; async reload continuations skip setState once it flips. */
  const disposedRef = useRef(false)
  /** Bumped by every snapshot replacement so a stale getProviders can't clobber it. */
  const writeSeqRef = useRef(0)

  const enqueueWrite = useCallback((run: () => Promise<void>): Promise<void> => {
    const next = writeChain.current.then(run, run)
    writeChain.current = next.catch(() => undefined)
    return next
  }, [])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
    }
  }, [])

  // An enumeration still in flight on unmount must not paint (or leak the
  // component instance via a late setState).
  useEffect(
    () => () => {
      modelsTokenRef.current++
    },
    [],
  )

  useEffect(() => {
    let active = true
    void storage.get<Record<string, boolean>>(COLLAPSED_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && stored) setCollapsed(stored)
    })
    return () => {
      active = false
    }
  }, [storage])

  /**
   * `defaultCollapsed` is not decoration: storage holds only the keys the user has
   * actually toggled, so a section that starts collapsed would otherwise read
   * `undefined`, flip to `true`, and stay collapsed — a first click that visibly
   * does nothing. Toggling the *effective* value keeps the stored model sparse (no
   * pre-seeded defaults, no migration) while every default behaves.
   */
  const toggleCollapsed = useCallback(
    (key: string, defaultCollapsed: boolean) => {
      setCollapsed((prev) => {
        const next = { ...prev, [key]: !(prev[key] ?? defaultCollapsed) }
        void storage.set(COLLAPSED_KEY, next, StorageScope.GLOBAL)
        return next
      })
    },
    [storage],
  )

  /**
   * Fast main-memory reads land immediately so the provider list isn't held
   * hostage by a discover provider whose /v1/models enumeration is slow to
   * answer. `getModels` is that enumeration (it can block up to
   * METADATA_REQUEST_TIMEOUT_MS for a hung endpoint); it runs in the background
   * and paints only the model counts. A stale enumeration result is dropped via
   * `modelsTokenRef` so a newer reload always wins.
   */
  const reload = useCallback(async () => {
    const version = writeSeqRef.current
    try {
      const [nextProviders, nextIssues, nextLegacy, nextKnowledge] = await Promise.all([
        aiModel.getProviders(),
        aiModel.getProviderIssues(),
        aiModel.isLegacySettingsFormat(),
        aiModel.getModelKnowledge(),
      ])
      if (disposedRef.current) return
      if (version === writeSeqRef.current) {
        providersRef.current = nextProviders
        setProviders(nextProviders)
      }
      setIssues(nextIssues)
      setLegacy(nextLegacy)
      setKnowledge(nextKnowledge)
      setRateTables(rateMirror.getRateTablesSync())
      setReloadToken((t) => t + 1)
    } catch (error) {
      console.debug('aiModels: reload fast reads failed', error)
    } finally {
      // The list is "loaded" once the fast reads settle — a hung enumeration must
      // never leave the panel spinning at the loading placeholder forever.
      if (!disposedRef.current) setLoaded(true)
    }

    const token = ++modelsTokenRef.current
    setModelsLoading(true)
    const settle = () => {
      // A stale answer must not clear the flag: a newer enumeration is in flight.
      if (!disposedRef.current && token === modelsTokenRef.current) setModelsLoading(false)
    }
    void aiModel
      .getModels()
      .then((nextModels) => {
        if (disposedRef.current || token !== modelsTokenRef.current) return
        setModels(nextModels)
        setModelsLoading(false)
      })
      .catch((error) => {
        console.debug('aiModels: model enumeration failed', error)
        settle()
      })
  }, [aiModel, rateMirror])

  useEffect(() => {
    void reload()
  }, [reload])

  useEventSubscription(
    () => [
      aiModel.onDidChangeModels(() => void reload()),
      aiModel.onDidChangeRemote(() => void reload()),
    ],
    [aiModel, reload],
  )

  /**
   * Account usage is fetched here rather than in the cards, for two reasons: the
   * header badge must show a number even while the card body is collapsed and
   * unmounted, and every trigger that invalidates usage (add/remove, source edit,
   * extends change, aiSettings.json reload, refreshRemote) already lands on
   * `reload`. `getAccountUsage` is a cache read in main with no network of its
   * own, so asking for every provider at once is cheap.
   *
   * The id list follows the *effective* source: main flattens `extends` before it
   * fetches and caches under the child's own id, so an entry that only inherits a
   * `usageSource` does have a number — skipping it was why those cards showed
   * nothing at all.
   */
  useEffect(() => {
    let active = true
    const ids = providers
      .filter((p) => effectiveUsageSource(p, providers) !== undefined)
      .map((p) => p.id)
    void Promise.allSettled(
      ids.map(async (id) => [id, await aiModel.getAccountUsage(id)] as const),
    ).then((results) => {
      if (!active) return
      // Whole-Map replacement: entries removed since the fetch started drop out
      // instead of lingering as stale numbers. A rejected read is recorded as
      // `undefined` — "we asked and got nothing" reads as Unavailable, whereas
      // leaving the key out would spin forever on a state that is already settled.
      const next = new Map<string, AiAccountUsage | undefined>()
      for (const [i, r] of results.entries()) {
        const id = ids[i]
        if (id === undefined) continue
        if (r.status === 'fulfilled') next.set(id, r.value[1])
        else {
          console.debug('aiModels: account usage read failed', { provider: id, error: r.reason })
          next.set(id, undefined)
        }
      }
      setUsages(next)
    })
    return () => {
      active = false
    }
  }, [aiModel, providers, reloadToken])

  const usageStateFor = useCallback(
    (provider: AiProviderEntry): UsageState => {
      if (effectiveUsageSource(provider, providers) === undefined) return { kind: 'none' }
      if (!usages.has(provider.id)) return { kind: 'loading' }
      return { kind: 'ready', value: usages.get(provider.id) }
    },
    [providers, usages],
  )

  const issuesByProvider = useMemo(() => {
    const map = new Map<string, AiProviderIssue[]>()
    for (const issue of issues) {
      const list = map.get(issue.providerId) ?? []
      list.push(issue)
      map.set(issue.providerId, list)
    }
    return map
  }, [issues])

  // Issues whose providerId matches no entry — a malformed element never became
  // one, so no card would ever show them.
  const orphanIssues = useMemo(() => {
    const ids = new Set(providers.map((p) => p.id))
    return issues.filter((issue) => !ids.has(issue.providerId))
  }, [issues, providers])

  const updateProviders = useCallback(
    async (next: readonly AiProviderEntry[]) => {
      providersRef.current = next
      writeSeqRef.current++
      await aiModel.updateProviders(next)
      await reload()
    },
    [aiModel, reload],
  )

  // Indexed, not keyed by id: a hand-edited file can repeat an id, and editing
  // one of the two cards must not rewrite both.
  const replaceProviderAt = useCallback(
    (index: number, build: ProviderPatch) =>
      enqueueWrite(async () => {
        await updateProviders(providersRef.current.map((p, i) => (i === index ? build(p) : p)))
      }),
    [enqueueWrite, updateProviders],
  )

  const setProviderApiKey = useCallback(
    (provider: AiProviderEntry, key: string) =>
      // Same queue as the entry writes: main resolves setApiKey against its own
      // last-loaded providers, so letting it overlap an in-flight updateProviders
      // would drop whichever field the other one carried.
      enqueueWrite(async () => {
        await aiModel.setApiKey(provider.id, key)
        await reload()
      }),
    [aiModel, enqueueWrite, reload],
  )

  const clearProviderApiKey = useCallback(
    async (provider: AiProviderEntry) => {
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.apiKey.clearConfirm', 'Clear the stored API key for {name}?', {
          name: provider.id,
        }),
        primaryButton: localize('aiModels.apiKey.clearAction', 'Clear'),
        type: 'warning',
      })
      if (!confirmed) return
      await enqueueWrite(async () => {
        await aiModel.deleteApiKey(provider.id)
        await reload()
      })
    },
    [dialog, aiModel, enqueueWrite, reload],
  )

  const removeProvider = useCallback(
    async (index: number) => {
      const provider = providers[index]
      if (provider === undefined) return
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.entry.remove.confirm', 'Remove provider {name}?', {
          name: provider.id,
        }),
        primaryButton: localize('aiModels.entry.remove.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      await enqueueWrite(async () => {
        await updateProviders(providersRef.current.filter((_, i) => i !== index))
      })
    },
    [dialog, enqueueWrite, providers, updateProviders],
  )

  const duplicateProvider = useCallback(
    (index: number) =>
      enqueueWrite(async () => {
        const current = providersRef.current
        const source = current[index]
        if (source === undefined) return
        const taken = new Set(current.map((p) => p.id))
        let id = `${source.id}-copy`
        for (let n = 2; taken.has(id); n++) id = `${source.id}-copy-${n}`
        console.debug('aiModels: duplicate provider', { from: source.id, to: id })
        await updateProviders([
          ...current.slice(0, index + 1),
          { ...source, id },
          ...current.slice(index + 1),
        ])
      }),
    [enqueueWrite, updateProviders],
  )

  const refreshProviderPrices = useCallback(
    async (providerId: string) => {
      await aiModel.refreshRemote(providerId)
      await reload()
    },
    [aiModel, reload],
  )

  const openJson = useCallback(async () => {
    await enqueueWrite(() => aiModel.updateProviders(providersRef.current))
    const uri = await userData.getFileUri(UserDataFile.AiSettings)
    if (!uri) return
    const input = instantiation.createInstance(FileEditorInput, uri)
    void openInLockAwareGroup(editorGroups, input, { activate: true })
  }, [aiModel, editorGroups, enqueueWrite, instantiation, userData])

  return (
    <div className={styles['panel']}>
      <div className={styles['panelToolbar']}>
        <Button onClick={() => setAddOpen(true)}>
          <Plus size={14} strokeWidth={2} className={styles['btnIcon']} />
          {localize('aiModels.addProvider', 'Add Provider')}
        </Button>
        <Button variant="ghost" onClick={() => void openJson()}>
          <FileJson size={14} strokeWidth={1.75} className={styles['btnIcon']} />
          {localize('aiSettings.openJson', 'Open aiSettings.json')}
        </Button>
      </div>

      {legacy && (
        <div className={styles['legacyBanner']} data-testid="ai-legacy-banner">
          <TriangleAlert size={16} strokeWidth={1.75} className={styles['cardIcon']} />
          <span className={styles['spacer']}>
            {localize(
              'aiModels.legacy.banner',
              'aiSettings.json is still in the retired two-layer format and has been ignored. Rebuild it in the new format by hand (you can copy the API keys from the old file).',
            )}
          </span>
          <Button variant="ghost" onClick={() => void openJson()}>
            {localize('aiSettings.openJson', 'Open aiSettings.json')}
          </Button>
        </div>
      )}

      {orphanIssues.length > 0 && (
        <div className={styles['legacyBanner']} data-testid="ai-orphan-issues">
          <TriangleAlert size={16} strokeWidth={1.75} className={styles['cardIcon']} />
          <span className={styles['spacer']}>
            {localize(
              'aiModels.issue.orphanBanner',
              'Some entries in aiSettings.json could not be read: {details}',
              {
                details: orphanIssues
                  .map((i) => `${i.providerId} — ${issueReasonLabel(i.reason)}`)
                  .join('; '),
              },
            )}
          </span>
          <Button variant="ghost" onClick={() => void openJson()}>
            {localize('aiSettings.openJson', 'Open aiSettings.json')}
          </Button>
        </div>
      )}

      <Section
        title={localize('aiModels.section.providers', 'Providers')}
        collapsed={collapsed[SECTION_PROVIDERS] ?? false}
        onToggle={() => toggleCollapsed(SECTION_PROVIDERS, false)}
      >
        {!loaded ? (
          <div className={styles['emptyState']} data-testid="ai-providers-loading">
            <Spinner size={20} />
            <div className={styles['emptyDesc']}>
              {localize('aiModels.providers.loading', 'Loading providers…')}
            </div>
          </div>
        ) : providers.length === 0 ? (
          <div className={styles['emptyState']}>
            <div className={styles['emptyDesc']}>
              {localize(
                'aiModels.providers.empty',
                'No providers yet. Add one to connect an AI service.',
              )}
            </div>
            <Button onClick={() => setAddOpen(true)}>
              <Plus size={14} strokeWidth={2} className={styles['btnIcon']} />
              {localize('aiModels.addProvider', 'Add Provider')}
            </Button>
          </div>
        ) : (
          <div className={styles['cards']}>
            {providers.map((provider, index) => (
              <ProviderEntryCard
                // A hand-edited file can repeat an id. That is a reported
                // `duplicate-id` issue, and both cards must render so the badge
                // is visible — so the key cannot be the id alone.
                key={`${provider.id}#${index}`}
                aiModel={aiModel}
                dialog={dialog}
                provider={provider}
                allProviders={providers}
                models={models.filter((m) => m.providerId === provider.id)}
                modelsLoading={modelsLoading}
                issues={issuesByProvider.get(provider.id) ?? []}
                rateTables={rateTables}
                knowledge={knowledge}
                usage={usageStateFor(provider)}
                collapsed={collapsed[providerCollapseKey(provider.id)] ?? false}
                onToggleCollapsed={() => toggleCollapsed(providerCollapseKey(provider.id), false)}
                isSectionCollapsed={(section, defaultCollapsed) =>
                  collapsed[sectionCollapseKey(provider.id, section)] ?? defaultCollapsed
                }
                onToggleSection={(section, defaultCollapsed) =>
                  toggleCollapsed(sectionCollapseKey(provider.id, section), defaultCollapsed)
                }
                isProtocolCollapsed={(protocol) =>
                  collapsed[protocolCollapseKey(provider.id, protocol)] ?? false
                }
                onToggleProtocol={(protocol) =>
                  toggleCollapsed(protocolCollapseKey(provider.id, protocol), false)
                }
                storage={storage}
                filterStorageKey={filterKey(provider.id)}
                updateEntry={(build) => replaceProviderAt(index, build)}
                onSetApiKey={(key) => setProviderApiKey(provider, key)}
                onClearApiKey={() => clearProviderApiKey(provider)}
                onRemove={() => void removeProvider(index)}
                onDuplicate={() => void duplicateProvider(index)}
                onRefreshRemote={() => refreshProviderPrices(provider.id)}
                onConfigure={(modelId, config) =>
                  aiModel.setModelConfiguration(modelId, config).then(() => reload())
                }
                getConfiguration={(modelId) => aiModel.getModelConfiguration(modelId)}
              />
            ))}
          </div>
        )}
      </Section>

      {addOpen && (
        <AddProviderDialog
          existingProviders={providers}
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false)
            void reload()
          }}
        />
      )}
    </div>
  )
}

function Section({
  title,
  collapsed,
  onToggle,
  children,
}: {
  readonly title: string
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
}) {
  return (
    <section className={styles['section']}>
      <button
        type="button"
        className={styles['sectionHeader']}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? (
          <ChevronRight size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        ) : (
          <ChevronDown size={16} strokeWidth={1.75} className={styles['cardIcon']} />
        )}
        <span className={styles['sectionTitle']}>{title}</span>
      </button>
      {!collapsed && <div className={styles['sectionBody']}>{children}</div>}
    </section>
  )
}
