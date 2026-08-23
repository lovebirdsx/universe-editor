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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileJson, Plus, TriangleAlert } from 'lucide-react'
import {
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  IQuickInputService,
  IStorageService,
  IUserDataFilesService,
  StorageScope,
  UserDataFile,
  localize,
  type AiModelMetadata,
  type AiProviderEntry,
  type AiProviderIssue,
  type AiRateTableSnapshot,
  type AiWireProtocol,
} from '@universe-editor/platform'
import { Button } from '@universe-editor/workbench-ui'
import { useEventSubscription, useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../../services/editor/openInLockAwareGroup.js'
import { IAiRateMirror } from '../../services/ai/aiRateMirror.js'
import { AddProviderDialog } from './AddProviderDialog.js'
import { ProviderEntryCard, issueReasonLabel } from './ProviderEntryCard.js'
import styles from './AiSettingsEditor.module.css'

const COLLAPSED_KEY = 'ai.settings.models.collapsed'
const filterKey = (key: string): string => `ai.settings.models.filter.${key}`

const SECTION_PROVIDERS = 'section:providers'
const providerCollapseKey = (id: string): string => `provider:${id}`

export function AiModelsPanel() {
  const aiModel = useService(IAiModelService)
  const rateMirror = useService(IAiRateMirror)
  const quickInput = useService(IQuickInputService)
  const dialog = useService(IDialogService)
  const userData = useService(IUserDataFilesService)
  const editorGroups = useService(IEditorGroupsService)
  const instantiation = useService(IInstantiationService)
  const storage = useService(IStorageService)

  const [providers, setProviders] = useState<readonly AiProviderEntry[]>([])
  const [models, setModels] = useState<readonly AiModelMetadata[]>([])
  const [issues, setIssues] = useState<readonly AiProviderIssue[]>([])
  const [legacy, setLegacy] = useState(false)
  const [rateTables, setRateTables] = useState<readonly AiRateTableSnapshot[]>([])
  const [collapsed, setCollapsed] = useState<Readonly<Record<string, boolean>>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let active = true
    void storage.get<Record<string, boolean>>(COLLAPSED_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && stored) setCollapsed(stored)
    })
    return () => {
      active = false
    }
  }, [storage])

  const toggleCollapsed = useCallback(
    (key: string) => {
      setCollapsed((prev) => {
        const next = { ...prev, [key]: !prev[key] }
        void storage.set(COLLAPSED_KEY, next, StorageScope.GLOBAL)
        return next
      })
    },
    [storage],
  )

  const reload = useCallback(async () => {
    const [nextProviders, nextModels, nextIssues, nextLegacy] = await Promise.all([
      aiModel.getProviders(),
      aiModel.getModels(),
      aiModel.getProviderIssues(),
      aiModel.isLegacySettingsFormat(),
    ])
    setProviders(nextProviders)
    setModels(nextModels)
    setIssues(nextIssues)
    setLegacy(nextLegacy)
    setRateTables(rateMirror.getRateTablesSync())
    setReloadToken((t) => t + 1)
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
      await aiModel.updateProviders(next)
      await reload()
    },
    [aiModel, reload],
  )

  const replaceProvider = useCallback(
    async (id: string, build: (provider: AiProviderEntry) => AiProviderEntry) => {
      const next = providers.map((p) => (p.id === id ? build(p) : p))
      await updateProviders(next)
    },
    [providers, updateProviders],
  )

  const setProviderLabel = useCallback(
    async (id: string, label: string) => {
      await replaceProvider(id, (p) => {
        if (label) return { ...p, label }
        if (!('label' in p)) return p
        const next = { ...p }
        delete (next as { label?: string }).label
        return next
      })
    },
    [replaceProvider],
  )

  const setProviderBaseUrl = useCallback(
    async (id: string, baseUrl: string) => {
      await replaceProvider(id, (p) => {
        if (baseUrl) return { ...p, baseUrl }
        if (!('baseUrl' in p)) return p
        const next = { ...p }
        delete (next as { baseUrl?: string }).baseUrl
        return next
      })
    },
    [replaceProvider],
  )

  const setProviderDefaultProtocol = useCallback(
    async (id: string, protocol: AiWireProtocol | undefined) => {
      await replaceProvider(id, (p) => {
        if (protocol !== undefined) return { ...p, defaultProtocol: protocol }
        if (!('defaultProtocol' in p)) return p
        const next = { ...p }
        delete (next as { defaultProtocol?: AiWireProtocol }).defaultProtocol
        return next
      })
    },
    [replaceProvider],
  )

  const setProviderApiKey = useCallback(
    async (provider: AiProviderEntry) => {
      const key = await quickInput.input({
        prompt: localize(
          'aiModels.apiKey.editPrompt',
          'Enter the API key for {name} (stored in plaintext in aiSettings.json).',
          { name: provider.label ?? provider.id },
        ),
        value: provider.apiKey ?? '',
        placeholder: 'sk-…',
        validateInput: (v) =>
          v.trim().length === 0
            ? localize('aiModels.apiKey.empty', 'The API key must not be empty.')
            : undefined,
      })
      const trimmed = key?.trim()
      if (trimmed === undefined) return
      await aiModel.setApiKey(provider.id, trimmed)
      await reload()
    },
    [quickInput, aiModel, reload],
  )

  const clearProviderApiKey = useCallback(
    async (provider: AiProviderEntry) => {
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.apiKey.clearConfirm', 'Clear the stored API key for {name}?', {
          name: provider.label ?? provider.id,
        }),
        primaryButton: localize('aiModels.apiKey.clearAction', 'Clear'),
        type: 'warning',
      })
      if (!confirmed) return
      await aiModel.deleteApiKey(provider.id)
      await reload()
    },
    [dialog, aiModel, reload],
  )

  const removeProvider = useCallback(
    async (provider: AiProviderEntry) => {
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.entry.remove.confirm', 'Remove provider {name}?', {
          name: provider.label ?? provider.id,
        }),
        primaryButton: localize('aiModels.entry.remove.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      await updateProviders(providers.filter((p) => p.id !== provider.id))
    },
    [dialog, providers, updateProviders],
  )

  const refreshProviderPrices = useCallback(
    async (providerId: string) => {
      await aiModel.refreshRemote(providerId)
      await reload()
    },
    [aiModel, reload],
  )

  const openJson = useCallback(async () => {
    await aiModel.updateProviders(await aiModel.getProviders())
    const uri = await userData.getFileUri(UserDataFile.AiSettings)
    if (!uri) return
    const input = instantiation.createInstance(FileEditorInput, uri)
    void openInLockAwareGroup(editorGroups, input, { activate: true })
  }, [aiModel, editorGroups, instantiation, userData])

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

      <div className={styles['plaintextNotice']}>
        {localize(
          'aiModels.plaintextNotice',
          'API keys are stored in plaintext in aiSettings.json (to sync across machines). Do not commit that file to version control or share it.',
        )}
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
        onToggle={() => toggleCollapsed(SECTION_PROVIDERS)}
      >
        {providers.length === 0 ? (
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
                provider={provider}
                models={models.filter((m) => m.providerId === provider.id)}
                issues={issuesByProvider.get(provider.id) ?? []}
                rateTables={rateTables}
                reloadToken={reloadToken}
                collapsed={collapsed[providerCollapseKey(provider.id)] ?? false}
                onToggleCollapsed={() => toggleCollapsed(providerCollapseKey(provider.id))}
                storage={storage}
                filterStorageKey={filterKey(provider.id)}
                onLabelChange={(label) => void setProviderLabel(provider.id, label)}
                onBaseUrlChange={(baseUrl) => void setProviderBaseUrl(provider.id, baseUrl)}
                onDefaultProtocolChange={(protocol) =>
                  void setProviderDefaultProtocol(provider.id, protocol)
                }
                onSetApiKey={() => void setProviderApiKey(provider)}
                onClearApiKey={() => void clearProviderApiKey(provider)}
                onRemove={() => void removeProvider(provider)}
                onRefreshPrices={() => void refreshProviderPrices(provider.id)}
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
