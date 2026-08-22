/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiModelsPanel — the "Model configuration" category of the AI settings editor.
 *  Two collapsible sections: provider *types* (protocol / model catalog / rates /
 *  remote sources) and provider *instances* (connection + credential). Reads
 *  everything live from IAiModelService; type-layer edits go through
 *  updateProviderTypes, instance-layer edits through updateProviders, and API
 *  keys are stored plaintext on the instance (explicit user decision: cross-
 *  machine sync) — never logged. Per-section / per-card collapse state and the
 *  per-card model filter are persisted (GLOBAL scope).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileJson, Plus } from 'lucide-react'
import {
  bareModelName,
  IAiModelService,
  IDialogService,
  IEditorGroupsService,
  IInstantiationService,
  INotificationService,
  IQuickInputService,
  IStorageService,
  IUserDataFilesService,
  Severity,
  StorageScope,
  UserDataFile,
  localize,
  providerKey,
  type AiCustomModelConfig,
  type AiModelConfiguration,
  type AiModelMetadata,
  type AiModelPricing,
  type AiProviderInstance,
  type AiProviderType,
  type AiProviderTypeDescriptor,
  type AiRateTableSnapshot,
} from '@universe-editor/platform'
import { Button } from '@universe-editor/workbench-ui'
import { useEventSubscription, useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { openInLockAwareGroup } from '../../services/editor/openInLockAwareGroup.js'
import { IAiRateMirror } from '../../services/ai/aiRateMirror.js'
import { AddProviderDialog } from './AddProviderDialog.js'
import { ProviderTypeCard } from './ProviderTypeCard.js'
import { ProviderInstanceCard } from './ProviderInstanceCard.js'
import styles from './AiSettingsEditor.module.css'

const COLLAPSED_KEY = 'ai.settings.models.collapsed'
const filterKey = (key: string): string => `ai.settings.models.filter.${key}`

const SECTION_TYPES = 'section:types'
const SECTION_INSTANCES = 'section:instances'
const typeCollapseKey = (typeId: string): string => `type:${typeId}`
const instanceCollapseKey = (inst: AiProviderInstance): string => `instance:${providerKey(inst)}`

export function AiModelsPanel() {
  const aiModel = useService(IAiModelService)
  const rateMirror = useService(IAiRateMirror)
  const quickInput = useService(IQuickInputService)
  const dialog = useService(IDialogService)
  const notifications = useService(INotificationService)
  const userData = useService(IUserDataFilesService)
  const editorGroups = useService(IEditorGroupsService)
  const instantiation = useService(IInstantiationService)
  const storage = useService(IStorageService)

  const [types, setTypes] = useState<Readonly<Record<string, AiProviderType>>>({})
  const [typeDescriptors, setTypeDescriptors] = useState<readonly AiProviderTypeDescriptor[]>([])
  const [instances, setInstances] = useState<readonly AiProviderInstance[]>([])
  const [models, setModels] = useState<readonly AiModelMetadata[]>([])
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
    const [nextTypes, nextDescriptors, nextInstances, nextModels] = await Promise.all([
      aiModel.getProviderTypes(),
      aiModel.getProviderTypeDescriptors(),
      aiModel.getProviders(),
      aiModel.getModels(),
    ])
    setTypes(nextTypes)
    setTypeDescriptors(nextDescriptors)
    setInstances(nextInstances)
    setModels(nextModels)
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

  const descriptorById = useMemo(() => {
    const map = new Map<string, AiProviderTypeDescriptor>()
    for (const d of typeDescriptors) map.set(d.id, d)
    return map
  }, [typeDescriptors])

  const updateTypesRecord = useCallback(
    async (next: Readonly<Record<string, AiProviderType>>) => {
      await aiModel.updateProviderTypes(next)
      await reload()
    },
    [aiModel, reload],
  )

  const updateType = useCallback(
    async (typeId: string, build: (type: AiProviderType) => AiProviderType) => {
      const type = types[typeId]
      if (!type) return
      await updateTypesRecord({ ...types, [typeId]: build(type) })
    },
    [types, updateTypesRecord],
  )

  const updateInstances = useCallback(
    async (next: readonly AiProviderInstance[]) => {
      await aiModel.updateProviders(next)
      await reload()
    },
    [aiModel, reload],
  )

  const replaceInstance = useCallback(
    async (key: string, build: (inst: AiProviderInstance) => AiProviderInstance) => {
      const next = instances.map((inst) => (providerKey(inst) === key ? build(inst) : inst))
      await updateInstances(next)
    },
    [instances, updateInstances],
  )

  // --- provider type mutations -------------------------------------------

  const setTypeBaseUrl = useCallback(
    async (typeId: string, baseUrl: string) => {
      await updateType(typeId, (type) => {
        if (baseUrl) return { ...type, defaultBaseUrl: baseUrl }
        if (!('defaultBaseUrl' in type)) return type
        const next = { ...type }
        delete (next as { defaultBaseUrl?: string }).defaultBaseUrl
        return next
      })
    },
    [updateType],
  )

  const setTypeModelPricing = useCallback(
    async (typeId: string, modelId: string, pricing: AiModelPricing | undefined) => {
      await updateType(typeId, (type) => {
        const models = (type.models ?? []).map((m) =>
          m.id === modelId ? setModelPricing(m, pricing) : m,
        )
        return { ...type, models }
      })
    },
    [updateType],
  )

  const addTypeModel = useCallback(
    async (typeId: string) => {
      const type = types[typeId]
      if (!type) return
      const id = await quickInput.input({
        prompt: localize(
          'aiModels.addModel.id',
          'Model id the endpoint expects (e.g. qwen3-coder)',
        ),
        validateInput: (v) =>
          v.trim().length === 0
            ? localize('aiModels.addModel.idEmpty', 'Model id must not be empty.')
            : undefined,
      })
      const trimmedId = id?.trim()
      if (!trimmedId) return
      if ((type.models ?? []).some((m) => m.id === trimmedId)) {
        notifications.notify({
          severity: Severity.Warning,
          message: localize('aiModels.addModel.exists', 'That model is already declared.'),
        })
        return
      }
      await updateType(typeId, (t) => ({
        ...t,
        models: [...(t.models ?? []), { id: trimmedId }],
      }))
    },
    [types, quickInput, notifications, updateType],
  )

  const removeTypeModel = useCallback(
    async (typeId: string, modelId: string) => {
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.removeModel.confirm', 'Remove model {model}?', {
          model: modelId,
        }),
        primaryButton: localize('aiModels.removeModel.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      await updateType(typeId, (type) => {
        const models = (type.models ?? []).filter((m) => m.id !== modelId)
        return { ...type, models }
      })
    },
    [dialog, updateType],
  )

  const removeType = useCallback(
    async (typeId: string) => {
      const bound = instances.filter((i) => i.type === typeId).length
      if (bound > 0) {
        notifications.notify({
          severity: Severity.Warning,
          message: localize(
            'aiModels.type.remove.bound',
            'Cannot remove: {count} provider instance(s) still bind to this type.',
            { count: bound },
          ),
        })
        return
      }
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.type.remove.confirm', 'Remove provider type {type}?', {
          type: typeId,
        }),
        primaryButton: localize('aiModels.type.remove.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      const next = { ...types }
      delete next[typeId]
      await updateTypesRecord(next)
    },
    [instances, notifications, dialog, types, updateTypesRecord],
  )

  const refreshTypePrices = useCallback(
    async (typeId: string) => {
      const targets = instances.filter((i) => i.type === typeId)
      console.debug(
        `aiModels: refresh prices for type ${typeId} across ${targets.length} instance(s)`,
      )
      for (const inst of targets) await aiModel.refreshRemote(providerKey(inst))
      await reload()
    },
    [aiModel, instances, reload],
  )

  // --- provider instance mutations ---------------------------------------

  const setInstanceBaseUrl = useCallback(
    async (key: string, baseUrl: string) => {
      await replaceInstance(key, (inst) => {
        if (baseUrl) return { ...inst, baseUrl }
        if (!('baseUrl' in inst)) return inst
        const next = { ...inst }
        delete (next as { baseUrl?: string }).baseUrl
        return next
      })
    },
    [replaceInstance],
  )

  const setInstanceApiKey = useCallback(
    async (inst: AiProviderInstance) => {
      const key = await quickInput.input({
        prompt: localize(
          'aiModels.apiKey.editPrompt',
          'Enter the API key for {name} (stored in plaintext in aiSettings.json).',
          { name: inst.label ?? inst.name },
        ),
        value: inst.apiKey ?? '',
        placeholder: 'sk-…',
        validateInput: (v) =>
          v.trim().length === 0
            ? localize('aiModels.apiKey.empty', 'The API key must not be empty.')
            : undefined,
      })
      const trimmed = key?.trim()
      if (trimmed === undefined) return
      await replaceInstance(providerKey(inst), (i) => ({ ...i, apiKey: trimmed }))
    },
    [quickInput, replaceInstance],
  )

  const clearInstanceApiKey = useCallback(
    async (inst: AiProviderInstance) => {
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.apiKey.clearConfirm', 'Clear the stored API key for {name}?', {
          name: inst.label ?? inst.name,
        }),
        primaryButton: localize('aiModels.apiKey.clearAction', 'Clear'),
        type: 'warning',
      })
      if (!confirmed) return
      await replaceInstance(providerKey(inst), (i) => {
        if (!('apiKey' in i)) return i
        const next = { ...i }
        delete (next as { apiKey?: string }).apiKey
        return next
      })
    },
    [dialog, replaceInstance],
  )

  const removeInstance = useCallback(
    async (inst: AiProviderInstance) => {
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.instance.remove.confirm', 'Remove provider {name}?', {
          name: inst.label ?? inst.name,
        }),
        primaryButton: localize('aiModels.instance.remove.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      const next = instances.filter((i) => providerKey(i) !== providerKey(inst))
      await updateInstances(next)
    },
    [dialog, instances, updateInstances],
  )

  const addInstanceModel = useCallback(
    async (inst: AiProviderInstance) => {
      const id = await quickInput.input({
        prompt: localize(
          'aiModels.addModel.id',
          'Model id the endpoint expects (e.g. qwen3-coder)',
        ),
        validateInput: (v) =>
          v.trim().length === 0
            ? localize('aiModels.addModel.idEmpty', 'Model id must not be empty.')
            : undefined,
      })
      const trimmedId = id?.trim()
      if (!trimmedId) return
      const existing = inst.models ?? []
      if (existing.some((m) => m.id === trimmedId)) {
        notifications.notify({
          severity: Severity.Warning,
          message: localize('aiModels.addModel.exists', 'That model is already declared.'),
        })
        return
      }
      await replaceInstance(providerKey(inst), (i) => ({
        ...i,
        models: [...(i.models ?? []), { id: trimmedId }],
      }))
    },
    [quickInput, notifications, replaceInstance],
  )

  const removeInstanceModel = useCallback(
    async (inst: AiProviderInstance, modelId: string) => {
      const bare = bareModelName(modelId, inst.type, inst.name)
      const { confirmed } = await dialog.confirm({
        message: localize('aiModels.removeModel.confirm', 'Remove model {model}?', {
          model: modelId,
        }),
        primaryButton: localize('aiModels.removeModel.remove', 'Remove'),
        type: 'warning',
      })
      if (!confirmed) return
      await replaceInstance(providerKey(inst), (i) => {
        const models = (i.models ?? []).filter((m) => m.id !== bare)
        const next: {
          name: string
          type: string
          label?: string
          baseUrl?: string
          apiKey?: string
          models?: readonly AiCustomModelConfig[]
          settings?: Readonly<Record<string, AiModelConfiguration>>
        } = { ...i }
        if (models.length > 0) next.models = models
        else delete next.models
        if (i.settings && modelId in i.settings) {
          const settings = { ...i.settings }
          delete settings[modelId]
          if (Object.keys(settings).length > 0) next.settings = settings
          else delete next.settings
        }
        return next
      })
    },
    [dialog, replaceInstance],
  )

  const openJson = useCallback(async () => {
    await aiModel.updateProviders(await aiModel.getProviders())
    const uri = await userData.getFileUri(UserDataFile.AiSettings)
    if (!uri) return
    const input = instantiation.createInstance(FileEditorInput, uri)
    void openInLockAwareGroup(editorGroups, input, { activate: true })
  }, [aiModel, editorGroups, instantiation, userData])

  const typeEntries = useMemo(() => Object.keys(types), [types])

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

      <Section
        title={localize('aiModels.section.types', 'Provider Types')}
        collapsed={collapsed[SECTION_TYPES] ?? false}
        onToggle={() => toggleCollapsed(SECTION_TYPES)}
      >
        <div className={styles['cards']}>
          {typeEntries.map((typeId) => {
            const type = types[typeId]
            if (!type) return null
            return (
              <ProviderTypeCard
                key={typeId}
                typeId={typeId}
                type={type}
                builtin={descriptorById.get(typeId)?.builtin ?? false}
                collapsed={collapsed[typeCollapseKey(typeId)] ?? false}
                onToggleCollapsed={() => toggleCollapsed(typeCollapseKey(typeId))}
                canRemove={!(descriptorById.get(typeId)?.builtin ?? false)}
                onRemove={() => void removeType(typeId)}
                onBaseUrlChange={(baseUrl) => void setTypeBaseUrl(typeId, baseUrl)}
                onModelPricingChange={(modelId, pricing) =>
                  void setTypeModelPricing(typeId, modelId, pricing)
                }
                onAddModel={() => void addTypeModel(typeId)}
                onRemoveModel={(modelId) => void removeTypeModel(typeId, modelId)}
                onRefreshPrices={() => void refreshTypePrices(typeId)}
              />
            )
          })}
        </div>
      </Section>

      <Section
        title={localize('aiModels.section.instances', 'Provider Instances')}
        collapsed={collapsed[SECTION_INSTANCES] ?? false}
        onToggle={() => toggleCollapsed(SECTION_INSTANCES)}
      >
        {instances.length === 0 ? (
          <div className={styles['emptyState']}>
            <div className={styles['emptyDesc']}>
              {localize(
                'aiModels.instances.empty',
                'No provider instances yet. Add one to connect an AI service.',
              )}
            </div>
            <Button onClick={() => setAddOpen(true)}>
              <Plus size={14} strokeWidth={2} className={styles['btnIcon']} />
              {localize('aiModels.addProvider', 'Add Provider')}
            </Button>
          </div>
        ) : (
          <div className={styles['cards']}>
            {instances.map((inst) => {
              const key = providerKey(inst)
              const instModels = models.filter(
                (m) => m.vendor === inst.type && m.groupName === inst.name,
              )
              return (
                <ProviderInstanceCard
                  key={key}
                  aiModel={aiModel}
                  instance={inst}
                  type={types[inst.type]}
                  models={instModels}
                  rateTables={rateTables}
                  reloadToken={reloadToken}
                  collapsed={collapsed[instanceCollapseKey(inst)] ?? false}
                  onToggleCollapsed={() => toggleCollapsed(instanceCollapseKey(inst))}
                  storage={storage}
                  filterStorageKey={filterKey(key)}
                  onBaseUrlChange={(baseUrl) => void setInstanceBaseUrl(key, baseUrl)}
                  onSetApiKey={() => void setInstanceApiKey(inst)}
                  onClearApiKey={() => void clearInstanceApiKey(inst)}
                  onRemove={() => void removeInstance(inst)}
                  onAddModel={() => void addInstanceModel(inst)}
                  onRemoveModel={(modelId) => void removeInstanceModel(inst, modelId)}
                  onConfigure={(modelId, config) =>
                    aiModel.setModelConfiguration(modelId, config).then(() => reload())
                  }
                  getConfiguration={(modelId) => aiModel.getModelConfiguration(modelId)}
                />
              )
            })}
          </div>
        )}
      </Section>

      {addOpen && (
        <AddProviderDialog
          existingInstances={instances}
          existingTypes={types}
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

function setModelPricing(
  model: AiCustomModelConfig,
  pricing: AiModelPricing | undefined,
): AiCustomModelConfig {
  if (pricing !== undefined) return { ...model, pricing }
  if (!('pricing' in model)) return model
  const next = { ...model }
  delete (next as { pricing?: AiModelPricing }).pricing
  return next
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
